// ═══════════════════════════════════════════════════════════════════════════
// P0 冒烟（§23.2 第一条关键路径 / §25.1）：
//   createRuntime（公开唯一入口）→ agents.create() 注册 2 个角色 Agent
//   → direct 互发 10 条 → 全部到达 consumed
//   → checkInvariants 全绿（A1–A11 实装，P6） + 双库无 mesh_ 表污染。
//
// 全程走 createMesh 的 fake 链路（FakeStreamPort + 假 SessionFactory），无 LLM。
// 与 mesh 自己的 tests/e2e/acceptance.test.ts 同构：direct 任何消息都醒（§7.3 规则②），
// FakeStreamPort.deliver 同步回吐 entry，triggerTurn 经 queueMicrotask 回吐 turn_end，
// 断言前必须 flush 一个宏任务。
//
// 注：`RuntimeInternals`（mesh/registry）是 P0 测试后门；P6.4 契约测试禁止再 import
// 本处内部路径。P6 起 agents.create() 是正式路径（写 agents 表满足 A1 不变量）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import { stringifyYaml } from "../src/compile/yaml.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** 写一个最小身份蓝本（满足 §5.1 冷启动校验），供 agents.create() 使用。 */
function writeBlueprint(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const files: [string, unknown][] = [
    [
      "manifest.yaml",
      {
        identity: { id: "id-min" },
        files: ["manifest", "personal", "constraints", "evolution", "narrative_voice", "agent_protocol"].map(
          (n) => ({ path: `${n}.yaml`, priority: "cold_start" }),
        ),
      },
    ],
    ["personal.yaml", { name: { full: "Test" }, age: 20, gender: "female", role: "tester" }],
    ["constraints.yaml", { constraints: [] }],
    ["evolution.yaml", { mood: "neutral", moodIntensity: 0.5, energy: 0.8 }],
    ["narrative_voice.yaml", { default_mode: "neutral" }],
    ["agent_protocol.yaml", { capabilities: [], initiate: ["chat"] }],
  ];
  for (const [name, data] of files) writeFileSync(join(dir, name), stringifyYaml(data));
}

describe("P0 smoke (§25.1): two role agents exchange 10 messages", () => {
  it("all consumed + invariants clean + no mesh_ tables in DB-A", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-p0-"));
    writeBlueprint(join(dir, "templates", "minimal"));

    const rt = (await createRuntimeInternals({
      root: dir,
      db: join(dir, "role-agent.db"),
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;

    try {
      // ① agents.create() 注册 2 个角色 Agent（P1 路径：写 agents 表 + mesh 注册）
      const aliceResult = await rt.agents.create({
        blueprint: join(dir, "templates", "minimal"),
        agentId: "alice",
      });
      const bobResult = await rt.agents.create({
        blueprint: join(dir, "templates", "minimal"),
        agentId: "bob",
      });
      expect(aliceResult.mesh.accountId).not.toBe(bobResult.mesh.accountId);

      // ② 设为 available（避开 A2 缺席不唤醒），建 direct 会话
      await rt.mesh.setPresence(aliceResult.mesh.accountId, "available");
      await rt.mesh.setPresence(bobResult.mesh.accountId, "available");
      const conv = await rt.mesh.ensureDirect(aliceResult.mesh.accountId, bobResult.mesh.accountId);

      // ③ 互发 10 条 kind:"chat" / expect:"none"
      const messageIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const from = i % 2 === 0 ? aliceResult.mesh.accountId : bobResult.mesh.accountId;
        const r = await rt.mesh.send({
          from,
          conversationId: conv.id,
          kind: "chat",
          expect: "none",
          text: `hello ${i}`,
        });
        messageIds.push(r.messageId);
      }
      await flush();

      // ④ 每条只投给对端，且全部 consumed
      const states: string[] = [];
      for (const id of messageIds) {
        const traces = await rt.mesh.observer.trace(id);
        expect(traces).toHaveLength(1);
        states.push(traces[0]!.state);
      }
      expect(states).toHaveLength(10);
      expect(states.every((s) => s === "consumed")).toBe(true);

      // ⑤ mesh 不变量全绿 + 本环 A1–A11 不变量全绿（P6 实装）
      const report = await rt.inspect.checkInvariants();
      expect(report.mesh.violations).toEqual([]);
      expect(report.role.ok).toBe(true);
    } finally {
      await rt.close();
    }
  });
});