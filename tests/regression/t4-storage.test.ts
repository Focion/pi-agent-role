// ═══════════════════════════════════════════════════════════════════════════
// T4 组：存储与跨库规约（§21.3.4）—— 最高 ROI 子集
//
// 覆盖：
//   T4.2  本环连接内 database_list 只有 main（无 ATTACH 到 mesh 库）
//   T4.3  已删三表（scene_messages/sessions/session_entries）确实不存在
//   T4.13 virtual_hours = virtualHoursOf(virtual_ts) 全表一致（物化投影，漂移可检出）
//
// A1–A11（T4.1）、悬挂检测（T4.4）已在 invariants.test.ts / dangling-scan.test.ts 覆盖，
// 此处不重复。分层纪律：本文件不 import @pi/agent-mesh（R1）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { assertDistinctDbPaths, openRoleDb } from "../../src/db/db.js";
import { createRuntime } from "../../src/index.js";
import { virtualHoursOf } from "../../src/runtime/virtual-clock.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-t4-"));
  const db = openRoleDb(join(dir, "role-agent.db"));
  return { dir, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

/** 读取某表所有非空 virtual_ts 行，返回 virtual_hours 与物化投影不一致的行。 */
function driftRows(db: ReturnType<typeof openRoleDb>, table: string) {
  const rows = db.db
    .prepare<[], { virtual_ts: string; virtual_hours: number }>(
      `SELECT virtual_ts, virtual_hours FROM ${table} WHERE virtual_ts IS NOT NULL`,
    )
    .all();
  return rows.filter((r) => r.virtual_hours !== virtualHoursOf(r.virtual_ts));
}

describe("T4 storage / cross-db contract (§21.3.4)", () => {
  it("T4.2: database_list has only main — no ATTACH to mesh db", () => {
    const { db, cleanup } = setup();
    try {
      const list = db.db.pragma("database_list") as Array<{ name: string }>;
      const names = list.map((r) => r.name).filter((n) => n !== "temp");
      // 只允许 main；temp 是 SQLite 自动建的，可忽略。任何外部 ATTACH 都是违规。
      expect(names).toEqual(["main"]);
    } finally {
      cleanup();
    }
  });

  it("T4.3: deleted tables (scene_messages/sessions/session_entries) do not exist", () => {
    const { db, cleanup } = setup();
    try {
      const rows = db.db
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('scene_messages','sessions','session_entries')")
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("T4.13: correctly-materialized virtual_hours in episodes shows no drift", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at)
        VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      // W3D1T14 → (3*7+1)*24+14 = 542。写入时由 parseVirtualTs 同时算好（§15.1.3）。
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,salience,confidence,retention,virtual_ts,virtual_hours,real_ts)
        VALUES ('ep-ok','alice','event','a',0.5,0.5,0.5,'W3D1T14',542,'2025-01-01T00:00:00.000Z')`);
      expect(driftRows(db, "episodes")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("T4.13: drifted virtual_hours in episodes is detectable", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at)
        VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      // 物化整数与字面量不一致（应为 542，写成 0）→ 必须被投影一致性检查捕获。
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,salience,confidence,retention,virtual_ts,virtual_hours,real_ts)
        VALUES ('ep-bad','alice','event','a',0.5,0.5,0.5,'W3D1T14',0,'2025-01-01T00:00:00.000Z')`);
      const drift = driftRows(db, "episodes");
      expect(drift).toHaveLength(1);
      expect(drift[0]!.virtual_ts).toBe("W3D1T14");
      expect(drift[0]!.virtual_hours).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("T4.13: knowledge_events projection consistency; knowledge_items last_practiced never half-null", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at)
        VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      // 正确物化：W3D1T14 → 542。
      db.db.exec(`INSERT INTO knowledge_items (kn_id,owner_agent,topic,claim,mastery,retention,last_practiced_vhours,last_practiced_at,first_seen_at,updated_at)
        VALUES ('kn-1','alice','math','1+1=2','heard',1.0,542,'W3D1T14','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO knowledge_events (ev_id,kn_id,owner_agent,to_mastery,evidence_kind,virtual_ts,virtual_hours,created_at)
        VALUES ('ev-1','kn-1','alice','heard','taught','W3D1T14',542,'2025-01-01T00:00:00.000Z')`);

      // knowledge_events 的一致性
      expect(driftRows(db, "knowledge_events")).toHaveLength(0);

      // knowledge_items 的「练习时间」双列不同时半空：vhours=0 且 at=NULL（从未练）是合法态；
      // vhours=0 且 at 非空，或 vhours≠0 且 at 为空，都是漂移。
      const halfNull = db.db
        .prepare(`SELECT COUNT(*) AS c FROM knowledge_items
          WHERE (last_practiced_vhours = 0 AND last_practiced_at IS NOT NULL)
             OR (last_practiced_vhours <> 0 AND last_practiced_at IS NULL)`)
        .get() as { c: number };
      expect(halfNull.c).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("T4.2 complement: DB-A has no mesh_ prefixed objects", () => {
    const { db, cleanup } = setup();
    try {
      const objs = db.db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'mesh\\_%' ESCAPE '\\'")
        .all() as Array<{ name: string }>;
      expect(objs).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("R03 same-file / alias rejection (§18.7 / H02)", () => {
  it("rejects identical resolved path (.. normalization)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r03-"));
    try {
      const a = join(dir, "role-agent.db");
      const b = `${dir}/sub/../role-agent.db`;
      expect(() => assertDistinctDbPaths(a, b)).toThrow(/same path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects symlink alias when both files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r03-"));
    try {
      const a = join(dir, "role.db");
      const b = join(dir, "mesh.db");
      writeFileSync(a, "");
      symlinkSync(a, b); // mesh.db 是指向 role.db 的符号链接
      expect(() => assertDistinctDbPaths(a, b)).toThrow(/same file|same path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects hardlink alias when both files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r03-"));
    try {
      const a = join(dir, "role.db");
      const b = join(dir, "mesh.db");
      writeFileSync(a, "");
      linkSync(a, b); // 硬链接：同 dev+ino
      expect(() => assertDistinctDbPaths(a, b)).toThrow(/same file|same path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows distinct paths and :memory:", () => {
    expect(() => assertDistinctDbPaths("/x/a.db", "/x/b.db")).not.toThrow();
    expect(() => assertDistinctDbPaths(":memory:", "/x/b.db")).not.toThrow();
    expect(() => assertDistinctDbPaths("/x/a.db", ":memory:")).not.toThrow();
  });

  it("createRuntime rejects same path before any side effect (no file created)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r03-"));
    const db = join(dir, "shared.db");
    try {
      await expect(
        createRuntime({ root: dir, db, meshDb: db, fake: { sessions: true } }),
      ).rejects.toThrow(/same path/);
      // 守卫先于 openRoleDb 的 mkdir/建库，副作用前拒绝。
      expect(existsSync(db)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R03: migration failure rolls back atomically — init is retryable", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-r03-"));
    const path = join(dir, "role-agent.db");
    try {
      // 造一个与 001 冲突的半成品：预建缺失 owner_agent 的 episodes（IF NOT EXISTS 会跳过
      // 001 的 CREATE TABLE episodes），使 001 后续 `idx_episodes_owner_ts ON episodes(owner_agent)`
      // 建索引失败 → 整段迁移回滚。这依赖 001 的该索引列，属源码级回归锁定。
      const raw = new Database(path);
      raw.pragma("user_version = 0");
      raw.exec("CREATE TABLE episodes (dummy INTEGER)");
      raw.close();

      expect(() => openRoleDb(path)).toThrow();

      // 整段迁移单事务：失败文件中早于索引的 CREATE TABLE agents 也被回滚，user_version 保持 0。
      const check = new Database(path, { readonly: true });
      try {
        expect(check.pragma("user_version", { simple: true })).toBe(0);
        const tables = check
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>;
        const names = tables.map((r) => r.name);
        expect(names).toContain("episodes"); // 只有手工建的半成品，无 agents/scenes 等
        expect(names).not.toContain("agents");
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});