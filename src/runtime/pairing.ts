// ═══════════════════════════════════════════════════════════════════════════
// R33 双库配对（§18.2 mesh_instance_tag 生产 + E3 校验）—— 角色侧协调
//
// 配对标识 P 由 role 生成并持久化（pairing_anchor 单行表），mesh 侧用锚点账号的
// profile_ref 承载同一 P。判据只两条：
//   1. 当前 mesh 库的锚点账号存在，且 profile_ref === P（当前 mesh 就是 P 配对的 mesh）；
//   2. 所有已注册映射（agents.mesh_account_id 非空）的 mesh_instance_tag === P。
// 成立才可读；缺锚点 / 标记不符 / mesh 被替换 → 整体拒绝（E3 / F5 / T4.7 / T6.10）。
//
// 本文件不 import @pi/agent-mesh；mesh 触达全部经 ../mesh/pairing.js（R1/R2）。
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { PAIRING_ANCHOR_DEFAULT_ID, readPairingAnchor } from "../mesh/pairing.js";
import { PairingError } from "./errors.js";

export interface PairingInfo {
  pairingId: string;
  anchorAccount: string;
}

/** 配对判定：established（可读）或 vacant（无映射且无锚点，首次启动/空库）。错库/缺锚点直接抛 PairingError。 */
export type PairingVerdict =
  | { state: "established"; pairing: PairingInfo }
  | { state: "vacant"; pairing: PairingInfo };

/** 读取单行配对记录（不存在则未配对）。 */
function readPairingRow(db: Database.Database): { pairing_id: string; anchor_account: string } | undefined {
  return db
    .prepare<[], { pairing_id: string; anchor_account: string }>(
      "SELECT pairing_id, anchor_account FROM pairing_anchor WHERE id = 1",
    )
    .get();
}

/**
 * 读取（缺则生成并持久化）配对标识。幂等：已有行原样返回；`anchorAccount` 只在**首次
 * 生成**时生效，之后改传不同值视为配置冲突（同一配对不得换锚点）。
 */
export function ensurePairingId(db: Database.Database, anchorAccount?: string): PairingInfo {
  const existing = readPairingRow(db);
  if (existing) {
    if (anchorAccount && anchorAccount !== existing.anchor_account) {
      throw new PairingError(
        `pairingAnchor conflict: persisted=${existing.anchor_account} requested=${anchorAccount}`,
      );
    }
    return { pairingId: existing.pairing_id, anchorAccount: existing.anchor_account };
  }
  const pairingId = randomUUID();
  const anchor = anchorAccount ?? PAIRING_ANCHOR_DEFAULT_ID;
  db.prepare("INSERT INTO pairing_anchor (id, pairing_id, anchor_account, created_at) VALUES (1, ?, ?, ?)").run(
    pairingId,
    anchor,
    new Date().toISOString(),
  );
  return { pairingId, anchorAccount: anchor };
}

/** 读 DB-A：是否有已注册映射（mesh_account_id 非空）与 tag 是否都与 P 一致。 */
function mappingTagCheck(
  db: Database.Database,
  pairingId: string,
): { hasMappings: boolean; mismatchedAgentIds: string[] } {
  const rows = db
    .prepare<[], { agent_id: string; mesh_instance_tag: string | null }>(
      "SELECT agent_id, mesh_instance_tag FROM agents WHERE mesh_account_id IS NOT NULL",
    )
    .all();
  const mismatched = rows.filter((r) => r.mesh_instance_tag !== pairingId).map((r) => r.agent_id);
  return { hasMappings: rows.length > 0, mismatchedAgentIds: mismatched };
}

/**
 * 共享判据（恢复 / 成本 / 悬挂扫描共用）。返回 established / vacant；错库或缺锚点抛
 * PairingError（不静默出数）。`anchorAccount` 仅在首次生成配对标识时有意义。
 */
export function evaluatePairing(
  db: Database.Database,
  meshDbPath: string,
  anchorAccount?: string,
): PairingVerdict {
  const pairing = ensurePairingId(db, anchorAccount);

  const { hasMappings, mismatchedAgentIds } = mappingTagCheck(db, pairing.pairingId);
  if (mismatchedAgentIds.length > 0) {
    throw new PairingError(
      `agents belong to a different mesh instance (mesh_instance_tag mismatch): ${mismatchedAgentIds.join(", ")}`,
    );
  }

  const anchor = readPairingAnchor(meshDbPath, pairing.anchorAccount);
  if (anchor.present) {
    if (anchor.profileRef !== pairing.pairingId) {
      throw new PairingError(
        `anchor ${pairing.anchorAccount} carries a different marker than the persisted pairing id`,
      );
    }
    return { state: "established", pairing };
  }

  // 缺锚点：有映射 ⇒ mesh 被替换（整体拒绝）；无映射 ⇒ 空库/首启，允许先建锚点再配对。
  if (hasMappings) {
    throw new PairingError(
      "no pairing anchor in the current mesh, but registered agent mappings exist — the mesh db was replaced",
    );
  }
  return { state: "vacant", pairing };
}