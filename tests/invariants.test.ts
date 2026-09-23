// ═══════════════════════════════════════════════════════════════════════════
// P6.2 分区不变量测试（A1–A11，§18.7.2）
//
// 每个断言一个用例：构造最小违反行 → 运行 checkRoleInvariants → 断言特定 violation id。
// 最后一条用例验证干净库全通过。
//
// 分层纪律：本文件不 import @pi/agent-mesh。全部测试只操作 DB-A。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openRoleDb } from "../src/db/db.js";
import { checkRoleInvariants } from "../src/inspect/invariant-sql.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-inv-"));
  const dbPath = join(dir, "role-agent.db");
  const db = openRoleDb(dbPath);
  return { dir, dbPath, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("A1–A11 invariants (§18.7.2)", () => {
  it("A1: cross-owner rows detected — memory_decisions owner not in agents", () => {
    const { db, cleanup } = setup();
    try {
      // memory_decisions 有 owner_agent='ghost' 但 agents 表为空 → A1 违规
      db.db.exec(`INSERT INTO memory_decisions (owner_agent, source_msg_id, path, score, write_decided, components_json, virtual_ts, decided_at)
        VALUES ('ghost','msg-1','P1',0.5,1,'{}','W1D1T1','2025-01-01T00:00:00.000Z')`);
      const report = checkRoleInvariants(db.db);
      expect(report.ok).toBe(false);
      expect(report.checked).toBe(12);
      const a1 = report.violations.filter((v) => v.id.startsWith("A1"));
      expect(a1.length).toBeGreaterThanOrEqual(1);
      // 至少 memory_decisions 那行被检出
      const memdec = report.violations.find((v) => v.id === "A1 [memory_decisions]");
      expect(memdec).toBeDefined();
      expect(memdec!.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("A1: all nine tables checked, clean slate → zero violations", () => {
    const { db, cleanup } = setup();
    try {
      // 空库（只有 DDL 无数据）→ A1 全绿
      const report = checkRoleInvariants(db.db);
      // A1 的 9 行 bad 都为 0 ⇒ 无 violation 插入
      const a1Violations = report.violations.filter((v) => v.id.startsWith("A1"));
      expect(a1Violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("A2: subject_profiles evidence crosses owners", () => {
    const { db, cleanup } = setup();
    try {
      // 两个 agent + 各自的 episode + 一个跨 owner 的 profile evidence
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('bob','role','/b','h2','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,salience,confidence,retention,real_ts) VALUES ('ep-1','alice','event','test',0.5,0.5,0.5,'2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,salience,confidence,retention,real_ts) VALUES ('ep-2','bob','event','test',0.5,0.5,0.5,'2025-01-01T00:00:00.000Z')`);
      // alice 的 profile 引用了 bob 的 episode → A2 违规
      db.db.exec(`INSERT INTO subject_profiles (owner_agent,subject_type,subject_id,evidence_json,updated_at)
        VALUES ('alice','person','bob','[{"episode_id":"ep-2","weight":1.0}]','2025-01-01T00:00:00.000Z')`);
      const report = checkRoleInvariants(db.db);
      const a2 = report.violations.find((v) => v.id === "A2");
      expect(a2).toBeDefined();
      expect(a2!.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("A2': orphan episode_subjects", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      // episode_subjects 引用不存在的 episode → A2' 违规
      db.db.exec(`INSERT INTO episode_subjects (episode_id, subject_type, subject_id) VALUES ('ghost-ep','person','bob')`);
      const report = checkRoleInvariants(db.db);
      const a2p = report.violations.find((v) => v.id === "A2'");
      expect(a2p).toBeDefined();
      expect(a2p!.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("A3: knowledge_events owner ≠ item owner", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('bob','role','/b','h2','2025-01-01T00:00:00.000Z')`);
      // item 属于 bob
      db.db.exec(`INSERT INTO knowledge_items (kn_id,owner_agent,topic,claim,mastery,retention,last_practiced_vhours,first_seen_at,updated_at) VALUES ('kn-1','bob','math','1+1=2','heard',1.0,0,'2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z')`);
      // event 属于 alice → A3 违规
      db.db.exec(`INSERT INTO knowledge_events (ev_id,kn_id,owner_agent,to_mastery,evidence_kind,created_at) VALUES ('ev-1','kn-1','alice','heard','taught','2025-01-01T00:00:00.000Z')`);
      const report = checkRoleInvariants(db.db);
      const a3 = report.violations.find((v) => v.id === "A3");
      expect(a3).toBeDefined();
      expect(a3!.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("A4: scene↔conversation 1:1 violation", () => {
    const { db, cleanup } = setup();
    try {
      // 先移除唯一索引才可构造重复绑定（ux_scenes_conversation 是先验防护）。
      db.db.exec("DROP INDEX IF EXISTS ux_scenes_conversation");
      db.db.exec(`INSERT INTO scenes (scene_id,participants_json,created_at) VALUES ('s1','[]','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO scenes (scene_id,participants_json,created_at) VALUES ('s2','[]','2025-01-01T00:00:00.000Z')`);
      // 两个场景绑定同一个 conversation_id → A4 违规
      db.db.exec(`UPDATE scenes SET conversation_id = 'conv-1'`);
      const report = checkRoleInvariants(db.db);
      const a4 = report.violations.find((v) => v.id === "A4");
      expect(a4).toBeDefined();
      expect(a4!.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("A5: primary account = reflect account", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, mesh_account_id, mesh_reflect_account_id, created_at)
        VALUES ('alice','role','/b','h1','acct-alice','acct-alice','2025-01-01T00:00:00.000Z')`);
      const report = checkRoleInvariants(db.db);
      const a5 = report.violations.find((v) => v.id === "A5");
      expect(a5).toBeDefined();
      expect(a5!.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("A6: reflect account is also a primary account", () => {
    const { db, cleanup } = setup();
    try {
      // bob 的主 account 是 'acct-bob'，alice 的 reflect account 也是 'acct-bob' → A6 违规
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, mesh_account_id, created_at)
        VALUES ('bob','role','/b','h2','acct-bob','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, mesh_account_id, mesh_reflect_account_id, created_at)
        VALUES ('alice','role','/b','h1','acct-alice','acct-bob','2025-01-01T00:00:00.000Z')`);
      const report = checkRoleInvariants(db.db);
      const a6 = report.violations.find((v) => v.id === "A6");
      expect(a6).toBeDefined();
      expect(a6!.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("A7: mesh_ tables detected in DB-A", () => {
    const { db, cleanup } = setup();
    try {
      // 手动创建一张 mesh_ 前缀表 → A7 违规
      db.db.exec("CREATE TABLE mesh_injected (x INTEGER)");
      const report = checkRoleInvariants(db.db);
      const a7 = report.violations.find((v) => v.id === "A7");
      expect(a7).toBeDefined();
      expect(a7!.count).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it("A8: deleted tables detected", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec("CREATE TABLE scene_messages (id TEXT)");
      const report = checkRoleInvariants(db.db);
      const a8 = report.violations.find((v) => v.id === "A8");
      expect(a8).toBeDefined();
      expect(a8!.count).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it("A9: bare-reference column in UNIQUE index (excluding exempt)", () => {
    const { db, cleanup } = setup();
    try {
      // 创建包含 source_msg_id 的 UNIQUE 索引（非豁免名称）→ A9 违规
      db.db.exec("CREATE UNIQUE INDEX ux_bad_ref ON episodes(source_msg_id)");
      const report = checkRoleInvariants(db.db);
      const a9 = report.violations.find((v) => v.id === "A9");
      expect(a9).toBeDefined();
      expect(a9!.count).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it("A9: exempt indexes (ux_scenes_conversation, idx_retrieval_once) do not flag", () => {
    const { db, cleanup } = setup();
    try {
      // 这两条索引在 migration 中已创建且属于豁免名单 → A9 不报
      const report = checkRoleInvariants(db.db);
      const a9 = report.violations.find((v) => v.id === "A9");
      // 必须是 undefined（没有违反）而非 {count:0}
      expect(a9).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("A10: episode scene_id not in scenes", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      // episode 引用不存在的 scene → A10 违规
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,scene_id,gist,salience,confidence,retention,real_ts)
        VALUES ('ep-1','alice','event','ghost-scene','test',0.5,0.5,0.5,'2025-01-01T00:00:00.000Z')`);
      const report = checkRoleInvariants(db.db);
      const a10 = report.violations.find((v) => v.id === "A10");
      expect(a10).toBeDefined();
      expect(a10!.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("A11: retrieval_log with tokens_total>0 missing card snapshot", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      // tokens_total > 0 但 rendered_card 和 card_sha256 都是 NULL → A11 违规
      db.db.exec(`INSERT INTO retrieval_log (retrieval_id,owner_agent,tokens_total,real_ts)
        VALUES ('rl-1','alice',100,'2025-01-01T00:00:00.000Z')`);
      const report = checkRoleInvariants(db.db);
      const a11 = report.violations.find((v) => v.id === "A11");
      expect(a11).toBeDefined();
      expect(a11!.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("A11: retrieval_log with tokens_total=0 without card → ok", () => {
    const { db, cleanup } = setup();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      // tokens_total=0 不需要卡片 → 不违规
      db.db.exec(`INSERT INTO retrieval_log (retrieval_id,owner_agent,tokens_total,real_ts)
        VALUES ('rl-1','alice',0,'2025-01-01T00:00:00.000Z')`);
      const report = checkRoleInvariants(db.db);
      const a11 = report.violations.find((v) => v.id === "A11");
      expect(a11).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("clean slate: all 11 assertions pass on empty DB", () => {
    const { db, cleanup } = setup();
    try {
      const report = checkRoleInvariants(db.db);
      expect(report.ok).toBe(true);
      expect(report.checked).toBe(12);
      expect(report.violations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});