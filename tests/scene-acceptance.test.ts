// ═══════════════════════════════════════════════════════════════════════════
// P2 · 场景编排端到端（§7）——多 Agent 课堂：点名循环 / 虚拟时钟 / abort→resume 无损
//
// 全程走公开门面 rt.scenes（create/run/resume/close），底层是 FakeStreamPort（无 LLM，
// cue 同步回吐 consumed）。断言落在三处：SceneEstablished 内存结果 / mesh 消息史（cue 序列）
// / DB-A 的 scenes 行（turn_count / virtual_now / status）。
//
// 点名序（round_robin）与 floor 策略槽共用同一「有 speak 权」座次 speakerCandidates，
// = [moderator, ...其余非 observer]，故标准 3 人课堂轮转 = teacher→stu1→stu2→teacher…。
// observer 只有 read cap，永远不该出现在任何 cue 的 to 里（A1：无 speak 永不唤醒）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";
import type { CostRecord } from "../src/runtime/types.js";
import { createRoleAgent, writeRoleBlueprint } from "./helpers/role-agents.js";

interface SceneTest {
  rt: RuntimeInternals;
  dir: string;
  teacher: { accountId: string };
  stu1: { accountId: string };
  stu2: { accountId: string };
  obs: { accountId: string };
}

async function setup(
  fake?: {
    streamPort?: boolean;
    sessions?: boolean;
    usageForTurn?: (sceneId: string, addressee: string, turn: number) => number;
  },
  onCost?: (c: CostRecord) => void,
): Promise<SceneTest> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-scene-"));
  const rt = (await createRuntimeInternals({
    root: dir,
    db: join(dir, "role-agent.db"),
    devMode: true,
    fake: { streamPort: true, ...fake },
    onCost,
  })) as RuntimeInternals;
  // R30/G4 devMode 关场校验跑 A1「owner_agent 命中 agents 行」——故四人全部走公开
  // agents.create（而非 P0 后门 registerAgent，后门不落 agents 行 → A1 恒命中）。
  const blueprint = writeRoleBlueprint(dir, "role");
  const teacher = await createRoleAgent(rt, blueprint, "teacher", "王老师");
  const stu1 = await createRoleAgent(rt, blueprint, "stu1", "刘明涛");
  const stu2 = await createRoleAgent(rt, blueprint, "stu2", "李小红");
  const obs = await createRoleAgent(rt, blueprint, "obs", "旁听");
  return { rt, dir, teacher, stu1, stu2, obs };
}

/** 读 DB-A 的 scenes 行（编曲器的领域权威，mesh 不存）。 */
function readScene(dir: string, sceneId: string) {
  const db = new Database(join(dir, "role-agent.db"), { readonly: true });
  const row = db
    .prepare(
      `SELECT scene_id, conversation_id, host_account_id, floor_mode, virtual_start, virtual_now,
              turn_count, token_spent, status FROM scenes WHERE scene_id = ?`,
    )
    .get(sceneId) as
    | { scene_id: string; conversation_id: string; host_account_id: string | null; floor_mode: string; virtual_start: string; virtual_now: string; turn_count: number; token_spent: number; status: string }
    | undefined;
  db.close();
  return row;
}

describe("P2 scene orchestration (§7)", () => {
  it("create → run(max_turns) → 点名序 round_robin + 虚拟时钟推进 + 轮次落库", async () => {
    const { rt, dir, teacher, stu1, stu2, obs } = await setup();
    try {
      // ① 建档：teacher + 2 学生 + 1 旁听（observer），round_robin 6 轮
      const est = await rt.scenes.create({
        sceneId: "s1",
        name: "语文课·第1周",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
          { agentId: "stu2", role: "student" },
          { agentId: "obs", role: "observer" },
        ],
        floorMode: "round_robin",
        maxTurns: 6,
      });
      expect(est.sceneId).toBe("s1");
      expect(est.conversationId).toBeTruthy();
      expect(est.floorMode).toBe("round_robin");
      expect(est.participants).toHaveLength(4);
      // observer 被收窄为 read-only（§3.3）
      const obsEst = est.participants.find((p) => p.agentId === "obs");
      expect(obsEst?.caps).toEqual(["read"]);

      // ② 跑 6 轮 → max_turns 熔断
      const res = await rt.scenes.run("s1", undefined, { maxTurns: 6 });
      expect(res.stopReason).toBe("max_turns");
      expect(res.turnsCompleted).toBe(6);
      expect(res.queueClearedDetected).toBe(false);

      // ③ DB-A：turn_count=6，虚拟钟从 W1D1T8 走 6 小时（默认 60min/轮 → 1 虚拟小时）
      const row = readScene(dir, "s1");
      expect(row?.turn_count).toBe(6);
      expect(row?.virtual_start).toBe("W1D1T8");
      expect(row?.virtual_now).toBe("W1D1T14");
      expect(row?.status).toBe("active"); // max_turns 不是终态，可续跑

      // ④ mesh 消息史：6 条 cue（kind=system 且 to 恰一人），round_robin 轮转，observer 永不点名
      const msgs = await rt.mesh.observer.messages({ conversationId: est.conversationId, kind: "system" });
      const cues = msgs.filter((m) => Array.isArray(m.to) && m.to.length === 1);
      expect(cues).toHaveLength(6);
      const order = [teacher.accountId, stu1.accountId, stu2.accountId, teacher.accountId, stu1.accountId, stu2.accountId];
      expect(cues.map((m) => m.to![0])).toEqual(order);
      expect(cues.map((m) => m.to![0])).not.toContain(obs.accountId);
    } finally {
      await rt.close();
    }
  });

  it("abort 停在轮次边界 → status 保持 active → resume 无损续跑", async () => {
    const { rt, dir } = await setup();
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
          { agentId: "stu2", role: "student" },
        ],
        floorMode: "round_robin",
      });

      // 跑到一半 abort（H04：只停新 cue，不取消在途，也不清队列）
      const ac = new AbortController();
      const p = rt.scenes.run("s1", ac.signal, { maxTurns: 100000 });
      setTimeout(() => ac.abort(), 5);
      const res = await p;
      expect(res.stopReason).toBe("aborted");
      expect(res.turnsCompleted).toBeGreaterThan(0);
      expect(res.turnsCompleted).toBeLessThan(100000);
      expect(res.queueClearedDetected).toBe(false); // H04：abort 只停新 cue，不触发 queue_cleared

      // abort 后场景仍是 active（§7.5/§7.6：signal abort ≠ 场景异常），resume 能接上
      const afterAbort = readScene(dir, "s1");
      expect(afterAbort?.status).toBe("active");
      expect(afterAbort?.turn_count).toBe(res.turnsCompleted);

      // resume 从当前 turn_count 接着跑 2 轮
      const res2 = await rt.scenes.resume("s1", undefined, { maxTurns: 2 });
      expect(res2.stopReason).toBe("max_turns");
      expect(res2.turnsCompleted).toBe(2);
      const afterResume = readScene(dir, "s1");
      expect(afterResume?.turn_count).toBe(res.turnsCompleted + 2);
    } finally {
      await rt.close();
    }
  });

  it("close 收尾 status='ended'、Q01 收敛后解散群会话（一场景一群）", async () => {
    const { rt, dir, teacher } = await setup();
    try {
      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "director",
        maxTurns: 3,
      });
      await rt.scenes.run("s1", undefined, { maxTurns: 3 });

      const closed = await rt.scenes.close("s1");
      expect(closed.stopReason).toBe("closed");
      expect(closed.turnsCompleted).toBe(3);
      // Q01：close 走 stop→converge→dissolve，成功解散；无降级留痕。
      expect(closed.dissolved).toBe(true);
      expect(closed.degradeTrace).toEqual([]);
      // R30/G4：devMode 关场校验 A1–A11 全绿，无违例落 degradeTrace。
      expect(closed.invariantViolations).toEqual([]);

      const row = readScene(dir, "s1");
      expect(row?.status).toBe("ended");
      expect(row?.turn_count).toBe(3);

      // 会话已被 dissolve（Q01「一场景一群，收敛后解散」）：teacher 视角 state=archived。
      const convs = await rt.mesh.observer.conversationsOf(teacher.accountId);
      const stillThere = convs.find((c) => c.conversationId === est.conversationId);
      expect(stillThere).toBeTruthy();
      expect(stillThere?.state).toBe("archived");
    } finally {
      await rt.close();
    }
  });

  it("A04：role:'host' 参与者只当会场创建者（creator），不当 system cue 发送者——cue from 恒为 @system", async () => {
    const { rt, dir, teacher, stu1 } = await setup();
    try {
      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "host" }, // 角色账号：initiate 只有 chat/task/event，无 system
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
      });
      await rt.scenes.run("s1", undefined, { maxTurns: 2 });

      const msgs = await rt.mesh.observer.messages({ conversationId: est.conversationId, kind: "system" });
      const cues = msgs.filter((m) => Array.isArray(m.to) && m.to.length === 1);
      expect(cues).toHaveLength(2);
      // 普通角色不可发 system：cue 的 from 必须是合法 host（@system），绝不是 role:'host' 的角色账号。
      expect(cues.every((m) => m.from === "@system")).toBe(true);
      expect(cues.map((m) => m.from)).not.toContain(teacher.accountId);
      // 但 role:'host' 仍是会话创建者（creator 持 CAP）。
      expect(readScene(dir, "s1")?.host_account_id).toBeNull();
    } finally {
      await rt.close();
    }
  });

  it("A18：create 尊重并落库 hostAccountId / conversationId；已绑定会话的复用被明确拒绝", async () => {
    const { rt, dir, teacher, stu1 } = await setup();
    try {
      // ① hostAccountId 落库，不再静默丢弃。
      const est1 = await rt.scenes.create({
        sceneId: "s1",
        hostAccountId: "@system",
        participants: [{ agentId: "teacher", role: "teacher" }],
        floorMode: "director",
      });
      expect(readScene(dir, "s1")?.host_account_id).toBe("@system");

      // ② conversationId：尊重已有 group（复用而非新建）。
      const conv = await rt.mesh.createConversation({
        type: "group",
        creator: teacher.accountId,
        members: [teacher.accountId, stu1.accountId],
      });
      const est2 = await rt.scenes.create({
        sceneId: "s2",
        conversationId: conv.id,
        participants: [{ agentId: "teacher", role: "teacher" }],
        floorMode: "director",
      });
      expect(est2.conversationId).toBe(conv.id);
      expect(readScene(dir, "s2")?.conversation_id).toBe(conv.id);

      // ③ 复用已绑定另一场景的会话 → 明确拒绝（ux_scenes_conversation 一对一契约）。
      await expect(
        rt.scenes.create({
          sceneId: "s3",
          conversationId: est1.conversationId,
          participants: [{ agentId: "teacher", role: "teacher" }],
        }),
      ).rejects.toThrow(/already bound to another scene/);
    } finally {
      await rt.close();
    }
  });

  it("A08：drive 进行中并发 close（标 ended）后，不再发新 cue、不再推进轮次", async () => {
    const { rt, dir } = await setup();
    try {
      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
          { agentId: "stu2", role: "student" },
        ],
        floorMode: "round_robin",
      });

      const runP = rt.scenes.run("s1", undefined, { maxTurns: 100000 });
      // A06 起每轮跨 macrotask（cue → 等 consumed → 推进），给足完成若干轮的余量再并发 close。
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await rt.scenes.close("s1");
      const res = await runP;

      expect(res.stopReason).toBe("closed");
      expect(res.turnsCompleted).toBeGreaterThanOrEqual(1);
      expect(res.turnsCompleted).toBeLessThan(100000);

      const row = readScene(dir, "s1");
      expect(row?.status).toBe("ended");
      // 关键不变量：turn_count === 实际完成的轮数，没有「close 之后仍推进」的多余推进写。
      expect(row?.turn_count).toBe(res.turnsCompleted);
      // close 期间可能有**一条** cue 已发出、正在等 consumed（在途，并未推进轮次）；其余
      // 已完成的轮次 cue 数 == 完成轮数。close 之后绝不新发 cue → 消息数 ∈ [完成轮数, 完成轮数+1]。
      const msgs = await rt.mesh.observer.messages({ conversationId: est.conversationId, kind: "system" });
      const cueCount = msgs.filter((m) => Array.isArray(m.to) && m.to.length === 1).length;
      expect(cueCount).toBeGreaterThanOrEqual(res.turnsCompleted);
      expect(cueCount).toBeLessThanOrEqual(res.turnsCompleted + 1);
    } finally {
      await rt.close();
    }
  });

  it("A09：30 分钟轮长整分钟推进（无浮点字面量，resume 可无损续跑）", async () => {
    const { rt, dir } = await setup();
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
          { agentId: "stu2", role: "student" },
        ],
        floorMode: "round_robin",
        turnDurationMinutes: 30,
      });

      const res = await rt.scenes.run("s1", undefined, { maxTurns: 3 });
      expect(res.stopReason).toBe("max_turns");

      // W1D1T8 + 3 × 30min = W1D1T9:30（整分钟，无 `W1D1T8.5` 浮点格式）。
      expect(readScene(dir, "s1")?.virtual_now).toBe("W1D1T9:30");

      // resume 不再被坏时间卡住：再 1 轮 → W1D1T10（整点省略分钟缀）。
      const res2 = await rt.scenes.resume("s1", undefined, { maxTurns: 1 });
      expect(res2.stopReason).toBe("max_turns");
      expect(readScene(dir, "s1")?.virtual_now).toBe("W1D1T10");
    } finally {
      await rt.close();
    }
  });

  it("A19：场景位置账本——cue 前写被点名者所在场景/轮次/虚拟时间，close 后清除", async () => {
    const { rt, teacher, stu1, stu2 } = await setup();
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
          { agentId: "stu2", role: "student" },
        ],
        floorMode: "round_robin",
      });

      // 建档即把全员纳入账本（turn 0、虚拟起点 W1D1T8）。
      expect(rt.sceneExt.extFor(teacher.accountId)).toMatchObject({ sceneId: "s1", turn: 0, virtualTs: "W1D1T8" });

      // 3 轮轮转：ext 描述「何时」而非「谁」——每轮整个会场归位到本轮统一位置，跑完后
      // 全员停在最后一轮（turn 3 · W1D1T10）的统一位置，而不是各自被点名那棒的历史值。
      await rt.scenes.run("s1", undefined, { maxTurns: 3 });
      expect(rt.sceneExt.extFor(teacher.accountId)).toMatchObject({ sceneId: "s1", turn: 3, virtualTs: "W1D1T10" });
      expect(rt.sceneExt.extFor(stu1.accountId)).toMatchObject({ sceneId: "s1", turn: 3, virtualTs: "W1D1T10" });
      expect(rt.sceneExt.extFor(stu2.accountId)).toMatchObject({ sceneId: "s1", turn: 3, virtualTs: "W1D1T10" });

      // close 后全员从账本移除 → extProvider 退 {}（非场景事件无 sceneId）。
      await rt.scenes.close("s1");
      expect(rt.sceneExt.extFor(teacher.accountId)).toBeUndefined();
      expect(rt.sceneExt.extFor(stu1.accountId)).toBeUndefined();
      expect(rt.sceneExt.extFor(stu2.accountId)).toBeUndefined();
    } finally {
      await rt.close();
    }
  });

  it("A19：resume/恢复入账——即使本轮零推进，也在 drive 起点把全员归位到当前边界", async () => {
    const { rt, teacher, stu1, stu2 } = await setup();
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
          { agentId: "stu2", role: "student" },
        ],
        floorMode: "round_robin",
      });
      await rt.scenes.run("s1", undefined, { maxTurns: 2 }); // turn_count=2, virtual_now=W1D1T10

      // 模拟重启：内存账本归零（sceneExt 是进程内存，不持久化）。
      rt.sceneExt.remove(teacher.accountId);
      rt.sceneExt.remove(stu1.accountId);
      rt.sceneExt.remove(stu2.accountId);
      expect(rt.sceneExt.extFor(stu2.accountId)).toBeUndefined();

      // resume 立即熔断（maxTurns=0）：零轮推进，但 drive 起点已把全员重新归位到当前边界。
      const res = await rt.scenes.resume("s1", undefined, { maxTurns: 0 });
      expect(res.turnsCompleted).toBe(0);
      expect(rt.sceneExt.extFor(teacher.accountId)).toMatchObject({ sceneId: "s1", turn: 2 });
      expect(rt.sceneExt.extFor(stu1.accountId)).toMatchObject({ sceneId: "s1", turn: 2 });
      expect(rt.sceneExt.extFor(stu2.accountId)).toMatchObject({ sceneId: "s1", turn: 2 });
    } finally {
      await rt.close();
    }
  });

  it("A07：token 用量不再恒 0——注入用量源后累计落库、预算熔断生效", async () => {
    // 注入假用量源（每轮 100 token）；真实 pi usage 回调仍待 M01/M02 后端迁移后接线。
    const { rt, dir } = await setup({ usageForTurn: () => 100 });
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
        tokenBudget: 250,
      });

      const res = await rt.scenes.run("s1", undefined, { maxTurns: 1000 });
      // 每轮 +100：第 3 轮后 300 >= 250 → 预算熔断（而非打满 maxTurns）。
      expect(res.stopReason).toBe("budget");
      expect(res.turnsCompleted).toBe(3);
      expect(readScene(dir, "s1")?.token_spent).toBe(300);
    } finally {
      await rt.close();
    }
  });

  it("A07/onCost：每轮真实用量经 onCost 上抛一条 dialogue 成本记录（agentId/sceneId/tokens 分账）", async () => {
    const costs: CostRecord[] = [];
    const { rt, dir } = await setup({ usageForTurn: () => 100 }, (c) => costs.push(c));
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
      });

      await rt.scenes.run("s1", undefined, { maxTurns: 3 });

      // 每完成一轮推进一条记录；round_robin 依次点名 teacher/stu1/teacher（3 轮）。
      expect(costs).toHaveLength(3);
      for (const c of costs) {
        expect(c.source).toBe("dialogue");
        expect(c.sceneId).toBe("s1");
        // usageForTurn 只给增量总额、无 input/output 拆分 → 记入 output 分账。
        expect(c.tokensOut).toBe(100);
        expect(new Date(c.at).getTime()).not.toBeNaN();
      }
      // 点名序：第 1/3 轮 teacher，第 2 轮 stu1。
      expect(costs.map((c) => c.agentId)).toEqual(["teacher", "stu1", "teacher"]);
    } finally {
      await rt.close();
    }
  });

  it("A07：未注入用量源时每轮 delta=0，tokenBudget 不误触发（P2 无 LLM 语义保持）", async () => {
    const { rt, dir } = await setup();
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
        tokenBudget: 1, // 即使预算极小，没有用量源也永不进熔断
      });

      const res = await rt.scenes.run("s1", undefined, { maxTurns: 3 });
      expect(res.stopReason).toBe("max_turns");
      expect(res.turnsCompleted).toBe(3);
      expect(readScene(dir, "s1")?.token_spent).toBe(0);
    } finally {
      await rt.close();
    }
  });

  it("A07/R13：本次 run 限与场景总限分开——opts.tokenBudget 只限本轮，不误判场景累计", async () => {
    const { rt, dir } = await setup({ usageForTurn: () => 100 });
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
        tokenBudget: 1000, // 场景总限高，本轮 run 限才是 150
      });

      // 本次 run 临时收窄到 150：第 2 轮后 runSpent=200 >= 150 → 本轮熔断。
      const res = await rt.scenes.run("s1", undefined, { maxTurns: 1000, tokenBudget: 150 });
      expect(res.stopReason).toBe("budget");
      expect(res.turnsCompleted).toBe(2);
      expect(res.tokensThisRun).toBe(200);
      expect(res.tokensCumulative).toBe(200); // 场景累计尚未到 1000
      expect(readScene(dir, "s1")?.token_spent).toBe(200);

      // 再 resume 不带 run 限：场景总限 1000 未到，正常继续，受 maxTurns 控制。
      const res2 = await rt.scenes.resume("s1", undefined, { maxTurns: 3 });
      expect(res2.stopReason).toBe("max_turns");
      expect(res2.tokensThisRun).toBe(300); // 100*3
      expect(res2.tokensCumulative).toBe(500); // 200 累计 + 300 本轮
      expect(readScene(dir, "s1")?.token_spent).toBe(500);
    } finally {
      await rt.close();
    }
  });
});