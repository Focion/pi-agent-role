// ═══════════════════════════════════════════════════════════════════════════
// R16 / Q02 · 场景收场日终（§15.5 / Q02）—— 通过 scenes.close 触发一次幂等日终
//
// 验证四点：
//   1. close 走「收敛在途 → 日终 → 解散」：dissolved=true、无降级留痕；
//   2. 日终四阶段落 agent_state 台账（key `day_end:<virtualDay>`，同角色同虚拟日唯一）；
//   3. 分档：无情节 → light（只衰减）；有 active 情节 → full（发自省 cue）；
//   4. 幂等：同角色同虚拟日重复触发 alreadyDone=true、不重跑、不重复落库。
//
// 断言落在 DB-A 的 agent_state 台账 + 公开门面 rt.scenes.close() 的 SceneRunResult。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import { virtualDayOf, virtualHoursOf } from "../src/runtime/virtual-clock.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";
import { createRoleAgent, writeRoleBlueprint } from "./helpers/role-agents.js";

interface DayEndTest {
  rt: RuntimeInternals;
  dir: string;
}

async function setup(): Promise<DayEndTest> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-dayend-"));
  const rt = (await createRuntimeInternals({
    root: dir,
    db: join(dir, "role-agent.db"),
    devMode: true,
    fake: { streamPort: true },
  })) as RuntimeInternals;
  return { rt, dir };
}

/** 读 DB-A 的日终台账（agent_state 里 key 前缀 `day_end:` 的行，按 agent_id 排序）。 */
function readDayEndLedger(dir: string): Array<{ agent_id: string; key: string; value_json: string }> {
  const db = new Database(join(dir, "role-agent.db"), { readonly: true });
  const rows = db
    .prepare(`SELECT agent_id, key, value_json FROM agent_state WHERE key LIKE 'day_end:%' ORDER BY agent_id`)
    .all() as Array<{ agent_id: string; key: string; value_json: string }>;
  db.close();
  return rows;
}

/** 直接物化一条 active 情节到 DB-A（构造 full 档自省的证据；等价于真实对话里的 remember）。 */
function seedEpisode(dir: string, agentId: string, id: string, virtualTs: string): void {
  const db = new Database(join(dir, "role-agent.db"));
  db.prepare(
    `INSERT INTO episodes (episode_id, owner_agent, kind, gist, virtual_ts, virtual_hours, real_ts, salience, retention, status)
     VALUES (?, ?, 'fact', ?, ?, ?, '2026-11-07T00:00:00.000Z', 0.9, 0.9, 'active')`,
  ).run(id, agentId, "测试知识点：牛顿第二定律", virtualTs, virtualHoursOf(virtualTs));
  db.close();
}

/** 日终 target 虚拟时刻（默认虚拟起点 W1D1T8 + 2 轮 × 60min = W1D1T10）。 */
const CLOSE_TS = "W1D1T10";

describe("R16 day-end orchestration (close → day-end → dissolve)", () => {
  it("close 触发日终：无情节 → light 分档，台账落唯一 key，幂等重复触发不重跑", async () => {
    const { rt, dir } = await setup();
    try {
      const blueprint = writeRoleBlueprint(dir, "role");
      await createRoleAgent(rt, blueprint, "teacher", "王老师");
      await createRoleAgent(rt, blueprint, "stu1", "刘明涛");

      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "director",
        maxTurns: 2,
      });
      await rt.scenes.run("s1", undefined, { maxTurns: 2 }); // virtual_now = W1D1T10

      const closed = await rt.scenes.close("s1");
      // Q01/R16：close 收敛后成功解散，日终无降级留痕。
      expect(closed.dissolved).toBe(true);
      expect(closed.degradeTrace).toEqual([]);
      // R30/G4：devMode 关场校验 A1–A11 全绿（角色均经 agents.create，owner_agent 命中 agents 行）。
      expect(closed.invariantViolations).toEqual([]);

      // 台账：teacher / stu1 各自在本虚拟日完成一次日终，key 同前缀同虚拟日。
      const expectDay = virtualDayOf(CLOSE_TS);
      expect(rt.dayEnd.hasRun("teacher", CLOSE_TS)).toBe(true);
      expect(rt.dayEnd.hasRun("stu1", CLOSE_TS)).toBe(true);
      const ledger = readDayEndLedger(dir);
      expect(ledger.map((r) => r.agent_id).sort()).toEqual(["stu1", "teacher"]);
      expect(ledger.every((r) => r.key === `day_end:${expectDay}`)).toBe(true);
      // 无 active 情节 → scene_end 分档 light（只衰减，不发自省 cue）。
      expect(ledger.map((r) => JSON.parse(r.value_json).depth)).toEqual(["light", "light"]);

      // 幂等（Q02「同角色同虚拟日去重」「恢复不重复日终」）：再触发同虚拟日全数 alreadyDone。
      const again = await rt.dayEnd.runForScene({
        sceneId: "s1",
        agentIds: ["teacher", "stu1"],
        virtualTs: CLOSE_TS,
      });
      expect(again.virtualDay).toBe(expectDay);
      expect(again.ran).toHaveLength(2);
      expect(again.ran.every((r) => r.alreadyDone === true && r.depth === "skip")).toBe(true);
      expect(again.ran.every((r) => r.memoryDecayed === 0 && r.knowledgeDecayed === 0)).toBe(true);
      // 台账仍只有两行，未重复落库。
      expect(readDayEndLedger(dir)).toHaveLength(2);
    } finally {
      await rt.close();
    }
  });

  it("有 active 情节 → full 分档：日终发自省 cue、衰减扫到该情节、无降级", async () => {
    const { rt, dir } = await setup();
    try {
      // teacher / stu1 均经 agents.create 注册（含自省流账号），owner_agent 命中 agents 行。
      const blueprint = writeRoleBlueprint(dir, "role");
      await createRoleAgent(rt, blueprint, "teacher", "王老师");
      await createRoleAgent(rt, blueprint, "stu1", "刘明涛");

      // 日终前给 teacher 物化一条 active 情节（virtual_hours == 收场 virtual_now，衰减不越档）。
      seedEpisode(dir, "teacher", "ep-seed-1", CLOSE_TS);

      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "director",
        maxTurns: 2,
      });
      await rt.scenes.run("s1", undefined, { maxTurns: 2 });

      const closed = await rt.scenes.close("s1");
      // full 档自省 cue 成功发送 → teacher 无降级；stu1 无情节 light，也不降级。
      expect(closed.dissolved).toBe(true);
      expect(closed.degradeTrace).toEqual([]);
      expect(closed.invariantViolations).toEqual([]);

      const ledger = readDayEndLedger(dir);
      const byAgent = new Map(ledger.map((r) => [r.agent_id, JSON.parse(r.value_json)]));
      // teacher：full（有 active 情节）+ 衰减扫到 1 条；stu1：light（无情节）。
      expect(byAgent.get("teacher")).toMatchObject({ depth: "full", memoryDecayed: 1 });
      expect(byAgent.get("stu1")).toMatchObject({ depth: "light", memoryDecayed: 0 });
      // 自省 cue 已落 reflections 行（running，未收敛）—— 证明 full 档真的发了 cue 而非只在内存态。
      const db = new Database(join(dir, "role-agent.db"), { readonly: true });
      const refls = db
        .prepare(`SELECT COUNT(*) AS n FROM reflections WHERE owner_agent = 'teacher' AND trigger = 'scene_end'`)
        .get() as { n: number };
      db.close();
      expect(refls.n).toBe(1);
    } finally {
      await rt.close();
    }
  });

  it("运行/恢复路径不做日终也不解散——只有 close 走「日终→解散」末段", async () => {
    const { rt, dir, } = await setup();
    try {
      const blueprint = writeRoleBlueprint(dir, "role");
      await createRoleAgent(rt, blueprint, "teacher", "王老师");
      const teacher = { accountId: "teacher" };
      await createRoleAgent(rt, blueprint, "stu1", "刘明涛");

      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "director",
        maxTurns: 2,
      });
      // run 到 max_turns 熔断：不是 close 路径 → 不解散、不跑日终。
      const res = await rt.scenes.run("s1", undefined, { maxTurns: 2 });
      expect(res.dissolved).toBe(false);
      expect(rt.dayEnd.hasRun("teacher", CLOSE_TS)).toBe(false);
      expect(readDayEndLedger(dir)).toHaveLength(0);

      // resume 到 max_turns 熔断：同样不解散、不再日终。
      const res2 = await rt.scenes.resume("s1", undefined, { maxTurns: 1 });
      expect(res2.dissolved).toBe(false);
      expect(readDayEndLedger(dir)).toHaveLength(0);

      // 会话仍 active（未被 dissolve），teacher 视角 state=active。
      const convs = await rt.mesh.observer.conversationsOf(teacher.accountId);
      const stillThere = convs.find((c) => c.conversationId === est.conversationId);
      expect(stillThere?.state).toBe("active");
    } finally {
      await rt.close();
    }
  });
});