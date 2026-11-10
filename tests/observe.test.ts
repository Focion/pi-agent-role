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
import { addMeshAnchor, installRolePairing } from "./helpers/pairing.js";

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
  db.exec("CREATE TABLE IF NOT EXISTS mesh_messages (id TEXT PRIMARY KEY, conversation_id TEXT, seq INTEGER, from_account TEXT, kind TEXT, payload TEXT, routed_at TEXT)");
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

  it("A30: quote without source anchor → L2（证据等级依来源，不依 quote 有无）", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, mesh_account_id, created_at) VALUES ('alice','role','/b','h1','acct-alice','2025-01-01T00:00:00.000Z')`);
      // 有 quote 但 source_msg_id 为 NULL：这里没有可回查的消息锚点，不能当作 L1 引文证据。
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,quote,source_msg_id,salience,confidence,retention,real_ts)
        VALUES ('ep-nosrc','alice','event','no source','a fabricated quote',NULL,0.5,0.5,0.5,'2025-01-01T00:00:00.000Z')`);

      const result = buildMemoryTimeline(db.db, meshPath, "alice");
      const items = result.scenes[0]!.items;
      expect(items).toHaveLength(1);
      expect(items[0]!.evidenceLevel).toBe("L2");
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
      meshDb.exec(`INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, payload, routed_at)
        VALUES ('msg-1','conv-1',1,'bob','chat','{"text":"hello alice"}','2025-01-01T00:00:00.000Z')`);
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

  it("R36: 本人发/收的原文可见（L0），定向他人不可见（降级且不暴露 text）", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, mesh_account_id, created_at)
        VALUES ('alice','role','/b','h1','acct-alice','2025-01-01T00:00:00.000Z')`);

      const meshDb = new Database(meshPath);
      // msg-self：本人发出（无自投递行）——仍属可见范围，原文应可看。
      meshDb.exec(`INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, payload, routed_at)
        VALUES ('msg-self','conv-1',1,'acct-alice','chat','{"text":"my own words"}','2025-01-01T00:00:00.000Z')`);
      // msg-other：bob 发出、投递给 carol——本人既非发件人也非收件人（定向不可见）。
      meshDb.exec(`INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, payload, routed_at)
        VALUES ('msg-other','conv-1',2,'bob','chat','{"text":"secret to carol"}','2025-01-01T00:00:01.000Z')`);
      meshDb.exec(`INSERT INTO mesh_deliveries (id, message_id, account_id, grade, path, woke, state)
        VALUES ('del-other','msg-other','acct-carol','silent','P2',0,'delivered')`);
      meshDb.close();

      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,source_msg_id,salience,confidence,retention,real_ts)
        VALUES ('ep-self','alice','event','i said this','msg-self',0.5,0.5,0.5,'2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO episodes (episode_id,owner_agent,kind,gist,quote,source_msg_id,salience,confidence,retention,real_ts)
        VALUES ('ep-other','alice','event','carol told bob a secret','a paraphrase','msg-other',0.5,0.5,0.5,'2025-01-01T00:00:01.000Z')`);

      const result = buildMemoryTimeline(db.db, meshPath, "alice");
      const items = result.scenes[0]!.items;
      const self = items.find((i) => i.episodeId === "ep-self")!;
      const other = items.find((i) => i.episodeId === "ep-other")!;

      expect(self.evidenceLevel).toBe("L0");
      expect(self.evidence?.text).toBe("my own words");

      // 定向他人的消息：不可见原文，不能升 L0；有 quote 故降级 L1，text 不暴露。
      expect(other.evidenceLevel).toBe("L1");
      expect(other.evidence).toBeNull();
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

  it("A36: scope 一致过滤——retrieval/reflection 按 agent∩scene，roleOnly 按 agent（数据段不再混入作用域外）", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      const TS = "2025-01-01T00:00:00.000Z";

      // alice / bob 两个角色，各有主/自省账号。
      db.db.exec(`INSERT INTO agents (agent_id,agent_type,blueprint_dir,blueprint_hash,mesh_account_id,mesh_reflect_account_id,created_at)
        VALUES ('alice','role','/b','h-alice','acct-alice','acct-alice:reflect','${TS}')`);
      db.db.exec(`INSERT INTO agents (agent_id,agent_type,blueprint_dir,blueprint_hash,mesh_account_id,mesh_reflect_account_id,created_at)
        VALUES ('bob','role','/b','h-bob','acct-bob','acct-bob:reflect','${TS}')`);
      installRolePairing(db.db); // R33：配对标识 + agents.mesh_instance_tag（配对成立才出数）

      // retrieval_log：alice+s1、alice+s2、bob+s1 各一条。
      db.db.exec(`INSERT INTO retrieval_log (retrieval_id,owner_agent,scene_id,tokens_total,clamped,real_ts) VALUES
        ('rl-a1','alice','s1',10,0,'${TS}'),
        ('rl-a2','alice','s2',20,0,'${TS}'),
        ('rl-b1','bob','s1',30,0,'${TS}')`);
      // reflections：alice+s1、alice+bob 各一条。
      db.db.exec(`INSERT INTO reflections (reflection_id,owner_agent,trigger,scene_id,started_at) VALUES
        ('rf-a1','alice','manual','s1','${TS}'),
        ('rf-a2','alice','manual','s2','${TS}'),
        ('rf-b1','bob','manual','s1','${TS}')`);
      db.db.exec(`INSERT INTO scenes (scene_id,participants_json,created_at) VALUES ('s1','[]','${TS}'),('s2','[]','${TS}')`);

      // mesh：alice 主账号收到 2 条投递 + 发出 1 条消息；bob 主账号收到 1 条 + 发出 1 条。
      const meshDb = new Database(meshPath);
      meshDb.exec(`INSERT INTO mesh_messages (id,conversation_id,seq,from_account,kind,payload,routed_at) VALUES
        ('m-a','c1',1,'acct-alice','chat','{}','${TS}'),
        ('m-b','c1',2,'acct-bob','chat','{}','${TS}'),
        ('m-t','c1',3,'acct-tea','chat','{}','${TS}')`);
      meshDb.exec(`INSERT INTO mesh_deliveries (id,message_id,account_id,grade,path,woke,state) VALUES
        ('d-1','m-b','acct-alice','silent','P1',0,'delivered'),
        ('d-2','m-t','acct-alice','steer','P1',1,'delivered'),
        ('d-3','m-a','acct-bob','silent','P1',0,'delivered')`);
      addMeshAnchor(meshDb); // R33：锚点账号，配对成立
      meshDb.close();

      const result = buildCostView(db.db, meshPath, { agentIds: ["alice"], sceneIds: ["s1"] });

      // retrieval / reflection 严格落在 agent∩scene 交集上。
      expect(result.localOverhead.retrieval.calls).toBe(1);
      expect(result.localOverhead.retrieval.tokensTotal).toBe(10);
      expect(result.localOverhead.reflection.runs).toBe(1);

      // roleOnly 按 agent 收紧：只统计 alice 主账号（收 2 条、发 1 条），bob 的不再混入。
      expect(result.roleOnly.deliveriesTotal).toBe(2);
      expect(result.roleOnly.messagesTotal).toBe(1);
      expect(result.scope).toEqual({ sceneIds: ["s1"], agentIds: ["alice"] });
    } finally {
      cleanup();
    }
  });

  it("R35: scene 累计量（turn_count/token_spent/overBudget）为生命周期累计，不按 created_at 进时间窗", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      // 场景在查询窗口之前就创建，累计 token 已超预算。
      db.db.exec(`INSERT INTO scenes (scene_id,participants_json,token_budget,token_spent,turn_count,created_at)
        VALUES ('s-old','[]',100,150,5,'2025-01-01T00:00:00.000Z')`);
      // 查询窗在场景创建之后：scene 累计值仍应可见（生命周期累计，非按创建时间筛出的窗口值）。
      const result = buildCostView(db.db, meshPath, {
        since: "2025-02-01T00:00:00.000Z",
        until: "2025-02-02T00:00:00.000Z",
      });
      expect(result.localOverhead.sceneBudget.tokenSpent).toBe(150);
      expect(result.localOverhead.sceneBudget.tokenBudget).toBe(100);
      expect(result.localOverhead.sceneBudget.overBudgetScenes).toContain("s-old");
      expect(result.roleNormalized.turns).toBe(5);
    } finally {
      cleanup();
    }
  });

  it("R35: 不可得量（utteranceMessages / verbatimPerTurn / reflection.mesh*）标 null 不以 0 占位", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      const result = buildCostView(db.db, meshPath);
      expect(result.roleNormalized.utteranceMessages).toBeNull();
      expect(result.roleNormalized.verbatimPerTurn).toBeNull();
      expect(result.roleNormalized.verbatimPerUtterance).toBeNull();
      expect(result.localOverhead.reflection.meshMessages).toBeNull();
      expect(result.localOverhead.reflection.meshDeliveries).toBeNull();
      expect(result.localOverhead.reflection.meshWakes).toBeNull();
      expect(result.caveats.some((c) => c.includes("不可得"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("R35: role 侧检索按半开窗 [since, until) 过滤（real_ts == until 不纳入）", () => {
    const { db, dir, cleanup } = setupRoleDb();
    try {
      const meshPath = setupMeshDb(dir);
      db.db.exec(`INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, created_at) VALUES ('alice','role','/b','h1','2025-01-01T00:00:00.000Z')`);
      db.db.exec(`INSERT INTO retrieval_log (retrieval_id,owner_agent,tokens_total,clamped,real_ts) VALUES
        ('rl-in','alice',10,0,'2025-02-01T00:00:00.000Z'),
        ('rl-edge','alice',99,0,'2025-02-02T00:00:00.000Z')`);
      // 窗 [2/1, 2/2)：rl-edge 的 real_ts 恰等于 until → 排除；rl-in 在窗内 → 计入。
      const result = buildCostView(db.db, meshPath, {
        since: "2025-02-01T00:00:00.000Z",
        until: "2025-02-02T00:00:00.000Z",
      });
      expect(result.localOverhead.retrieval.calls).toBe(1);
      expect(result.localOverhead.retrieval.tokensTotal).toBe(10);
    } finally {
      cleanup();
    }
  });
});