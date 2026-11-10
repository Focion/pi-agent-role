// ═══════════════════════════════════════════════════════════════════════════
// R33 双库配对锚点（§18.2 mesh_instance_tag 生产 + E3 校验）
//
// 覆盖：
//   R33-1  首启生成配对标识并在 mesh 建立锚点账号；重开稳定不变、锚点回读成立；
//   R33-2  宿主配对锚点账号覆盖；重开改传不同锚点拒绝（配置冲突）；
//   R33-3  错库：有映射但 mesh 锚点标记不符 → 拒绝出数（成本重算抛 PairingError）；
//   R33-4  错库：有映射但 mesh 无锚点（被替换）→ 拒绝出数；
//   R33-5  tag 漂移：agents.mesh_instance_tag ≠ 配对标识 → 拒绝出数；
//   R33-6  空库/无映射：缺锚点安全零值（不抛），且新增映射自动带上 mesh_instance_tag。
//
// 分层纪律：本文件不 import @pi/agent-mesh（R1）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { PairingError } from "../src/index.js";
import { createRuntimeInternals } from "../src/runtime/runtime.js";
import { openRoleDb } from "../src/db/db.js";
import { costMetricsExcludingReflect } from "../src/inspect/cost.js";
import { readPairingAnchor } from "../src/mesh/pairing.js";
import { evaluatePairing } from "../src/runtime/pairing.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";
import { addMeshAnchor, installRolePairing, TEST_ANCHOR, TEST_PAIRING_ID } from "./helpers/pairing.js";

describe("R33 dual-db pairing (§18.2 / E3)", () => {
  it("R33-1: first boot generates pairing id + establishes anchor; reopen is stable and verified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r33-"));
    try {
      const dbPath = join(dir, "role-agent.db");
      const meshDbPath = join(dir, "mesh.db");

      const rt1 = (await createRuntimeInternals({
        root: dir,
        db: dbPath,
        meshDb: meshDbPath,
        devMode: true,
        fake: { streamPort: true, sessions: true },
      })) as RuntimeInternals;
      await rt1.close();

      // 配对标识已持久化，锚点已在 mesh 里（profile_ref === 配对 id）。
      const dbA = new Database(dbPath, { readonly: true });
      const row = dbA.prepare("SELECT pairing_id, anchor_account FROM pairing_anchor WHERE id = 1").get() as {
        pairing_id: string;
        anchor_account: string;
      };
      dbA.close();
      expect(row.anchor_account).toBe("role:pairing");
      expect(row.pairing_id).toMatch(/^[0-9a-f-]{36}$/);
      const anchor = readPairingAnchor(meshDbPath, row.anchor_account);
      expect(anchor.present).toBe(true);
      expect(anchor.profileRef).toBe(row.pairing_id);

      // 重开：同配对 id、锚点回读仍成立（不重建、不换标识）。
      const rt2 = (await createRuntimeInternals({
        root: dir,
        db: dbPath,
        meshDb: meshDbPath,
        devMode: true,
        fake: { streamPort: true, sessions: true },
      })) as RuntimeInternals;
      try {
        const dbA2 = new Database(dbPath, { readonly: true });
        const row2 = dbA2.prepare("SELECT pairing_id FROM pairing_anchor WHERE id = 1").get() as { pairing_id: string };
        dbA2.close();
        expect(row2.pairing_id).toBe(row.pairing_id);
      } finally {
        await rt2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R33-2: host pairingAnchor override persists; changing it on reopen is rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r33-anchor-"));
    try {
      const dbPath = join(dir, "role-agent.db");
      const meshDbPath = join(dir, "mesh.db");
      const custom = "host-pair-anchor";

      const rt1 = (await createRuntimeInternals({
        root: dir,
        db: dbPath,
        meshDb: meshDbPath,
        devMode: true,
        pairingAnchor: custom,
        fake: { streamPort: true, sessions: true },
      })) as RuntimeInternals;
      await rt1.close();

      const anchor = readPairingAnchor(meshDbPath, custom);
      expect(anchor.present).toBe(true);

      // 重开改传不同锚点 → 配置冲突拒绝（配对不得换锚点）。
      await expect(
        createRuntimeInternals({
          root: dir,
          db: dbPath,
          meshDb: meshDbPath,
          devMode: true,
          pairingAnchor: "other-anchor",
          fake: { streamPort: true, sessions: true },
        }),
      ).rejects.toThrow(PairingError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R33-3: wrong mesh (anchor carries different marker) → cost refuses instead of under-excluding", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r33-mismatch-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      roleDb.db
        .prepare(
          `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at, mesh_account_id)
           VALUES ('ag','role','/b','h1','active','2026-01-01T00:00:00.000Z','acct-ag')`,
        )
        .run();
      installRolePairing(roleDb.db);

      // mesh 替身：锚点账号在，但标记是别的配对 → 错库。
      const meshDbPath = join(dir, "mesh.db");
      const mesh = new Database(meshDbPath);
      mesh.exec(`CREATE TABLE mesh_accounts (id TEXT PRIMARY KEY, profile_ref TEXT)`);
      mesh.prepare("INSERT INTO mesh_accounts (id, profile_ref) VALUES (?, ?)").run(TEST_ANCHOR, "other-pairing");
      mesh.close();

      expect(() => costMetricsExcludingReflect(roleDb.db, meshDbPath)).toThrow(PairingError);
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R33-4: registered mappings but mesh has no anchor (replaced) → refuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r33-noanchor-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      roleDb.db
        .prepare(
          `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at, mesh_account_id)
           VALUES ('ag','role','/b','h1','active','2026-01-01T00:00:00.000Z','acct-ag')`,
        )
        .run();
      installRolePairing(roleDb.db);

      // mesh 库存在但无 mesh_accounts 表 → 无锚点；映射仍在 → 整体拒绝。
      const meshDbPath = join(dir, "mesh.db");
      const mesh = new Database(meshDbPath);
      mesh.exec("CREATE TABLE mesh_messages (id TEXT PRIMARY KEY)");
      mesh.close();

      expect(() => evaluatePairing(roleDb.db, meshDbPath)).toThrow(PairingError);
      expect(() => costMetricsExcludingReflect(roleDb.db, meshDbPath)).toThrow(PairingError);
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R33-5: mesh_instance_tag drift on a mapping → refuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r33-tag-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      // 只装单行配对，不动 agents：让映射 tag 保持漂移值。
      roleDb.db
        .prepare(
          `INSERT OR IGNORE INTO pairing_anchor (id, pairing_id, anchor_account, created_at)
           VALUES (1, ?, ?, ?)`,
        )
        .run(TEST_PAIRING_ID, TEST_ANCHOR, "2026-01-01T00:00:00.000Z");
      // 映射曾属另一实例：tag 写成别的值。
      roleDb.db
        .prepare(
          `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at, mesh_account_id, mesh_instance_tag)
           VALUES ('ag','role','/b','h1','active','2026-01-01T00:00:00.000Z','acct-ag','p-another-instance')`,
        )
        .run();

      const meshDbPath = join(dir, "mesh.db");
      const mesh = new Database(meshDbPath);
      addMeshAnchor(mesh); // 锚点仍匹配 TEST_PAIRING_ID
      mesh.close();
      // 但该映射 tag 漂移 → 整体拒绝。
      expect(() => costMetricsExcludingReflect(roleDb.db, meshDbPath)).toThrow(PairingError);
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R33-6: empty role db (no mappings) → vacant, cost returns zero without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r33-empty-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      // 无任何已注册映射，且 mesh 缺锚点 → vacant → 安全零值。
      const m = costMetricsExcludingReflect(roleDb.db, join(dir, "no-mesh.db"));
      expect(m.deliveriesTotal).toBe(0);
      expect(m.messagesTotal).toBe(0);
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});