// ═══════════════════════════════════════════════════════════════════════════
// O02 · 完整 director 剧本（§7.2 扩展）
//
// director 缺省只是基础轮转；剧本给出显式有序点名：顺序、条件（角色名/逐步资格校验）、
// 恢复位置（turn_count 派生的绝对轮次）、失败边界（上线校验 + 非 loop 播完 idle）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";
import { ValidationError } from "../src/runtime/errors.js";
import { createRoleAgent, writeRoleBlueprint } from "./helpers/role-agents.js";

async function setup(): Promise<{ rt: RuntimeInternals; dir: string; teacher: { accountId: string }; stu1: { accountId: string }; stu2: { accountId: string }; obs: { accountId: string } }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-o02-"));
  const rt = (await createRuntimeInternals({
    root: dir,
    db: join(dir, "role-agent.db"),
    devMode: true,
    fake: { streamPort: true },
  })) as RuntimeInternals;
  const blueprint = writeRoleBlueprint(dir, "role");
  const teacher = await createRoleAgent(rt, blueprint, "teacher", "王老师");
  const stu1 = await createRoleAgent(rt, blueprint, "stu1", "刘明涛");
  const stu2 = await createRoleAgent(rt, blueprint, "stu2", "李小红");
  const obs = await createRoleAgent(rt, blueprint, "obs", "旁听");
  return { rt, dir, teacher, stu1, stu2, obs };
}

async function cueOrder(rt: RuntimeInternals, conversationId: string): Promise<string[]> {
  const msgs = await rt.mesh.observer.messages({ conversationId, kind: "system" });
  return msgs.filter((m) => Array.isArray(m.to) && m.to.length === 1).map((m) => m.to![0]!);
}

describe("O02 完整 director 剧本", () => {
  it("按剧本顺序点名 + 逐条文本覆盖", async () => {
    const { rt, teacher, stu1, stu2 } = await setup();
    try {
      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
          { agentId: "stu2", role: "student" },
        ],
        floorMode: "director",
        script: {
          steps: [
            { target: "teacher", text: "王老师开讲" },
            { target: "stu2", text: "李小红先答" },
            { target: "stu1", text: "刘明涛后答" },
          ],
        },
      });

      const res = await rt.scenes.run("s1", undefined, { maxTurns: 3 });
      expect(res.stopReason).toBe("max_turns");
      expect(await cueOrder(rt, est.conversationId)).toEqual([teacher.accountId, stu2.accountId, stu1.accountId]);
    } finally {
      await rt.close();
    }
  });

  it("role 目标：条件式点名「第一个该角色参与者」", async () => {
    const { rt, stu1 } = await setup();
    try {
      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
          { agentId: "stu2", role: "student" },
        ],
        floorMode: "director",
        script: { steps: [{ target: "student" }] }, // 第一个 student = stu1
      });
      const res = await rt.scenes.run("s1", undefined, { maxTurns: 1 });
      expect(res.stopReason).toBe("max_turns");
      expect(await cueOrder(rt, est.conversationId)).toEqual([stu1.accountId]);
    } finally {
      await rt.close();
    }
  });

  it("loop：播完回绕；非 loop：播完 idle（失败边界）", async () => {
    const { rt } = await setup();
    try {
      const loopEst = await rt.scenes.create({
        sceneId: "loop",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "director",
        script: { steps: [{ target: "teacher" }, { target: "stu1" }], loop: true },
      });
      const loopRes = await rt.scenes.run("loop", undefined, { maxTurns: 5 });
      expect(loopRes.turnsCompleted).toBe(5); // loop 永不 idle

      const endEst = await rt.scenes.create({
        sceneId: "end",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "director",
        script: { steps: [{ target: "teacher" }, { target: "stu1" }] },
      });
      const endRes = await rt.scenes.run("end", undefined, { maxTurns: 5 });
      expect(endRes.stopReason).toBe("idle"); // 非 loop 播完即 idle
      expect(endRes.turnsCompleted).toBe(2);
    } finally {
      await rt.close();
    }
  });

  it("恢复位置：pause → resume 从停点剧本行续上", async () => {
    const { rt, teacher, stu1 } = await setup();
    try {
      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "director",
        script: { steps: [{ target: "teacher" }, { target: "stu1" }], loop: true },
      });
      await rt.scenes.run("s1", undefined, { maxTurns: 1 }); // teacher
      await rt.scenes.pause("s1");
      await rt.scenes.resume("s1", undefined, { maxTurns: 2 }); // stu1 → teacher
      expect(await cueOrder(rt, est.conversationId)).toEqual([teacher.accountId, stu1.accountId, teacher.accountId]);
    } finally {
      await rt.close();
    }
  });

  it("失败边界：未知目标 / observer 目标在建档即拒绝", async () => {
    const { rt } = await setup();
    try {
      await expect(
        rt.scenes.create({
          sceneId: "s1",
          participants: [
            { agentId: "teacher", role: "teacher" },
            { agentId: "stu1", role: "student" },
          ],
          floorMode: "director",
          script: { steps: [{ target: "ghost" }] },
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        rt.scenes.create({
          sceneId: "s2",
          participants: [
            { agentId: "teacher", role: "teacher" },
            { agentId: "obs", role: "observer" },
          ],
          floorMode: "director",
          script: { steps: [{ target: "obs" }] },
        }),
      ).rejects.toThrow(ValidationError);
    } finally {
      await rt.close();
    }
  });
});