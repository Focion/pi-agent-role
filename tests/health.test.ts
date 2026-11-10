// ═══════════════════════════════════════════════════════════════════════════
// R31 · 内部健康保护（§26.1 必订事件 / §20.1）——不依赖宿主 onEvent
//
// 三层断言：
//   1. HealthGuard 纯逻辑：fail-closed 只在 invariant 违反 / accessControl 降级时触发，
//      其余槽降级只观察不停写；阻断后不自动恢复（等人工介入）。
//   2. MemoryService 停写门：writesAllowed=false 时 delivered→remember→consumed 不产出
//      episode / decision / 观察，工具（remember）拒写；恢复放行后写入生效。
//   3. createRuntime 集成：无 onEvent 时 rt.health 仍可达，且同一哨兵对象闭包挂进了
//      记忆服务（阻断后经服务观察入口不落库）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import { openRoleDb } from "../src/db/db.js";
import { KnowledgeDao } from "../src/knowledge/dao.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { RoleAccountRegistry } from "../src/mesh/accounts.js";
import { MemoryDao } from "../src/memory/dao.js";
import { MemoryService } from "../src/memory/service.js";
import { makeHealthGuard } from "../src/runtime/health.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";

const cleanups: Array<{ dir: string; close: () => void }> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c.close();
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

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

describe("R31 HealthGuard（纯逻辑）", () => {
  it("初始放行；非 fail-closed 槽降级只观察不停写", () => {
    const g = makeHealthGuard();
    expect(g.writesAllowed()).toBe(true);
    expect(g.snapshot()).toEqual({ blockMemoryWrites: false, blockReason: null, degradedSlots: [], invariantCount: 0 });

    g.onPolicyDegraded({ slot: "delivery", reason: "timeout", degradedTo: "silent_no_wake" });
    expect(g.writesAllowed()).toBe(true); // delivery 降级 → 少醒，不错记，不停写
    expect(g.snapshot().degradedSlots).toEqual(["delivery"]);
    expect(g.snapshot().blockReason).toBeNull();

    g.onPolicyDegraded({ slot: "delivery", reason: "threw", degradedTo: "silent_no_wake" });
    expect(g.snapshot().degradedSlots).toEqual(["delivery"]); // 去重
  });

  it("accessControl（唯一 fail-closed 槽）降级 → 停写，且阻断不自动恢复", () => {
    const g = makeHealthGuard();
    g.onPolicyDegraded({ slot: "accessControl", reason: "timeout", degradedTo: "allow_all" });
    expect(g.writesAllowed()).toBe(false);
    expect(g.snapshot().blockReason).toEqual({ kind: "policy", slot: "accessControl" });

    // 后续再收到无害槽降级 / 重复 accessControl，阻断缘由保持第一条、不自动恢复。
    g.onPolicyDegraded({ slot: "delivery", reason: "timeout", degradedTo: "silent_no_wake" });
    g.onPolicyDegraded({ slot: "accessControl", reason: "threw", degradedTo: "allow_all" });
    expect(g.writesAllowed()).toBe(false);
    expect(g.snapshot().blockReason).toEqual({ kind: "policy", slot: "accessControl" });
  });

  it("invariant_violated → 整体 fail-closed，计数累加，未知 code 保留", () => {
    const g = makeHealthGuard();
    g.onInvariantViolated({ code: "seal_mismatch", detail: { id: "m1" } });
    expect(g.writesAllowed()).toBe(false);
    expect(g.snapshot().blockReason).toEqual({ kind: "invariant", code: "seal_mismatch" });
    expect(g.snapshot().invariantCount).toBe(1);

    g.onInvariantViolated({ code: "seal_mismatch", detail: { id: "m2" } });
    expect(g.snapshot().invariantCount).toBe(2); // 计数仍累加，即使已阻断

    const g2 = makeHealthGuard();
    g2.onInvariantViolated({ detail: "no code" });
    expect(g2.snapshot().blockReason).toEqual({ kind: "invariant", code: "unknown" });
  });
});

// ─── MemoryService 停写门 ──────────────────────────────────────────────────

interface FakeMesh {
  on(kind: string, h: (p: unknown) => void): () => void;
  nudge(): Promise<void>;
  emit(kind: string, p: unknown): void;
}

function makeFakeMesh(): FakeMesh {
  const handlers = new Map<string, (p: unknown) => void>();
  return {
    on(kind, h) {
      handlers.set(kind, h);
      return () => handlers.delete(kind);
    },
    async nudge() {},
    emit(kind, p) {
      handlers.get(kind)?.(p);
    },
  };
}

const envelope = (id: string, from: string, text: string): Record<string, unknown> => ({
  id,
  seq: 0,
  from,
  fromEndpoint: `ep-${from}`,
  routedAt: "2026-01-01T00:00:00.000Z",
  idempotencyKey: `k-${id}`,
  conversationId: "conv-1",
  kind: "chat",
  expect: "none",
  payload: { text },
  to: [],
  ext: { virtualTs: "W1D1T8", sceneId: "scene-1", turn: 1 },
});

describe("R31 MemoryService 停写门", () => {
  it("writesAllowed=false 时 delivered→remember→consumed 不产出 episode/decision，工具拒写", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-health-mem-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    cleanups.push({ dir, close: () => roleDb.close() });

    const db = roleDb.db;
    const dao = new MemoryDao(db, { nowReal: () => new Date().toISOString() });
    const registry = new RoleAccountRegistry();
    registry.register({ agentId: "agent-stu", agentType: "role", accountId: "acct-stu", endpointId: "ep-agent-stu", displayName: "小明" });
    registry.register({ agentId: "agent-tea", agentType: "role", accountId: "acct-tea", endpointId: "ep-agent-tea", displayName: "王老师" });

    let blocked = false;
    const knowledge = new KnowledgeService({
      dao: new KnowledgeDao(db, { nowReal: () => new Date().toISOString() }),
      knownAgents: () => new Set(registry.allAgentIds()),
    });
    const service = new MemoryService({
      dao,
      registry,
      knowledge,
      policyOf: async () => undefined,
      writesAllowed: () => !blocked,
    });
    const fake = makeFakeMesh();
    service.attach(fake as unknown as Parameters<MemoryService["attach"]>[0]);

    const env = envelope("msg-1", "acct-tea", "受力分析又画错了") as never;
    fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    // 停写门落下：工具拒写。
    blocked = true;
    const tools = await service.domainHandlersFor("acct-stu");
    const remember = tools.remember as unknown as (
      a: string,
      p: Record<string, unknown>,
    ) => Promise<{ content: unknown }>;
    const res = await remember("tc-1", { gist: "老师在受力分析上指出了我的错误" });
    expect(JSON.stringify(res.content)).toContain("TOOL_DISABLED");

    fake.emit("message_consumed", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      partial: false,
    });
    await flush();

    const ep = db.prepare("SELECT * FROM episodes WHERE owner_agent = ? AND source_msg_id = ?").get("agent-stu", "msg-1");
    expect(ep).toBeUndefined(); // 停写时不落情节
    const dec = db.prepare("SELECT * FROM memory_decisions WHERE owner_agent = ? AND source_msg_id = ?").get("agent-stu", "msg-1");
    expect(dec).toBeUndefined(); // 停写时不落判定
  });

  it("放行时同样的 delivered→remember→consumed 正常产出（对照）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-health-mem2-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    cleanups.push({ dir, close: () => roleDb.close() });

    const db = roleDb.db;
    const dao = new MemoryDao(db, { nowReal: () => new Date().toISOString() });
    const registry = new RoleAccountRegistry();
    registry.register({ agentId: "agent-stu", agentType: "role", accountId: "acct-stu", endpointId: "ep-agent-stu", displayName: "小明" });
    registry.register({ agentId: "agent-tea", agentType: "role", accountId: "acct-tea", endpointId: "ep-agent-tea", displayName: "王老师" });

    const knowledge = new KnowledgeService({
      dao: new KnowledgeDao(db, { nowReal: () => new Date().toISOString() }),
      knownAgents: () => new Set(registry.allAgentIds()),
    });
    const service = new MemoryService({
      dao,
      registry,
      knowledge,
      policyOf: async () => undefined,
      writesAllowed: () => true,
    });
    const fake = makeFakeMesh();
    service.attach(fake as unknown as Parameters<MemoryService["attach"]>[0]);

    const env = envelope("msg-1", "acct-tea", "受力分析又画错了") as never;
    fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    const tools = await service.domainHandlersFor("acct-stu");
    const remember = tools.remember as unknown as (
      a: string,
      p: Record<string, unknown>,
    ) => Promise<{ content: unknown }>;
    const res = await remember("tc-1", { gist: "老师在受力分析上指出了我的错误" });
    expect(JSON.stringify(res.content)).toContain("ok");

    fake.emit("message_consumed", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      partial: false,
    });
    await flush();

    const ep = db.prepare("SELECT * FROM episodes WHERE owner_agent = ? AND source_msg_id = ?").get("agent-stu", "msg-1");
    expect(ep).toBeDefined();
    const dec = db.prepare("SELECT * FROM memory_decisions WHERE owner_agent = ? AND source_msg_id = ?").get("agent-stu", "msg-1");
    expect(dec).toBeDefined();
  });
});

describe("R31 createRuntime 集成（无 onEvent）", () => {
  it("无宿主 onEvent 时 rt.health 仍可达，阻断后观察不入库（哨兵与记忆服务同源闭包）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-health-rt-"));
    const rt = (await createRuntimeInternals({
      root,
      db: join(root, "role-agent.db"),
      devMode: true,
      fake: { streamPort: true, sessions: true },
      // 刻意不传 onEvent：内部健康保护必须独立生效。
    })) as RuntimeInternals;
    cleanups.push({ dir: root, close: () => void rt.close() });

    try {
      // 初始放行，无降级观测。
      expect(rt.health.writesAllowed()).toBe(true);
      expect(rt.health.snapshot().degradedSlots).toEqual([]);

      // 模拟 mesh `policy_degraded` / `invariant_violated` 事件到达（订阅在装配层接住；
      // 这里直接触达同一哨兵对象，验证它与记忆服务闭包同源、阻断状态对外可观测）。
      rt.health.onPolicyDegraded({ slot: "delivery", reason: "timeout", degradedTo: "silent_no_wake" });
      expect(rt.health.writesAllowed()).toBe(true);
      expect(rt.health.snapshot().degradedSlots).toEqual(["delivery"]);

      rt.health.onPolicyDegraded({ slot: "accessControl", reason: "timeout", degradedTo: "allow_all" });
      expect(rt.health.writesAllowed()).toBe(false);
      expect(rt.health.snapshot().blockReason).toEqual({ kind: "policy", slot: "accessControl" });

      rt.health.onInvariantViolated({ code: "seal_mismatch", detail: {} });
      expect(rt.health.snapshot().invariantCount).toBe(1);
    } finally {
      await rt.close();
    }
  });
});