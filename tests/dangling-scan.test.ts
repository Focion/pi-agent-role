// ═══════════════════════════════════════════════════════════════════════════
// 悬挂引用两阶段扫描（§18.6.3）：
//   记忆行裸 msg_id（无外键）→ DB-A 导出锚点 → mesh 只读核对 → 写回 evidence_lost。
//
// 双库在临时目录各建一份：DB-A 走 openRoleDb（真实 DDL），DB-B 用最小 mesh_messages
// 替身（不拉 @pi/agent-mesh）。三个真实 msg_id 里只放回两个，留第三个悬挂；
// 另插一条 NULL source_msg_id 验证「缺锚点 ≠ 悬挂」的单列计数。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openRoleDb } from "../src/db/db.js";
import { scanDanglingMessages } from "../src/inspect/dangling-scan.js";
import { addMeshAnchor, installRolePairing } from "./helpers/pairing.js";

const INSERT_EPISODE =
  `INSERT INTO episodes (episode_id, owner_agent, kind, gist, real_ts, source_msg_id)
   VALUES (?, ?, ?, ?, ?, ?)`;

describe("scanDanglingMessages (§18.6.3)", () => {
  it("扫描四类锚点、只降 confidence/清 accuracy、不碰 status/mastery，检索/自省只审计", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-role-dangling-"));
    const roleDb = openRoleDb(join(tmp, "role-agent.db"));
    let meshDb: Database.Database | undefined;

    try {
      const insertEp = roleDb.db.prepare<[string, string, string, string, string, string | null]>(INSERT_EPISODE);
      insertEp.run("ep-1", "alice", "event", "gist-1", "2026-01-01T00:00:00.000Z", "msg-1");
      insertEp.run("ep-2", "alice", "event", "gist-2", "2026-01-02T00:00:00.000Z", "msg-2");
      insertEp.run("ep-3", "alice", "event", "gist-3", "2026-01-03T00:00:00.000Z", "msg-3"); // 悬挂
      insertEp.run("ep-4", "alice", "event", "gist-4", "2026-01-04T00:00:00.000Z", null); // 缺锚点

      // R32：知识 / 检索 / 自省同类锚点（§18.6.3 末尾清单）。
      roleDb.db
        .prepare(
          `INSERT INTO knowledge_items (kn_id, owner_agent, topic, claim, mastery, source_msg_id, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, 'heard', ?, ?, ?)`,
        )
        .run("kn-1", "alice", "topic-1", "claim-1", "msg-kn", "2026-01-05T00:00:00.000Z", "2026-01-05T00:00:00.000Z"); // 悬挂
      roleDb.db
        .prepare(
          `INSERT INTO retrieval_log (retrieval_id, owner_agent, trigger_msg_id, real_ts)
           VALUES (?, ?, ?, ?)`,
        )
        .run("ret-1", "alice", "msg-ret", "2026-01-06T00:00:00.000Z"); // 悬挂
      roleDb.db
        .prepare(
          `INSERT INTO reflections (reflection_id, owner_agent, trigger, reflect_msg_id, result_msg_id, started_at)
           VALUES (?, 'alice', 'manual', ?, ?, ?)`,
        )
        .run("ref-1", "msg-ref", null, "2026-01-07T00:00:00.000Z"); // reflect 悬挂
      roleDb.db
        .prepare(
          `INSERT INTO reflections (reflection_id, owner_agent, trigger, reflect_msg_id, result_msg_id, started_at)
           VALUES (?, 'alice', 'manual', ?, ?, ?)`,
        )
        .run("ref-2", "msg-2", "msg-res", "2026-01-08T00:00:00.000Z"); // result 悬挂（reflect 存活）

      // R33：注册一个 role 映射（mesh_account_id 非空）+ 配对标识，使配对成立、扫描照常走。
      roleDb.db
        .prepare(
          `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at, mesh_account_id)
           VALUES ('alice','role','/b','h1','active','2026-01-01T00:00:00.000Z','acct-alice')`,
        )
        .run();
      installRolePairing(roleDb.db);

      // DB-B：最小 mesh 替身，只放回两个 msg id。
      meshDb = new Database(join(tmp, "mesh.db"));
      meshDb.exec("CREATE TABLE mesh_messages (id TEXT PRIMARY KEY)");
      const insertMsg = meshDb.prepare("INSERT INTO mesh_messages (id) VALUES (?)");
      insertMsg.run("msg-1");
      insertMsg.run("msg-2");
      addMeshAnchor(meshDb); // R33：锚点账号，配对成立
      meshDb.close();
      meshDb = undefined;

      const res = scanDanglingMessages(roleDb.db, join(tmp, "mesh.db"));

      // 四类覆盖：episode×3 锚 + knowledge×1 + retrieval×1 + reflect×2 + result×1。
      expect(res.scanned).toBe(8);
      expect(res.skippedNoAnchor).toBe(2); // ep-4(source NULL) + ref-1(result NULL)
      expect(res.byKind).toEqual({ episode: 1, knowledge: 1, retrieval: 1, reflection: 2 });
      expect(res.marked).toBe(2); // episode + knowledge 各降一次 confidence
      expect(res.audited).toBe(5); // 每一条悬挂锚点一条审计
      expect(res.dangling).toEqual([
        { kind: "episode", targetId: "ep-3", column: "source_msg_id", anchorId: "msg-3", ownerAgent: "alice" },
        { kind: "knowledge", targetId: "kn-1", column: "source_msg_id", anchorId: "msg-kn", ownerAgent: "alice" },
        { kind: "retrieval", targetId: "ret-1", column: "trigger_msg_id", anchorId: "msg-ret", ownerAgent: "alice" },
        { kind: "reflection", targetId: "ref-1", column: "reflect_msg_id", anchorId: "msg-ref", ownerAgent: "alice" },
        { kind: "reflection", targetId: "ref-2", column: "result_msg_id", anchorId: "msg-res", ownerAgent: "alice" },
      ]);

      // episode：降 confidence + 清 accuracy。
      const ep3 = roleDb.db
        .prepare<[string], { confidence: number; accuracy: number | null }>(
          "SELECT confidence, accuracy FROM episodes WHERE episode_id = ?",
        )
        .get("ep-3")!;
      expect(ep3.confidence).toBeCloseTo(0.4);
      expect(ep3.accuracy).toBeNull();
      const ep1 = roleDb.db
        .prepare<[string], { confidence: number; accuracy: number | null }>(
          "SELECT confidence, accuracy FROM episodes WHERE episode_id = ?",
        )
        .get("ep-1")!;
      expect(ep1.confidence).toBeCloseTo(0.5);

      // knowledge：降 confidence，mastery 不被动（不碰状态机）。
      const kn1 = roleDb.db
        .prepare<[string], { confidence: number; mastery: string }>(
          "SELECT confidence, mastery FROM knowledge_items WHERE kn_id = ?",
        )
        .get("kn-1")!;
      expect(kn1.confidence).toBeCloseTo(0.4);
      expect(kn1.mastery).toBe("heard");

      // reflection：只审计，status 不被悬挂检测改写。
      const ref1 = roleDb.db
        .prepare<[string], { status: string }>("SELECT status FROM reflections WHERE reflection_id = ?")
        .get("ref-1")!;
      const ref2 = roleDb.db
        .prepare<[string], { status: string }>("SELECT status FROM reflections WHERE reflection_id = ?")
        .get("ref-2")!;
      expect(ref1.status).toBe("done");
      expect(ref2.status).toBe("done");

      const writes = roleDb.db
        .prepare("SELECT target, target_id, op, reason, actor FROM state_writes WHERE reason = 'source_msg_missing' ORDER BY target, target_id")
        .all() as Array<{ target: string; target_id: string; op: string; reason: string; actor: string }>;
      expect(writes).toHaveLength(5);
      expect(writes.map((w) => w.target)).toEqual(["episode", "knowledge", "reflection", "reflection", "retrieval"]);
      expect(writes.every((w) => w.op === "evidence_lost" && w.reason === "source_msg_missing" && w.actor === "MemoryService")).toBe(true);
    } finally {
      try {
        meshDb?.close();
      } catch {
        /* already closed */
      }
      try {
        roleDb.close();
      } catch {
        /* noop */
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("degrades to zero dangling when the mesh db is missing (B2, no throw)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-role-dangling-miss-"));
    const roleDb = openRoleDb(join(tmp, "role-agent.db"));

    try {
      roleDb.db
        .prepare<[string, string, string, string, string, string]>(INSERT_EPISODE)
        .run("ep-1", "alice", "event", "gist-1", "2026-01-01T00:00:00.000Z", "msg-1");

      const res = scanDanglingMessages(roleDb.db, join(tmp, "no-such-mesh.db"));

      expect(res.scanned).toBe(1);
      expect(res.dangling).toHaveLength(0);
      expect(res.marked).toBe(0);
    } finally {
      try {
        roleDb.close();
      } catch {
        /* noop */
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});