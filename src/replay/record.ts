// ═══════════════════════════════════════════════════════════════════════════
// 记录回放（H03/R37 ①）：只读当时保存的逐轮/空轮领域决策 + 检索快照
//
// · 判定行读 memory_decisions（components_json 缺失/损坏 → fidelity 降级）；
// · 检索行读 retrieval_log（card_sha256 与 rendered_card 核验 → integrity）；
// · 指纹读 agents（spec_hash / blueprint_hash / model_config_json）——是「当前指纹」
//   而非历史重建，缺失显式标记，绝不用当前配置伪造历史。
//
// 分层纪律：本文件属观察领域，直接读 role 库（DB-A）；不 import @pi/agent-mesh、
// 不出现 mesh_ 表名、不触碰环境扩展字段（RoleExt 经 mesh 域取，本文件不直接访问）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import { modelConfigHashFromJson, sha256Hex } from "../compile/fingerprint.js";
import type {
  AgentFingerprint,
  DomainDecisionRecord,
  DomainDecisionReplay,
  ReplayMemoryCounts,
  ReplayRecordOptions,
  RetrievalRecord,
} from "./types.js";

const DEFAULT_SINCE = "1970-01-01T00:00:00.000Z";
const DEFAULT_UNTIL = "9999-12-31T23:59:59.000Z";
const DEFAULT_MAX_ITEMS = 1000;

interface DecisionRow {
  source_msg_id: string;
  path: "P1" | "P2" | "P3";
  score: number;
  write_decided: number;
  written: number;
  nudged: number;
  components_json: string | null;
  virtual_ts: string;
  decided_at: string;
}

interface RetrievalRow {
  retrieval_id: string;
  scene_id: string | null;
  turn: number | null;
  trigger_msg_id: string | null;
  query_json: string | null;
  candidates: number;
  selected_json: string | null;
  tokens_l2: number;
  tokens_l1: number;
  tokens_transient: number;
  tokens_total: number;
  clamped: number;
  rendered_card: string | null;
  card_sha256: string | null;
  model_config_hash: string | null;
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function parseComponents(json: string | null): { components: Record<string, unknown> | null; fidelity: "full" | "components_missing" } {
  if (!json) return { components: null, fidelity: "components_missing" };
  const parsed = parseJson<Record<string, unknown>>(json);
  if (parsed === null || typeof parsed !== "object") return { components: null, fidelity: "components_missing" };
  return { components: parsed, fidelity: "full" };
}

function selectedIdsOf(json: string | null): string[] {
  const parsed = parseJson<unknown>(json);
  if (Array.isArray(parsed)) {
    return parsed
      .map((x) => (typeof x === "string" ? x : (x as { episode_id?: unknown })?.episode_id))
      .filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  return [];
}

/** 按 owner + scene/time 窗读判定与检索快照，输出一条回放。 */
export function readDomainDecisionReplay(
  db: Database.Database,
  ownerAgent: string,
  opts: ReplayRecordOptions = {},
): DomainDecisionReplay {
  const since = opts.since ?? DEFAULT_SINCE;
  const until = opts.until ?? DEFAULT_UNTIL;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const missing: string[] = [];

  // ── 指纹（当前，非历史重建）──────────────────────────────────────────────
  const agentRow = db
    .prepare<[string], { spec_hash: string | null; blueprint_hash: string | null; model_config_json: string | null }>(
      `SELECT spec_hash, blueprint_hash, model_config_json FROM agents WHERE agent_id = ?`,
    )
    .get(ownerAgent);
  const fingerprint: AgentFingerprint = {
    specHash: agentRow?.spec_hash ?? null,
    blueprintHash: agentRow?.blueprint_hash ?? null,
    modelConfigHash: modelConfigHashFromJson(agentRow?.model_config_json ?? null),
  };
  if (!agentRow) missing.push("agent_row_missing");
  if (fingerprint.specHash === null) missing.push("spec_hash_missing");
  if (fingerprint.blueprintHash === null) missing.push("blueprint_hash_missing");
  if (fingerprint.modelConfigHash === null) missing.push("model_config_hash_missing");

  // ── 逐轮/空轮判定快照 ────────────────────────────────────────────────────
  const decisionStmt = db.prepare<[string, string, string, number], DecisionRow>(
    `SELECT source_msg_id, path, score, write_decided, written, nudged,
            components_json, virtual_ts, decided_at
       FROM memory_decisions
      WHERE owner_agent = ? AND decided_at >= ? AND decided_at <= ?
      ORDER BY decided_at ASC
      LIMIT ?`,
  );
  const decisionRows = decisionStmt.all(ownerAgent, since, until, maxItems);
  const turns: DomainDecisionRecord[] = decisionRows.map((r) => {
    const c = parseComponents(r.components_json);
    if (c.fidelity === "components_missing") missing.push(`components_missing:${r.source_msg_id}`);
    return {
      ownerAgent,
      sourceMsgId: r.source_msg_id,
      path: r.path,
      score: r.score,
      writeDecided: r.write_decided !== 0,
      written: r.written !== 0,
      nudged: r.nudged !== 0,
      virtualTs: r.virtual_ts,
      decidedAt: r.decided_at,
      components: c.components,
      fidelity: c.fidelity,
    };
  });

  // ── 检索快照（含卡片完整性核验）─────────────────────────────────────────
  const sceneClause = opts.sceneId ? " AND scene_id = ?" : "";
  const baseParams: Array<string | number> = [ownerAgent, since, until];
  if (opts.sceneId) baseParams.push(opts.sceneId);
  baseParams.push(maxItems);
  const retrievalStmt = db.prepare(
    `SELECT retrieval_id, scene_id, turn, trigger_msg_id, query_json, candidates,
            selected_json, tokens_l2, tokens_l1, tokens_transient, tokens_total, clamped,
            rendered_card, card_sha256, model_config_hash
       FROM retrieval_log
      WHERE owner_agent = ? AND real_ts >= ? AND real_ts <= ?${sceneClause}
      ORDER BY real_ts ASC
      LIMIT ?`,
  );
  const retrievalRows = retrievalStmt.all(...baseParams) as unknown as RetrievalRow[];

  const retrievals: RetrievalRecord[] = retrievalRows.map((r) => {
    let integrity: RetrievalRecord["integrity"];
    const recomputed = r.rendered_card !== null && r.rendered_card !== undefined ? sha256Hex(r.rendered_card) : null;
    if (r.rendered_card === null || r.rendered_card === undefined) {
      integrity = "missing_card";
      missing.push(`card_missing:${r.retrieval_id}`);
    } else if (r.card_sha256 !== null && r.card_sha256 !== recomputed) {
      integrity = "hash_mismatch";
      missing.push(`card_hash_mismatch:${r.retrieval_id}`);
    } else {
      integrity = "ok";
    }
    return {
      retrievalId: r.retrieval_id,
      sceneId: r.scene_id,
      turn: r.turn,
      triggerMsgId: r.trigger_msg_id,
      query: parseJson<unknown>(r.query_json),
      candidates: r.candidates,
      selectedIds: selectedIdsOf(r.selected_json),
      tokens: { l2: r.tokens_l2, l1: r.tokens_l1, transient: r.tokens_transient, total: r.tokens_total },
      clamped: r.clamped,
      modelConfigHash: r.model_config_hash,
      renderedCardSha256: r.card_sha256,
      integrity,
    };
  });

  // ── 记忆/知识/自省计数（单 owner）────────────────────────────────────────
  const count = (table: string): number => {
    const row = db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_agent = ?`).get(ownerAgent);
    return row?.n ?? 0;
  };
  const memory: ReplayMemoryCounts = {
    episodes: count("episodes"),
    subjects: count("subject_profiles"),
    knowledgeItems: count("knowledge_items"),
    reflections: count("reflections"),
  };

  return {
    source: "recorded",
    ownerAgent,
    fingerprint,
    span: { since: opts.since ?? null, until: opts.until ?? null },
    turns,
    retrievals,
    memory,
    cost: null, // 记录回放无权威用量（需 mesh 计数器/真实模型）；不占位为 0。
    missing: [...new Set(missing)],
  };
}