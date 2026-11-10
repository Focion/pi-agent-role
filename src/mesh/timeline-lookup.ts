// ═══════════════════════════════════════════════════════════════════════════
// 时间线证据回查（§20.3.1 / §18.6.2）
//
// 从 DB-B（mesh）只读批量回查消息原文与投递结果，供 MemoryTimeline 使用。
// 单次批量查询，不是逐条回查。
//
// 分层纪律（§22.4 R1/R2）：本文件是 mesh_ 表名 SQL 的合法存放处（src/mesh/ 下）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync } from "node:fs";

import Database from "better-sqlite3";

import type { TimelineEvidence } from "../observe/types.js";

interface MeshMessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  from_account: string;
  kind: string;
  text: string;
  routed_at: string;
}

interface MeshDeliveryRow {
  message_id: string;
  grade: string | null;
  path: string | null;
  woke: number;
  state: string;
  drop_reason: string | null;
  parked_reason: string | null;
}

/**
 * 批量回查：给定一组 sourceMsgId 和 agent 的 accountId，
 * 返回 Map<sourceMsgId, TimelineEvidence>。
 *
 * 回查不到的 key 不在 Map 中出现（调用方据此判定 L1/L2 降级）。
 *
 * @param meshDbPath mesh 库路径
 * @param msgIds 要回查的消息 id 集合
 * @param accountId 本 Agent 的 mesh accountId（用于匹配投递行）
 */
export function meshTimelineEvidence(
  meshDbPath: string,
  msgIds: string[],
  accountId: string,
): Map<string, TimelineEvidence> {
  const result = new Map<string, TimelineEvidence>();
  if (msgIds.length === 0 || !existsSync(meshDbPath)) return result;

  const db = new Database(meshDbPath, { readonly: true, fileMustExist: true });
  try {
    // 批量取消息
    const placeholders = msgIds.map(() => "?").join(",");
    const messages = db
      .prepare<unknown[], MeshMessageRow>(
        `SELECT id, conversation_id, seq, from_account, kind,
                COALESCE(json_extract(payload, '$.text'), '') AS text,
                routed_at
           FROM mesh_messages
          WHERE id IN (${placeholders})`,
      )
      .all(...msgIds);

    const foundIds = messages.map((m) => m.id);

    // 批量取本 Agent 的投递行
    let deliveriesByMsg = new Map<string, MeshDeliveryRow>();
    if (foundIds.length > 0) {
      const dPlaceholders = foundIds.map(() => "?").join(",");
      const deliveries = db
        .prepare<unknown[], MeshDeliveryRow>(
          `SELECT message_id, grade, path, woke, state, drop_reason, parked_reason
             FROM mesh_deliveries
            WHERE message_id IN (${dPlaceholders}) AND account_id = ?`,
        )
        .all(...foundIds, accountId);
      for (const d of deliveries) {
        deliveriesByMsg.set(d.message_id, d);
      }
    }

    for (const m of messages) {
      const d = deliveriesByMsg.get(m.id);
      // R36：角色展示只看「本人发 / 本人收」。定向他人且非本人发出的消息，其原文对
      // 本角色不可见——不纳入结果（调用方据此降级 L1/L2 且不暴露 text）。「无投递行
      // 不直接等于无权」：本人发出的消息没有投递给自己，仍属可见；「也不直接返回 L0」：
      // 既非发件人亦无投递行的消息不因存在于 mesh_messages 就升 L0。管理审计的
      // 全量核对走 dangling-scan，不走本展示路径。
      const selfSent = m.from_account === accountId;
      if (!selfSent && !d) continue;
      result.set(m.id, {
        conversationId: m.conversation_id,
        seq: m.seq,
        fromAccount: m.from_account,
        kind: m.kind,
        routedAt: m.routed_at,
        text: m.text,
        delivery: d
          ? {
              grade: d.grade,
              path: d.path,
              woke: d.woke === 1,
              state: d.state,
              dropReason: d.drop_reason,
              parkedReason: d.parked_reason,
            }
          : null,
      });
    }
  } finally {
    db.close();
  }

  return result;
}