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

const INSERT_EPISODE =
  `INSERT INTO episodes (episode_id, owner_agent, kind, gist, real_ts, source_msg_id)
   VALUES (?, ?, ?, ?, ?, ?)`;

describe("scanDanglingMessages (§18.6.3)", () => {
  it("marks the dangling row, writes evidence_lost audit, leaves the rest untouched", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-role-dangling-"));
    const roleDb = openRoleDb(join(tmp, "role-agent.db"));
    let meshDb: Database.Database | undefined;

    try {
      const insert = roleDb.db.prepare<[string, string, string, string, string, string | null]>(INSERT_EPISODE);
      insert.run("ep-1", "alice", "event", "gist-1", "2026-01-01T00:00:00.000Z", "msg-1");
      insert.run("ep-2", "alice", "event", "gist-2", "2026-01-02T00:00:00.000Z", "msg-2");
      insert.run("ep-3", "alice", "event", "gist-3", "2026-01-03T00:00:00.000Z", "msg-3"); // 悬挂
      insert.run("ep-4", "alice", "event", "gist-4", "2026-01-04T00:00:00.000Z", null); // 缺锚点

      // DB-B：最小 mesh 替身，只放回前两个 msg id。
      meshDb = new Database(join(tmp, "mesh.db"));
      meshDb.exec("CREATE TABLE mesh_messages (id TEXT PRIMARY KEY)");
      const insertMsg = meshDb.prepare("INSERT INTO mesh_messages (id) VALUES (?)");
      insertMsg.run("msg-1");
      insertMsg.run("msg-2");
      meshDb.close();
      meshDb = undefined;

      const res = scanDanglingMessages(roleDb.db, join(tmp, "mesh.db"));

      expect(res.scanned).toBe(3);
      expect(res.skippedDueToMissingAnchors).toBe(1);
      expect(res.dangling).toEqual([{ episodeId: "ep-3", sourceMsgId: "msg-3" }]);
      expect(res.marked).toBe(1);

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
      expect(ep1.accuracy).toBeNull();

      const writes = roleDb.db
        .prepare("SELECT target_id, op, reason, actor FROM state_writes WHERE reason = 'source_msg_missing'")
        .all();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        target_id: "ep-3",
        op: "evidence_lost",
        reason: "source_msg_missing",
        actor: "MemoryService",
      });
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