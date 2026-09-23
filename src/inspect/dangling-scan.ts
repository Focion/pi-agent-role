// ═══════════════════════════════════════════════════════════════════════════
// 悬挂引用两阶段离线扫描（§18.6，尤其是 §18.6.3）
//
// 记忆行里的 source_msg_id 是**裸引用**（无外键），mesh 删除消息不会级联清记忆，
// 悬挂只能靠离线两阶段核对发现：
//   · 第一阶段（DB-A，仅 episodes 表）：导出带锚点、处于核对窗内的记忆行快照。
//   · 第二阶段（mesh 侧，只读）：经 src/mesh/dangling-lookup 批量核对，存在集
//     之外即悬挂（collected − existing）。
//   · 第三阶段（写回 DB-A）：单事务——先落 state_writes 审计行（before_json 记
//     更新前置信度），再 UPDATE。只降 confidence、清 accuracy，**绝不碰 status**
//     悬挂是证据链问题，不是记忆的可见性问题。
//
// 分层纪律（§22.4 R1/R2）：本文件不 import `@pi/agent-mesh`，也不含 mesh_ 表名
// SQL；mesh 查询全部经 ../mesh/dangling-lookup 触达。
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import type Database from "better-sqlite3";

import { meshMessageIdsExist } from "../mesh/dangling-lookup.js";

/** 第一阶段从 episodes 读到的锚点快照（连写回所需的 owner 与置信度前置值一并取回）。 */
interface EpisodeAnchorRow {
  episode_id: string;
  source_msg_id: string;
  owner_agent: string;
  confidence: number;
  accuracy: number | null;
}

export interface DanglingScanResult {
  /** 带锚点、处于核对窗内的记忆行数。 */
  scanned: number;
  /** 源消息已不在 mesh 库的悬挂行（裸 msg_id，§18.6）。 */
  dangling: Array<{ episodeId: string; sourceMsgId: string }>;
  /** 实际写回 evidence_lost 的行数。 */
  marked: number;
  /** source_msg_id 为空的行数（不属于悬挂，§18.6.3）。 */
  skippedDueToMissingAnchors: number;
}

const DEFAULT_SINCE = "1970-01-01T00:00:00.000Z";
const DEFAULT_PENALTY = 0.1;
const CONFIDENCE_FLOOR = 0.05;

export function scanDanglingMessages(
  roleDb: Database.Database,
  meshDbPath: string,
  opts: { since?: string; confidencePenalty?: number } = {},
): DanglingScanResult {
  const since = opts.since ?? DEFAULT_SINCE;
  const penalty = opts.confidencePenalty ?? DEFAULT_PENALTY;

  // 第一阶段（DB-A，仅角色表）：带锚点、处于核对窗内的记忆行。
  const anchors = roleDb
    .prepare<{ since: string }, EpisodeAnchorRow>(
      `SELECT episode_id, source_msg_id, owner_agent, confidence, accuracy
         FROM episodes
        WHERE source_msg_id IS NOT NULL AND status = 'active' AND real_ts >= :since
        ORDER BY real_ts`,
    )
    .all({ since });

  // NULL 锚点不属于悬挂，单独计数（§18.6.3）。
  const skipped = (
    roleDb
      .prepare<{ since: string }, { c: number }>(
        `SELECT count(*) AS c
           FROM episodes
          WHERE source_msg_id IS NULL AND status = 'active' AND real_ts >= :since`,
      )
      .get({ since }) ?? { c: 0 }
  ).c;

  // B2 降级：mesh 库不存在 ⇒ 没有可核对的 mesh，「证据不可用」安全默认为无悬挂，不抛。
  if (!existsSync(meshDbPath)) {
    return {
      scanned: anchors.length,
      dangling: [],
      marked: 0,
      skippedDueToMissingAnchors: skipped,
    };
  }

  const collectedIds = anchors.map((r) => r.source_msg_id);
  const existing = new Set(meshMessageIdsExist(meshDbPath, collectedIds));
  const danglingRows = anchors.filter((r) => !existing.has(r.source_msg_id));

  if (danglingRows.length === 0) {
    return {
      scanned: anchors.length,
      dangling: [],
      marked: 0,
      skippedDueToMissingAnchors: skipped,
    };
  }

  const marked = writeBack(roleDb, danglingRows, penalty);

  return {
    scanned: anchors.length,
    dangling: danglingRows.map((r) => ({ episodeId: r.episode_id, sourceMsgId: r.source_msg_id })),
    marked,
    skippedDueToMissingAnchors: skipped,
  };
}

/**
 * 第三阶段：单事务写回。审计行先写（before_json 记更新前置信度），再 UPDATE。
 * 两个语句同覆盖全部悬挂行；只降 confidence（下限 0.05）与清 accuracy。
 */
function writeBack(
  roleDb: Database.Database,
  rows: EpisodeAnchorRow[],
  penalty: number,
): number {
  const insertAudit = roleDb.prepare<{
    write_id: string;
    owner_agent: string;
    target: string;
    target_id: string;
    op: string;
    reason: string;
    before_json: string;
    after_json: string;
    actor: string;
    real_ts: string;
  }>(
    `INSERT INTO state_writes
       (write_id, owner_agent, target, target_id, op, reason, before_json, after_json, actor, real_ts)
     VALUES
       (@write_id, @owner_agent, @target, @target_id, @op, @reason, @before_json, @after_json, @actor, @real_ts)`,
  );

  const episodeIds = rows.map((r) => r.episode_id);
  const placeholders = episodeIds.map(() => "?").join(", ");
  const updateEpisodes = roleDb.prepare<[number, ...string[]]>(
    `UPDATE episodes
        SET confidence = MAX(confidence - ?, ${CONFIDENCE_FLOOR}), accuracy = NULL
      WHERE episode_id IN (${placeholders})`,
  );

  const tx = roleDb.transaction(() => {
    const realTs = new Date().toISOString();
    for (const r of rows) {
      const nextConfidence = Math.max(r.confidence - penalty, CONFIDENCE_FLOOR);
      insertAudit.run({
        write_id: randomUUID(),
        owner_agent: r.owner_agent,
        target: "episode",
        target_id: r.episode_id,
        op: "evidence_lost",
        reason: "source_msg_missing",
        before_json: JSON.stringify({ confidence: r.confidence, accuracy: r.accuracy }),
        after_json: JSON.stringify({ confidence: nextConfidence, accuracy: null }),
        actor: "MemoryService",
        real_ts: realTs,
      });
    }
    return updateEpisodes.run(penalty, ...episodeIds).changes;
  });

  return tx();
}