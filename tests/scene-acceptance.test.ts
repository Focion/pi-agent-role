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

import { createRuntime } from "../src/index.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";

interface SceneTest {
  rt: RuntimeInternals;
  dir: string;
  teacher: { accountId: string };
  stu1: { accountId: string };
  stu2: { accountId: string };
  obs: { accountId: string };
}

async function setup(): Promise<SceneTest> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-scene-"));
  const rt = (await createRuntime({
    root: dir,
    db: join(dir, "role-agent.db"),
    devMode: true,
    fake: { streamPort: true },
  })) as RuntimeInternals;
  const teacher = await rt.registerAgent({ agentId: "teacher", agentType: "role", displayName: "王老师" });
  const stu1 = await rt.registerAgent({ agentId: "stu1", agentType: "role", displayName: "刘明涛" });
  const stu2 = await rt.registerAgent({ agentId: "stu2", agentType: "role", displayName: "李小红" });
  const obs = await rt.registerAgent({ agentId: "obs", agentType: "role", displayName: "旁听" });
  return { rt, dir, teacher, stu1, stu2, obs };
}

/** 读 DB-A 的 scenes 行（编曲器的领域权威，mesh 不存）。 */
function readScene(dir: string, sceneId: string) {
  const db = new Database(join(dir, "role-agent.db"), { readonly: true });
  const row = db
    .prepare(
      `SELECT scene_id, conversation_id, floor_mode, virtual_start, virtual_now,
              turn_count, token_spent, status FROM scenes WHERE scene_id = ?`,
    )
    .get(sceneId) as
    | { scene_id: string; conversation_id: string; floor_mode: string; virtual_start: string; virtual_now: string; turn_count: number; token_spent: number; status: string }
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

      // 跑到一半 abort（走 beforeClearQueue 无损回退，绝不清队列）
      const ac = new AbortController();
      const p = rt.scenes.run("s1", ac.signal, { maxTurns: 100000 });
      setTimeout(() => ac.abort(), 5);
      const res = await p;
      expect(res.stopReason).toBe("aborted");
      expect(res.turnsCompleted).toBeGreaterThan(0);
      expect(res.turnsCompleted).toBeLessThan(100000);
      expect(res.queueClearedDetected).toBe(false); // I22：abort 走 beforeClearQueue，不清队列

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

  it("close 收尾 status='ended'、不解散会话（一个会话可承载多周次）", async () => {
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

      const row = readScene(dir, "s1");
      expect(row?.status).toBe("ended");
      expect(row?.turn_count).toBe(3);

      // 会话未被 dissolve（§3.3 / C10）：teacher 视角仍能看到这个 group，state 仍 active。
      const convs = await rt.mesh.observer.conversationsOf(teacher.accountId);
      const stillThere = convs.find((c) => c.conversationId === est.conversationId);
      expect(stillThere).toBeTruthy();
      expect(stillThere?.state).toBe("active");
    } finally {
      await rt.close();
    }
  });
});