// R33 双库配对——测试用最小替身。
//
// 真实运行时走 createRuntime → evaluatePairing → establishPairingAnchor（公开 registerAccount）。
// 这里为「直连 openRoleDb + 最小 mesh 替身」的测试补同一契约：DB-A 装单行配对并给已插入的
// agents 补 mesh_instance_tag；最小 mesh 替身里加 mesh_accounts + 锚点行（真实 createMesh 会自建）。
// 非测试文件不 import（不属 src，check:imports 只扫 src/）。
import type Database from "better-sqlite3";

export const TEST_PAIRING_ID = "p-pairing-test";
export const TEST_ANCHOR = "role:pairing";

/** DB-A：插入单行配对（幂等）并把现有 agents 映射的 mesh_instance_tag 补成配对 id。 */
export function installRolePairing(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO pairing_anchor (id, pairing_id, anchor_account, created_at)
     VALUES (1, ?, ?, ?)`,
  ).run(TEST_PAIRING_ID, TEST_ANCHOR, "2026-01-01T00:00:00.000Z");
  db.prepare("UPDATE agents SET mesh_instance_tag = ?").run(TEST_PAIRING_ID);
}

/** 最小 mesh 替身：补 mesh_accounts 表 + 锚点行（只放 readPairingAnchor 需要的两列）。 */
export function addMeshAnchor(meshDb: Database.Database): void {
  meshDb.exec("CREATE TABLE IF NOT EXISTS mesh_accounts (id TEXT PRIMARY KEY, profile_ref TEXT)");
  meshDb
    .prepare("INSERT OR IGNORE INTO mesh_accounts (id, profile_ref) VALUES (?, ?)")
    .run(TEST_ANCHOR, TEST_PAIRING_ID);
}