// ═══════════════════════════════════════════════════════════════════════════
// R08 note_self 工具 + Runtime.memory 宿主只读门面（§12.3 / §14 / §20）
//
// 覆盖：
//   R08-NS-1 note_self 写 kind='self' 情节 + self 主体，返回 { ok }，不注入全文；
//   R08-NS-2 note_self 计入本轮写配额（P3 账），超限拒绝；
//   R08-MEM-1 memory.recall 纯读检索——不强化（rehearsal_count 不变）、不复活；
//   R08-MEM-2 memory.stats 管理视图——跨 role agent 计数汇总。
//
// 分层纪律：本文件不 import @pi/agent-mesh（R1）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { defaultMemoryPolicy, type MemoryPolicy } from "../src/compile/types.js";
import { openRoleDb, type RoleDb } from "../src/db/db.js";
import { MemoryDao } from "../src/memory/dao.js";
import { makeMemoryTools } from "../src/memory/tools.js";
import { makeMemoryApi } from "../src/memory/read-api.js";
import { freshTurnState, type TurnState } from "../src/memory/turn.js";

type SimpleTool = (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: unknown; details?: unknown }>;

const NOW = "2026-01-01T00:00:00.000Z";

function makeDao(db: RoleDb["db"]): MemoryDao {
  return new MemoryDao(db, { nowReal: () => NOW });
}

function insertEpisode(db: RoleDb["db"], dao: MemoryDao, owner: string, episodeId: string, gist: string): void {
  dao.insertEpisode({
    episodeId,
    ownerAgent: owner,
    kind: "event",
    gist,
    salience: 0.5,
    confidence: 0.8,
    virtualTs: "W1D1T1",
    virtualHours: 1,
    retention: 0.5,
    subjects: [],
  });
}

describe("note_self（R08）", () => {
  it("R08-NS-1/2: 写 self 情节 + 计写配额，返回 { ok }", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-noteself-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      const dao = makeDao(roleDb.db);
      const policy: MemoryPolicy = { ...defaultMemoryPolicy(), maxWritesPerTurn: 1 };
      const turn: TurnState = freshTurnState({
        accountId: "acct-ag",
        ownerAgent: "ag",
        policy,
        path: "P1",
        virtualTs: "W1D1T1",
        virtualHours: 1,
        sourceMsgId: "m1",
      });
      const tools = makeMemoryTools({
        dao,
        ownerAgent: "ag",
        currentTurn: () => turn,
        knownAgents: new Set(),
      });
      const note = tools.note_self as unknown as SimpleTool;
      const res = await note("c", { text: "我有点想不下去了" });
      expect(JSON.parse(String(res.content))).toEqual({ ok: true });

      const ep = roleDb.db
        .prepare("SELECT kind, gist FROM episodes WHERE owner_agent = 'ag' AND source_msg_id = 'm1'")
        .get() as { kind: string; gist: string };
      expect(ep.kind).toBe("self");
      expect(ep.gist).toBe("我有点想不下去了");
      const subject = roleDb.db
        .prepare("SELECT subject_type, subject_id FROM episode_subjects WHERE episode_id = (SELECT episode_id FROM episodes WHERE owner_agent='ag' AND source_msg_id='m1')")
        .get() as { subject_type: string; subject_id: string };
      expect(subject).toMatchObject({ subject_type: "self", subject_id: "self" });

      // P3 账：写到上限后再写被拒。
      const denied = await note("c", { text: "第二条" });
      expect(JSON.parse(String(denied.content)).error.code).toBe("TOOL_DISABLED");
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Runtime.memory 只读门面（R08）", () => {
  it("R08-MEM-1: recall 纯读不强化", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-memread-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      const dao = makeDao(roleDb.db);
      insertEpisode(roleDb.db, dao, "ag", "ep1", "喜欢解数学难题");
      insertEpisode(roleDb.db, dao, "ag", "ep2", "讨厌排队");
      const api = makeMemoryApi(roleDb.db, dao);

      const res = await api.recall("ag", "数学难题");
      expect(res.ownerAgent).toBe("ag");
      expect(res.items.length).toBeGreaterThanOrEqual(1);
      expect(res.items[0]!.gist).toBe("喜欢解数学难题");

      // 不强化：rehearsal_count 保持 0。
      const row = roleDb.db
        .prepare("SELECT rehearsal_count FROM episodes WHERE episode_id = 'ep1'")
        .get() as { rehearsal_count: number };
      expect(row.rehearsal_count).toBe(0);
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R08-MEM-2: stats 管理视图跨 agent 汇总", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-memstats-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      const db = roleDb.db;
      for (const [id, type] of [["ag", "role"], ["bob", "role"]] as const) {
        db.prepare(
          `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at)
           VALUES (?, ?, '/b', ?, 'active', ?)`,
        ).run(id, type, "0".repeat(64), NOW);
      }
      const dao = makeDao(db);
      insertEpisode(db, dao, "ag", "ep-a1", "第一件件事");
      insertEpisode(db, dao, "ag", "ep-a2", "第二件件事");
      insertEpisode(db, dao, "bob", "ep-b1", "第三件件事");
      const api = makeMemoryApi(db, dao);

      const stats = await api.stats();
      const byId = new Map(stats.agents.map((a) => [a.agentId, a]));
      expect([...byId.keys()].sort()).toEqual(["ag", "bob"]);
      expect(byId.get("ag")!.episodes).toBe(2);
      expect(byId.get("bob")!.episodes).toBe(1);
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});