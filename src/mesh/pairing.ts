// ═══════════════════════════════════════════════════════════════════════════
// R33 双库配对锚点（§18.2 mesh_instance_tag 生产 + E3 校验的 mesh 侧触达）
//
// role 生成配对 id 与 mesh 库之间只靠一个账号锚点关联：锚点账号的 id 是约定值
// （默认 `role:pairing`，宿主可用 RuntimeOptions.pairingAnchor 覆盖），profile_ref
// 写配对 id（mesh 只存不解释）。读回时**核对完整 id + 完整标记**，不把 `lookup` 的
// 模糊 LIKE 命中当配对成立（计划 2026-11-02 R33 方案）。
//
// 本文件落位 src/mesh/**，是唯一允许直接触达 mesh 表名/公开账号 API 的地方：
//   · readPairingAnchor    —— 只读核对（readonly + fileMustExist，与 cost/dangling-lookup 同手法）
//   · establishPairingAnchor —— 经公开 registerAccount 建立（不写 mesh schema）
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync } from "node:fs";

import Database from "better-sqlite3";

import type { MeshHost } from "@pi/agent-mesh/core";

/** 缺省锚点账号 id：本环保留名。宿主可经 RuntimeOptions.pairingAnchor 覆盖（§R33）。 */
export const PAIRING_ANCHOR_DEFAULT_ID = "role:pairing";

/** 只读核对结果：锚点账号是否存在，及它承载的配对标记。 */
export interface PairingAnchorSnapshot {
  present: boolean;
  profileRef?: string;
}

/**
 * 只读核对：mesh 库里锚点账号是否存在，并读回 profile_ref。
 * 打开 mesh.db 只读连接（readonly + fileMustExist）。mesh 库缺失 / 没有 mesh_accounts
 * 表 / 无该账号，一律归一为 `{ present: false }`（缺锚点，由调用方按「有映射则拒绝」判）。
 */
export function readPairingAnchor(meshDbPath: string, anchorAccountId: string): PairingAnchorSnapshot {
  if (!existsSync(meshDbPath)) return { present: false };
  const db = new Database(meshDbPath, { readonly: true, fileMustExist: true });
  try {
    const has = db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mesh_accounts'",
      )
      .get() ?? { n: 0 };
    if (has.n === 0) return { present: false };
    const row = db
      .prepare<[string], { profile_ref: string | null }>("SELECT profile_ref FROM mesh_accounts WHERE id = ?")
      .get(anchorAccountId) as { profile_ref: string | null } | undefined;
    if (!row) return { present: false };
    return { present: true, profileRef: row.profile_ref ?? undefined };
  } finally {
    db.close();
  }
}

/**
 * 经公开 registerAccount 建立锚点账号（不写 mesh schema）。幂等：`lookup` 命中**完整 id**
 * 且 profileRef 匹配时视为已建立；只命中模糊 LIKE 不当作成立，继续走注册。
 */
export async function establishPairingAnchor(
  mesh: MeshHost,
  anchorAccountId: string,
  pairingId: string,
): Promise<{ accountId: string }> {
  const found = await mesh.lookup({ query: anchorAccountId, limit: 100 });
  const exact = found.find((a) => a.id === anchorAccountId);
  if (exact) {
    if (exact.profileRef !== pairingId) {
      throw new Error(
        `pairing anchor ${anchorAccountId} exists with a different marker (${exact.profileRef ?? "none"})`,
      );
    }
    return { accountId: exact.id };
  }
  const account = await mesh.registerAccount({
    id: anchorAccountId,
    displayName: "Role pairing anchor",
    endpointClass: "stream",
    capabilities: [],
    initiate: [],
    defaultGrade: "steer",
    profileRef: pairingId,
  });
  return { accountId: account.id };
}