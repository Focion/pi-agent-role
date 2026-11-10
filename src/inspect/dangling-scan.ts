// ═══════════════════════════════════════════════════════════════════════════
// 悬挂引用两阶段离线扫描（§18.6.3，R32）
//
// 记忆/知识/检索/自省行里的裸 msg_id（无外键）跨库指向 mesh 消息；mesh 删除消息
// 不会级联清这些引用，悬挂只能靠离线两阶段核对发现：
//   · 第一阶段（DB-A）：导出四类锚点行快照——episodes.source_msg_id、
//     knowledge_items.source_msg_id、retrieval_log.trigger_msg_id、
//     reflections.reflect_msg_id / result_msg_id（§18.6.3 末尾的同类检测清单）。
//   · 第二阶段（mesh 侧，只读）：经 src/mesh/dangling-lookup 批量核对，存在集之外即悬挂。
//   · 第三阶段（写回 DB-A）：单事务——先落 state_writes 审计行（before_json 记更新前
//     置信度），再 UPDATE。有 confidence 列的（episode/knowledge）降 confidence、episode
//     额外清 accuracy；retrieval/reflection 只审计不更新；**绝不碰 status / mastery**
//     ——悬挂是证据链问题，不是记忆可见性或状态机问题。
//
// 分类（R32「缺失/裁剪/不可见/换库」）落在三处：
//   · 换库：evaluatePairing 检测 mesh_instance_tag / 配对锚点不匹配时抛 PairingError
//     （不静默出数、不逐条误判成「消息被删」）；无映射且无锚点（vacant）安全默认为无悬挂。
//   · 不可见：不是悬挂——本扫描走直连只读 mesh_messages，不受「按 to 过滤」影响；
//     可见性属于展示层（observer.messages），本审计不做可见性裁定（§18.6.3）。
//   · 缺失（真悬挂）：mesh_messages 里物理不存在 → 按下述副作用处置。保留期内/外的
//     细分需消息 routed_at 与 mesh 保留期，消息删后不可得，本扫描不区分，统一按
//     「证据不可核验」降级（与 §18.6.3 的处置表一致，见设计 8846）。
//
// 分层纪律（§22.4 R1/R2）：本文件不 import `@pi/agent-mesh`，也不含 mesh_ 表名 SQL；
// mesh 查询全部经 ../mesh/dangling-lookup 触达。表名/列名只来自下方固定规范数组，非用户输入。
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { meshMessageIdsExist } from "../mesh/dangling-lookup.js";
import { evaluatePairing } from "../runtime/pairing.js";

export type DanglingAnchorKind = "episode" | "knowledge" | "retrieval" | "reflection";

/** 一条悬挂锚点：某派生的裸 msg_id 已不在 mesh 库中。 */
export interface DanglingAnchor {
  kind: DanglingAnchorKind;
  /** 本环目标行主键：episode_id / kn_id / retrieval_id / reflection_id。 */
  targetId: string;
  /** 悬挂的裸引用列名：source_msg_id / trigger_msg_id / reflect_msg_id / result_msg_id。 */
  column: string;
  /** 悬挂的 msg_id 值。 */
  anchorId: string;
  ownerAgent: string;
}

export interface DanglingScanResult {
  /** 带锚点、处于核对窗内的引用数（四类合计，逐锚点列计）。 */
  scanned: number;
  /** 分类后的悬挂锚点。 */
  dangling: DanglingAnchor[];
  /** 按类别计数的悬挂数。 */
  byKind: Record<DanglingAnchorKind, number>;
  /** 实际下调 confidence / 清 accuracy 的行数（episode + knowledge）。 */
  marked: number;
  /** 写入 state_writes（evidence_lost）的审计行数（每一条悬挂锚点一条）。 */
  audited: number;
  /** 锚点列为 NULL 的行数（no_anchor，不是悬挂，§18.6.3）。 */
  skippedNoAnchor: number;
}

const DEFAULT_SINCE = "1970-01-01T00:00:00.000Z";
const DEFAULT_PENALTY = 0.1;
const CONFIDENCE_FLOOR = 0.05;

const ZERO_KINDS: Record<DanglingAnchorKind, number> = {
  episode: 0,
  knowledge: 0,
  retrieval: 0,
  reflection: 0,
};

/** 四类锚点规范（§18.6.3 同类检测清单）。表名/列名固定，不来自用户输入。 */
interface AnchorSpec {
  kind: DanglingAnchorKind;
  table: string;
  pk: string;
  anchor: string;
  sinceColumn: string;
  /** 额外 WHERE（如状态过滤；无则 "1=1"）。 */
  guard: string;
  /** 有 confidence 列 → 悬挂时下调。 */
  confidence: boolean;
  /** 有 accuracy 列 → 悬挂时清空（仅 episodes）。 */
  accuracy: boolean;
}

const ANCHOR_SPECS: AnchorSpec[] = [
  { kind: "episode", table: "episodes", pk: "episode_id", anchor: "source_msg_id", sinceColumn: "real_ts", guard: "status = 'active'", confidence: true, accuracy: true },
  { kind: "knowledge", table: "knowledge_items", pk: "kn_id", anchor: "source_msg_id", sinceColumn: "first_seen_at", guard: "1=1", confidence: true, accuracy: false },
  { kind: "retrieval", table: "retrieval_log", pk: "retrieval_id", anchor: "trigger_msg_id", sinceColumn: "real_ts", guard: "1=1", confidence: false, accuracy: false },
  { kind: "reflection", table: "reflections", pk: "reflection_id", anchor: "reflect_msg_id", sinceColumn: "started_at", guard: "1=1", confidence: false, accuracy: false },
  { kind: "reflection", table: "reflections", pk: "reflection_id", anchor: "result_msg_id", sinceColumn: "started_at", guard: "1=1", confidence: false, accuracy: false },
];

/** 第一阶段读到的锚点快照（连写回所需的 owner 与前置置信度/准确度一并取回）。 */
interface AnchorRef {
  kind: DanglingAnchorKind;
  targetId: string;
  column: string;
  anchorId: string;
  ownerAgent: string;
  confidence: number | null;
  accuracy: number | null;
}

function collectRefs(roleDb: Database.Database, since: string, spec: AnchorSpec): AnchorRef[] {
  const cols = [spec.pk, spec.anchor, "owner_agent"];
  if (spec.confidence) cols.push("confidence");
  if (spec.accuracy) cols.push("accuracy");
  const rows = roleDb
    .prepare(
      `SELECT ${cols.join(", ")}
         FROM ${spec.table}
        WHERE ${spec.anchor} IS NOT NULL AND ${spec.guard} AND ${spec.sinceColumn} >= :since
        ORDER BY ${spec.sinceColumn}`,
    )
    .all({ since }) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    kind: spec.kind,
    targetId: String(row[spec.pk]),
    column: spec.anchor,
    anchorId: String(row[spec.anchor]),
    ownerAgent: String(row["owner_agent"]),
    confidence: spec.confidence ? (row["confidence"] as number) : null,
    accuracy: spec.accuracy ? ((row["accuracy"] as number) ?? null) : null,
  }));
}

function countNoAnchor(roleDb: Database.Database, since: string, spec: AnchorSpec): number {
  const row = roleDb
    .prepare(
      `SELECT count(*) AS c
         FROM ${spec.table}
        WHERE ${spec.anchor} IS NULL AND ${spec.guard} AND ${spec.sinceColumn} >= :since`,
    )
    .get({ since }) as { c?: number } | undefined;
  return row?.c ?? 0;
}

export function scanDanglingMessages(
  roleDb: Database.Database,
  meshDbPath: string,
  opts: { since?: string; confidencePenalty?: number } = {},
): DanglingScanResult {
  const since = opts.since ?? DEFAULT_SINCE;
  const penalty = opts.confidencePenalty ?? DEFAULT_PENALTY;

  // 第一阶段（DB-A）：四类锚点全量导出 + NULL 锚点计数。
  const allRefs = ANCHOR_SPECS.flatMap((spec) => collectRefs(roleDb, since, spec));
  let skippedNoAnchor = 0;
  for (const spec of ANCHOR_SPECS) skippedNoAnchor += countNoAnchor(roleDb, since, spec);

  // R33（E3）：配对判据——错库/缺锚点抛 PairingError（不静默出数）；无映射且无锚点
  // （vacant）时按「证据不可用」安全默认为无悬挂，不逐条误判成「消息被删」。
  const pairing = evaluatePairing(roleDb, meshDbPath);
  if (pairing.state === "vacant") {
    return {
      scanned: allRefs.length,
      dangling: [],
      byKind: { ...ZERO_KINDS },
      marked: 0,
      audited: 0,
      skippedNoAnchor,
    };
  }

  // 第二阶段（mesh 只读，分批）：收集 id 集合 → 核对存在集 → 差集即悬挂。
  const existing = new Set(meshMessageIdsExist(meshDbPath, allRefs.map((r) => r.anchorId)));
  const danglingRefs = allRefs.filter((r) => !existing.has(r.anchorId));

  const byKind = { ...ZERO_KINDS };
  for (const r of danglingRefs) byKind[r.kind] += 1;

  if (danglingRefs.length === 0) {
    return {
      scanned: allRefs.length,
      dangling: [],
      byKind,
      marked: 0,
      audited: 0,
      skippedNoAnchor,
    };
  }

  const { marked, audited } = writeBack(roleDb, danglingRefs, penalty);

  return {
    scanned: allRefs.length,
    dangling: danglingRefs.map((r) => ({
      kind: r.kind,
      targetId: r.targetId,
      column: r.column,
      anchorId: r.anchorId,
      ownerAgent: r.ownerAgent,
    })),
    byKind,
    marked,
    audited,
    skippedNoAnchor,
  };
}

function auditPayload(r: AnchorRef, lowered: number | null): { before: string; after: string } {
  if (r.kind === "episode") {
    return {
      before: JSON.stringify({ confidence: r.confidence, accuracy: r.accuracy }),
      after: JSON.stringify({ confidence: lowered, accuracy: null }),
    };
  }
  if (r.kind === "knowledge") {
    return {
      before: JSON.stringify({ confidence: r.confidence }),
      after: JSON.stringify({ confidence: lowered }),
    };
  }
  // retrieval / reflection：无 confidence/accuracy 可改，审计里记录悬挂的列与锚点值。
  return {
    before: JSON.stringify({ [r.column]: r.anchorId }),
    after: JSON.stringify({}),
  };
}

/**
 * 第三阶段：单事务写回。先写 state_writes（before_json 记更新前置信度），再 UPDATE。
 * 只降 confidence（下限 0.05）与清 accuracy；retrieval/reflection 只审计，**绝不碰 status/mastery**。
 */
function writeBack(
  roleDb: Database.Database,
  refs: AnchorRef[],
  penalty: number,
): { marked: number; audited: number } {
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

  const tx = roleDb.transaction(() => {
    const realTs = new Date().toISOString();
    for (const r of refs) {
      const lowered = r.confidence !== null ? Math.max(r.confidence - penalty, CONFIDENCE_FLOOR) : null;
      const { before, after } = auditPayload(r, lowered);
      insertAudit.run({
        write_id: randomUUID(),
        owner_agent: r.ownerAgent,
        target: r.kind,
        target_id: r.targetId,
        op: "evidence_lost",
        reason: "source_msg_missing",
        before_json: before,
        after_json: after,
        actor: "MemoryService",
        real_ts: realTs,
      });
    }

    const marked =
      applyConfidence(roleDb, "episodes", "episode_id", refs.filter((r) => r.kind === "episode"), penalty, true) +
      applyConfidence(roleDb, "knowledge_items", "kn_id", refs.filter((r) => r.kind === "knowledge"), penalty, false);

    return { marked, audited: refs.length };
  });

  return tx();
}

function applyConfidence(
  roleDb: Database.Database,
  table: string,
  pk: string,
  refs: AnchorRef[],
  penalty: number,
  clearAccuracy: boolean,
): number {
  if (refs.length === 0) return 0;
  const ids = [...new Set(refs.map((r) => r.targetId))];
  const placeholders = ids.map(() => "?").join(", ");
  const setClause = clearAccuracy
    ? `confidence = MAX(confidence - ?, ${CONFIDENCE_FLOOR}), accuracy = NULL`
    : `confidence = MAX(confidence - ?, ${CONFIDENCE_FLOOR})`;
  return roleDb
    .prepare<[number, ...string[]]>(`UPDATE ${table} SET ${setClause} WHERE ${pk} IN (${placeholders})`)
    .run(penalty, ...ids).changes;
}