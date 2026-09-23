// ═══════════════════════════════════════════════════════════════════════════
// P6.1 观测视图测试（MemoryTimeline / ImpressionEvolution / CostView）
//
// 分层纪律：本文件不 import @pi/agent-mesh。视图涉及跨库时走 fake mesh DB-B。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openRoleDb } from "../src/db/db.js";
import { buildImpressionEvolution } from "../src/observe/profile-history.js";
import { buildMemoryTimeline } from "../src/observe/timeline.js";
import { buildCostView } from "../src/observe/cost-view.js";

function setupRoleDb() {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-obs-"));
  const dbPath = join(dir, "role-agent.db");
  const db = openRoleDb(dbPath);
  return { dir, dbPath, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

/** 创建一个最小 mesh DB-B，含 mesh_messages + mesh_deliveries 表。 */
function setupMeshDb(dir: string): string {
  const meshPath = join(dir, "mesh.db");
  const db = new Database(meshPath);
  db.exec("CREATE TABLE IF NOT EXISTS mesh_messages (id TEXT PRIMARY KEY, conversation_id TEXT, seq INTEGER, from_account TEXT, kind TEXT, text TEXT, routed_at TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS mesh_deliveries (id TEXT PRIMARY KEY, message_id TEXT, account_id TEXT, grade TEXT, path TEXT, woke INTEGER, state TEXT, drop_reason TEXT, parked_reason TEXT)");
  db.close();
  return meshPath;
}

describe("ImpressionEvolution (§20.3.2)", () => {
  it("empty profile → empty points, no jumps", () => {
    const { db, cleanup } = setupRoleDb();
    try {
      const result = buildImpressionEvolution(db.db, "alice", "person", "bob");
      expect(result.ownerAgent).toBe("alice");
      expect(result.subjectType).toBe("person");
      expect(result.subjectId).toBe("bob");
      expect(result.current.impression).toBeNull();
      expect(result.points).toHaveLength(0);
      expect(result.jumps).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("single state_write → one point, no jumps", () => {
    const { db, cleanup } = setupRoleDb();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO subject_profiles (owner_agent,subject_type,subject_id,impression,valence,closeness,updated_at)
        VALUES ('alice','person','bob','friendly',0.6,0.5,'2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO state_writes (write_id,owner_agent,target,target_id,op,after_json,actor,real_ts)
        VALUES ('sw-1','alice','subject_profile','person:bob','update','{"valence":0.6,"closeness":0.5,"impression":"friendly"}','ReflectionService','2025-01-01T00:00:00.000Z')`);

      const result = buildImpressionEvolution(db.db, "alice", "person", "bob");
      expect(result.current.valence).toBe(0.6);
      expect(result.points).toHaveLength(1);
      expect(result.points[0]!.valence).toBe(0.6);
      expect(result.points[0]!.closeness).toBe(0.5);
      expect(result.points[0]!.impression).toBe("friendly");
      expect(result.jumps).toHaveLength(0); // single point, can't jump
    } finally {
      cleanup();
    }
  });

  it("jump detection: large valence swing without evidence → unexplained", () => {
    const { db, cleanup } = setupRoleDb();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO subject_profiles (owner_agent,subject_type,subject_id,valence,closeness,updated_at)
        VALUES ('alice','person','bob',0.5,0.5,'2025-01-01T00:00:00.000Z')`);
      // point 1: positive
      db.db.exec(`INSERT INTO state_writes (write_id,owner_agent,target,target_id,op,after_json,actor,real_ts)
        VALUES ('sw-1','alice','subject_profile','person:bob','update','{"valence":0.8,"closeness":0.6}','ReflectionService','2025-01-01T00:00:00.000Z')`);
      // point 2: large negative swing (-0.9 delta), no evidence → unexplained jump
      db.db.exec(`INSERT INTO state_writes (write_id,owner_agent,target,target_id,op,after_json,actor,real_ts)
        VALUES ('sw-2','alice','subject_profile','person:bob','update','{"valence":-0.1,"closeness":0.3}','ReflectionService','2025-01-02T00:00:00.000Z')`);

      const result = buildImpressionEvolution(db.db, "alice", "person", "bob");
      expect(result.points).toHaveLength(2);
      expect(result.jumps).toHaveLength(1);
      expect(result.jumps[0]!.verdict).toBe("unexplained");
      expect(result.jumps[0]!.valenceDelta).toBe(-0.9);
    } finally {
      cleanup();
    }
  });

  it("jump with evidence → explained", () => {
    const { db, cleanup } = setupRoleDb();
    try {
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,salience,confidence,retention,real_ts) VALUES ('ep-1','alice','event','evidence',0.5,0.5,0.5,'2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO subject_profiles (owner_agent,subject_type,subject_id,valence,evidence_json,updated_at)
        VALUES ('alice','person','bob',0.5,'[{"episode_id":"ep-1","weight":1.0}]','2025-01-01T00:00:00.000Z')`);
      // point 1
      db.db.exec(`INSERT INTO state_writes (write_id,owner_agent,target,target_id,op,after_json,before_json,actor,real_ts)
        VALUES ('sw-1','alice','subject_profile','person:bob','update','{"valence":0.8}','{"evidence_json":"[{\\"episode_id\\":\\"ep-1\\",\\"weight\\":1.0}]"}','ReflectionService','2025-01-01T00:00:00.000Z')`);
      // point 2: large swing with evidence → explained
      db.db.exec(`INSERT INTO state_writes (write_id,owner_agent,target,target_id,op,after_json,before_json,actor,real_ts)
        VALUES ('sw-2','alice','subject_profile','person:bob','update','{"valence":-0.2}','{"evidence_json":"[{\\"episode_id\\":\\"ep-1\\",\\"weight\\":1.0}]"}','ReflectionService','2025-01-02T00:00:00.000Z')`);

      const result = buildImpressionEvolution(db.db, "alice", "person", "bob");
      expect(result.points).toHaveLength(2);
      expect(result.jumps).toHaveLength(1);
      expect(result.jumps[0]!.verdict).toBe("explained");
    } finally {
      cleanup();
    }
  });
});

describe("MemoryTimeline (§20.3.1)", () => {
  it("empty DB → empty timeline, no scenes, no items", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      const result = buildMemoryTimeline(db.db, meshPath, "alice");
      expect(result.ownerAgent).toBe("alice");
      expect(result.scenes).toHaveLength(0);
      expect(result.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("episodes without mesh evidence → L1/L2 fallback", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, mesh_account_id, created_at) VALUES ('alice','role','/b','h1','acct-alice','2025-01-01T00:00:00.000Z')`);
      // episode with quote → L1
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,quote,source_msg_id,salience,confidence,retention,real_ts)
        VALUES ('ep-1','alice','event','test','some quote','msg-999',0.5,0.5,0.5,'2025-01-01T00:00:00.000Z')`);
      // episode without quote → L2
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,source_msg_id,salience,confidence,retention,real_ts)
        VALUES ('ep-2','alice','event','no quote','msg-888',0.5,0.5,0.5,'2025-01-02T00:00:00.000Z')`);

      const result = buildMemoryTimeline(db.db, meshPath, "alice");
      // items are in unscened bucket
      expect(result.scenes).toHaveLength(1);
      expect(result.scenes[0]!.sceneId).toBe("_unscened");
      expect(result.scenes[0]!.items).toHaveLength(2);
      const levels = result.scenes[0]!.items.map((i) => i.evidenceLevel);
      // L1: has quote but no mesh evidence; L2: neither quote nor mesh evidence
      expect(levels).toContain("L1");
      expect(levels).toContain("L2");
    } finally {
      cleanup();
    }
  });

  it("episode with mesh evidence → L0", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, mesh_account_id, created_at) VALUES ('alice','role','/b','h1','acct-alice','2025-01-01T00:00:00.000Z')`);

      // Insert mesh message + delivery
      const meshDb = new Database(meshPath);
      meshDb.exec(`INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, text, routed_at)
        VALUES ('msg-1','conv-1',1,'bob','chat','hello alice','2025-01-01T00:00:00.000Z')`);
      meshDb.exec(`INSERT INTO mesh_deliveries (id, message_id, account_id, grade, path, woke, state)
        VALUES ('del-1','msg-1','acct-alice','silent','P2',0,'delivered')`);
      meshDb.close();

      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,source_msg_id,salience,confidence,retention,real_ts)
        VALUES ('ep-1','alice','event','hello from bob','msg-1',0.5,0.5,0.5,'2025-01-01T00:00:00.000Z')`);

      const result = buildMemoryTimeline(db.db, meshPath, "alice");
      const items = result.scenes[0]!.items;
      expect(items).toHaveLength(1);
      expect(items[0]!.evidenceLevel).toBe("L0");
      expect(items[0]!.evidence).not.toBeNull();
      expect(items[0]!.evidence!.text).toBe("hello alice");
      expect(items[0]!.evidence!.delivery).not.toBeNull();
      expect(items[0]!.evidence!.delivery!.grade).toBe("silent");
    } finally {
      cleanup();
    }
  });

  it("episodes grouped by scene", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO scenes (scene_id,name,participants_json,created_at) VALUES ('s1','Scene One','[]','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO scenes (scene_id,name,participants_json,created_at) VALUES ('s2','Scene Two','[]','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,scene_id,gist,salience,confidence,retention,real_ts)
        VALUES ('ep-1','alice','event','s1','in scene 1',0.5,0.5,0.5,'2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,scene_id,gist,salience,confidence,retention,real_ts)
        VALUES ('ep-2','alice','event','s2','in scene 2',0.5,0.5,0.5,'2025-01-02T00:00:00.000Z')`);

      const result = buildMemoryTimeline(db.db, meshPath, "alice");
      const sceneIds = result.scenes.map((s) => s.sceneId).sort();
      expect(sceneIds).toEqual(["s1", "s2"]);
      const s1 = result.scenes.find((s) => s.sceneId === "s1")!;
      expect(s1.items).toHaveLength(1);
      expect(s1.items[0]!.gist).toBe("in scene 1");
    } finally {
      cleanup();
    }
  });

  it("maxItems truncation", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      for (let i = 0; i < 10; i++) {
        db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,salience,confidence,retention,real_ts)
          VALUES ('ep-${i}','alice','event','item ${i}',0.5,0.5,0.5,'2025-01-0${Math.min(9,i+1)}T00:00:00.000Z')`);
      }

      const result = buildMemoryTimeline(db.db, meshPath, "alice", { maxItems: 5 });
      expect(result.truncated).toBe(true);
      const allItems = result.scenes.flatMap((s) => s.items);
      expect(allItems.length).toBeLessThanOrEqual(5);
    } finally {
      cleanup();
    }
  });
});

describe("CostView (§20.3.3)", () => {
  it("empty DB → zero-cost view with valid structure", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      const result = buildCostView(db.db, meshPath);
      expect(result.window.since).toBeDefined();
      expect(result.window.until).toBeDefined();
      expect(result.roleOnly.messagesTotal).toBe(0);
      expect(result.roleOnly.deliveriesTotal).toBe(0);
      expect(result.localOverhead.retrieval.calls).toBe(0);
      expect(result.localOverhead.reflection.runs).toBe(0);
      expect(result.localOverhead.sceneBudget.overBudgetScenes).toHaveLength(0);
      expect(result.health.policyDegradedEvents).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("retrieval overhead tallied from retrieval_log", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO retrieval_log (retrieval_id,owner_agent,tokens_l2,tokens_l1,tokens_transient,tokens_total,clamped,real_ts)
        VALUES ('rl-1','alice',50,30,10,90,0,'2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO retrieval_log (retrieval_id,owner_agent,tokens_l2,tokens_l1,tokens_transient,tokens_total,clamped,real_ts)
        VALUES ('rl-2','alice',100,50,20,170,1,'2025-01-02T00:00:00.000Z')`);

      const result = buildCostView(db.db, meshPath);
      expect(result.localOverhead.retrieval.calls).toBe(2);
      expect(result.localOverhead.retrieval.tokensL2).toBe(150);
      expect(result.localOverhead.retrieval.tokensL1).toBe(80);
      expect(result.localOverhead.retrieval.tokensTransient).toBe(30);
      expect(result.localOverhead.retrieval.tokensTotal).toBe(260);
      expect(result.localOverhead.retrieval.clampedCalls).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("reflection overhead tallied from reflections", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO reflections (reflection_id,owner_agent,trigger,episodes_written,profiles_touched,status,started_at,finished_at)
        VALUES ('r1','alice','manual',3,2,'done','2025-01-01T00:00:00.000Z','2025-01-01T00:00:01.000Z')`);
      db.db.exec(`INSERT INTO reflections (reflection_id,owner_agent,trigger,episodes_written,profiles_touched,status,started_at)
        VALUES ('r2','alice','manual',0,0,'failed','2025-01-02T00:00:00.000Z')`);

      const result = buildCostView(db.db, meshPath);
      expect(result.localOverhead.reflection.runs).toBe(2);
      expect(result.localOverhead.reflection.failed).toBe(1);
      expect(result.localOverhead.reflection.episodesWritten).toBe(3);
      expect(result.localOverhead.reflection.profilesTouched).toBe(2);
      expect(result.localOverhead.reflection.wallMsTotal).toBeGreaterThanOrEqual(1000);
    } finally {
      cleanup();
    }
  });

  it("scene budget overage detected", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO scenes (scene_id,participants_json,token_budget,token_spent,created_at)
        VALUES ('s-over','[]',100,150,'2025-01-01T00:00:00.000Z')`);
      const result = buildCostView(db.db, meshPath);
      expect(result.localOverhead.sceneBudget.overBudgetScenes).toContain("s-over");
      expect(result.localOverhead.sceneBudget.tokenBudget).toBe(100);
      expect(result.localOverhead.sceneBudget.tokenSpent).toBe(150);
      expect(result.roleNormalized.turns).toBe(0); // scenes.turn_count defaults to 0
    } finally {
      cleanup();
    }
  });
});