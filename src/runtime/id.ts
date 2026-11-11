// ═══════════════════════════════════════════════════════════════════════════
// id 工具：本环自产的数据库主键（episode_id / reflection_id / write_id / …）
//
// mesh 的 id（账号/端点/会话/消息）由 mesh 用 ULID 签发；本环不得自造 mesh 侧 id。
// 本环自己的领域行主键用 crypto.randomUUID + 类型前缀，便于从 id 一眼看出表族。
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";

export type IdKind =
  | "ep" // episodes
  | "kn" // knowledge_items
  | "ke" // knowledge_events
  | "rf" // reflections
  | "sw" // state_writes
  | "rl" // retrieval_log
  | "be" // boundary_events
  | "fr" // facility_records
  | "sp" // subject_profiles（不独立主键，此处留用）
  | "pt" // pending_taught（§17.2 Q05 双证据中转台账）
  | "ag"; // agents（无 prefix 需求时兜底）

/** 生成带前缀的领域主键，如 `ep_<uuid>`。 */
export function newId(kind: IdKind = "ag"): string {
  return `${kind}_${randomUUID()}`;
}

/** 生成 UUID（无前缀），给需要原文形态的调用方。 */
export function uuid(): string {
  return randomUUID();
}