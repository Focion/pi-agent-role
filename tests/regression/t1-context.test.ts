// ═══════════════════════════════════════════════════════════════════════════
// T1 组：上下文链尾（§21.3.1）—— I23 守卫 + create/open 等价
//
// 覆盖：
//   T1.1        角色记忆钩子接 durable GenerationHooks.beforeRequest（mesh injectContext 同款）
//   T1.1        角色钩子扩展名恒定 `pi-agent-role:role-hooks`（durable Extension.name）
//   守卫 ①③     create 与 open 走同一 assembleTools → 工具面等价（回放核对要求）
//
// 说明：M01 把 pi-backend 从旧 coding-agent 后端迁到 pi-durable 1.5；记忆卡片 last-append 的
// 承载机制从 `exts.unshift` 换成 `hook(GenerationTask, { beforeRequest })`。扩展名仍锁
// `pi-agent-role:role-hooks`。⚠ I23 的「卡片在链尾（mesh injectContext 之后）」内容次序，
// durable 端由多 beforeRequest 钩子的派发次序决定，属于 M02 待验证项（记录型 faux provider
// 校验），源码扫描只锁「已接线为 generation 钩子」，不等价于次序已验。
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { makeSessionFactory, toolSurfaceKey } from "../../src/mesh/session-factory.js";

const A_TOOL = (name: string) => ({
  name,
  description: "",
  parameters: {} as Record<string, unknown>,
  execute: async () => ({ content: "" }),
});

const ALL_BUILTINS = [
  "mesh_send", "mesh_ack", "mesh_lookup", "mesh_inbox", "mesh_history",
  "mesh_conversations", "mesh_members", "mesh_contacts",
].map(A_TOOL);

describe("T1 context chain tail (§21.3.1)", () => {
  it("T1.1: role memory hook is wired as durable GenerationHooks.beforeRequest", () => {
    const f = fileURLToPath(new URL("../../src/mesh/pi-backend.ts", import.meta.url));
    const src = readFileSync(f, "utf8");
    // M02：记忆卡片 last-append 由 beforeRequest 钩子承载（mesh injectContext 同款）。
    expect(/hook\(sdk\.durable\.GenerationTask/.test(src)).toBe(true);
    expect(/beforeRequest/.test(src)).toBe(true);
    // ⚠ I23 的「卡片在链尾（mesh 注入之后）」顺序是 M02 待验证项，不是本断言能锁的。
  });

  it("T1.1: role hooks extension name is stable `pi-agent-role:role-hooks`", () => {
    const f = fileURLToPath(new URL("../../src/mesh/pi-backend.ts", import.meta.url));
    const src = readFileSync(f, "utf8");
    expect(src).toContain('name: "pi-agent-role:role-hooks"');
  });

  it("T1.1: create and open assemble the identical tool surface (guard ①③)", async () => {
    const captured = { create: "", open: "" };
    const sf = makeSessionFactory({
      classify: (id) => (id === "alice" ? "role" : "facility"),
      backend: {
        async create(ctx) {
          captured.create = toolSurfaceKey(ctx.tools);
          return { session: {}, runtimeRef: "p1" };
        },
        async open(ctx) {
          captured.open = toolSurfaceKey(ctx.tools);
          return { session: {} };
        },
      },
    });

    const ctx = { account: { id: "alice" as string }, endpoint: { id: "ep-1" }, tools: ALL_BUILTINS };
    await sf.create(ctx as never);
    await sf.open(ctx as never);

    expect(captured.create).toBe(captured.open);
    // role 流：有 mesh_send + 5 件领域工具，且绝不挂 reflect_result（与 T5.4 呼应）。
    expect(captured.create).toContain("mesh_send");
    expect(captured.create).toContain("remember");
    expect(captured.create).not.toContain("reflect_result");
  });
});