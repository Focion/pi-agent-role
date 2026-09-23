// ═══════════════════════════════════════════════════════════════════════════
// T1 组：上下文链尾（§21.3.1）—— I23 守卫 + create/open 等价
//
// 覆盖：
//   I23 / T1.1  记忆卡片 context 钩子经 `unshift` 前置注册（在 mesh 链尾 context 钩子之前）
//   T1.1        角色钩子扩展路径恒定 `pi-agent-role:role-hooks`
//   守卫 ①③     create 与 open 走同一 assembleTools → 工具面等价（回放核对要求）
//
// 说明：registerHookExtension 是 pi-backend 私有函数、且仅经 pi SDK 触达（真模型/真 SDK
// 在必过集禁入）。I23 的「前置」事实是结构性的，故用源码扫描锁住（同 R4/R5 门禁哲学），
// 并另以 makeSessionFactory 的功能路径验证 create/open 同源。
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
  it("T1.1: role context-hook extension is prepended via `exts.unshift` (not `push`)", () => {
    const f = fileURLToPath(new URL("../../src/mesh/pi-backend.ts", import.meta.url));
    const src = readFileSync(f, "utf8");
    // I23：角色记忆卡片钩子必须在 mesh 的 context 钩子（数组更靠后）之前 → 用 unshift 前置。
    expect(/\bexts\.unshift\s*\(/.test(src)).toBe(true);
    // 不得用 push 追加（那会把角色钩子放到链尾之后，破坏 I23 顺序）。
    expect(/\bexts\.push\s*\(/.test(src)).toBe(false);
  });

  it("T1.1: role hooks extension path is stable `pi-agent-role:role-hooks`", () => {
    const f = fileURLToPath(new URL("../../src/mesh/pi-backend.ts", import.meta.url));
    const src = readFileSync(f, "utf8");
    expect(src).toContain('path: "pi-agent-role:role-hooks"');
  });

  it("T1.1: create and open assemble the identical tool surface (guard ①③)", async () => {
    const captured = { create: "", open: "" };
    const sf = makeSessionFactory({
      classify: (id) => (id === "alice" ? "role" : "facility"),
      backend: {
        async create(ctx) {
          captured.create = toolSurfaceKey(ctx.tools);
          return { session: {}, piSessionId: "p1" };
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