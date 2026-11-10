// ═══════════════════════════════════════════════════════════════════════════
// 边界审计（R11 / §18.4.4）—— 把 mesh 拒绝写成 boundary_events
//
// mesh 库对「非法主动发起」的拒绝（附录 D reject 十项，如设施 initiate:[] 却发 chat →
// CANNOT_INITIATE）不落任何 delivery（§3.2 闸②直接拒），这是 mesh 侧可观察的空洞。
// 本模块补上本环的半边审计：每发生一次这样的拒绝，在 DB-A 的 boundary_events 里写
// **恰好一条**事实行（同一 tool_call 一次拒绝一次审计），reason_code 严格取自附录 D
// 十项，不自造码；工具层错误码（ARG_INVALID 等）**不**是拒绝，绝不落表。
//
// 「与 R31 共用一套 owner/拒绝设计」：拦截点与 R31 的内部健康哨兵同源——都是 mesh 在
// 受理期把主动发起挡下的地方；owner 分区键 = 发起账号反查到的 agentId，分区纪律与
// A1 一致。runtime 装配一个闭包（拿 db + registry），SessionFactory 的 mesh_send 装饰器
// 在结果里抽出拒绝码后回调它；本文件只写库、不 import @pi/agent-mesh。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import type { RoleAccountRegistry } from "../mesh/accounts.js";
import type { BoundaryReject } from "../mesh/session-factory.js";
import { newId } from "./id.js";

export interface BoundaryAuditDeps {
  db: Database.Database;
  /** accountId → agentId/agentType 反查（分区键与 actor_kind 的来源）。 */
  registry: RoleAccountRegistry;
  now?: () => string;
}

/** 写入一条 boundary_events（幂等性由「一次拒绝一次回调」保证，本函数不加去重）。 */
export function writeBoundaryEvent(
  db: Database.Database,
  e: {
    eventId: string;
    ownerAgent: string;
    actorAccountId: string;
    actorKind: string;
    reasonCode: string;
    toolCallId: string;
    sceneId?: string;
    virtualTs?: string;
    attemptedKind?: string;
    detailJson?: string;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO boundary_events
       (event_id, owner_agent, actor_account_id, actor_kind, conversation_id, scene_id,
        attempted_kind, reason_code, tool_call_id, virtual_ts, real_ts, detail_json)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.eventId,
    e.ownerAgent,
    e.actorAccountId,
    e.actorKind,
    e.sceneId ?? null,
    e.attemptedKind ?? null,
    e.reasonCode,
    e.toolCallId,
    e.virtualTs ?? null,
    e.now,
    e.detailJson ?? null,
  );
}

/** 装配边界审计闭包：SessionFactory 装饰器回调 → boundary_events 一行。 */
export function makeBoundaryAudit(deps: BoundaryAuditDeps): (e: BoundaryReject) => void {
  return (e) => {
    const rec = deps.registry.byAccountId(e.accountId);
    // 未注册账号（无 owner 可归属）不落审计——A1 要求 owner_agent 引用真实 agent 行。
    if (!rec) return;
    const now = (deps.now ?? (() => new Date().toISOString()))();
    writeBoundaryEvent(deps.db, {
      eventId: newId("be"),
      ownerAgent: rec.agentId,
      actorAccountId: e.accountId,
      actorKind: rec.agentType,
      reasonCode: e.reasonCode,
      toolCallId: e.toolCallId,
      sceneId: e.sceneId,
      virtualTs: e.virtualTs,
      attemptedKind: e.attemptedKind,
      detailJson: e.message ? JSON.stringify({ message: e.message }) : undefined,
      now,
    });
  };
}