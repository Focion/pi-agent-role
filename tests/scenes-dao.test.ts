// ═══════════════════════════════════════════════════════════════════════════
// scenes 表 DAO 回归（A17）—— listActive 的 SQL 缺 SELECT 会直接 prepare 失败
//
// 直接驱动 ScenesDao（真实 DB-A DDL），锁定：建档、按会话反查、推进、终止与活跃列表。
// A17 最初发现 listActive 拼出 `${SELECT_COLS} FROM scenes ...`（少 SELECT 关键字），
// 任何一次 resume 巡检调用都会语法报错。这里把该入口真跑一遍。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openRoleDb, type RoleDb } from "../src/db/db.js";
import { ScenesDao } from "../src/scene/scenes-dao.js";
import type { NewSceneInput } from "../src/scene/types.js";

function inp(sceneId: string): NewSceneInput {
  return {
    sceneId,
    name: null,
    facilityId: null,
    facilityJson: null,
    conversationId: null,
    floorMode: null,
    convBoundAt: null,
    virtualStart: "W1D1T8",
    virtualNow: "W1D1T8",
    participants: [],
    turnPolicy: null,
    tokenBudget: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const cleanups: Array<{ dir: string; roleDb: RoleDb }> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c.roleDb.close();
    } catch {
      /* noop */
    }
    try {
      rmSync(c.dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

describe("ScenesDao（§18.3 / A17）", () => {
  it("listActive 只列 active 场景（SQL 含 SELECT，可正常 prepare + 执行）", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-scenes-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    cleanups.push({ dir, roleDb });
    const dao = new ScenesDao(roleDb.db);

    dao.insert(inp("s1"));
    dao.insert(inp("s2"));
    dao.end("s2", "ended", "2026-01-01T00:01:00.000Z");

    const active = dao.listActive();
    expect(active.map((s) => s.sceneId)).toEqual(["s1"]);
  });

  it("insert → get / getByConversation / advance / end 往返一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-scenes-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    cleanups.push({ dir, roleDb });
    const dao = new ScenesDao(roleDb.db);

    dao.insert({ ...inp("s1"), conversationId: "conv-1" });
    expect(dao.get("s1")?.sceneId).toBe("s1");
    expect(dao.getByConversation("conv-1")?.sceneId).toBe("s1");

    const adv = dao.advance("s1", "W1D1T9", 3);
    expect(adv).toMatchObject({ turnCount: 1, tokenSpent: 3 });

    dao.end("s1", "aborted", "2026-01-01T00:02:00.000Z");
    expect(dao.get("s1")?.status).toBe("aborted");
    expect(dao.listActive()).toEqual([]);
  });
});