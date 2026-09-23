// ═══════════════════════════════════════════════════════════════════════════
// T5 组：隔离与安全（§21.3.5）—— 最高 ROI 子集
//
// 覆盖：
//   T5.4  reflect_result 只在自省流挂载（工具面分叉 §3.8）
//   T5.4  领域工具 10 件封闭、跨三类流恰好一覆盖（封闭分划）
//   T5.4  reflect 流无 mesh_send（initiate:[] 不对外发言，§3.4）
//   T5.10 策略槽（src/mesh/policies/**）不读 ext 标识符（C10 / R5 互补）
//
// 分层纪律：本文件不 import @pi/agent-mesh（R1）；工具面表格是静态权威，不触真模型。
// ═══════════════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_WHITELIST,
  DOMAIN_TOOL_NAMES,
  DOMAIN_TOOLS_BY_KIND,
  domainToolsFor,
} from "../../src/mesh/tools.js";
import { makeSessionFactory, toolSurfaceKey } from "../../src/mesh/session-factory.js";
import type { AccountKind } from "../../src/mesh/tools.js";

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

describe("T5 isolation / security (§21.3.5)", () => {
  it("T5.4: reflect_result exists only in the reflect stream's domain tools", () => {
    expect(DOMAIN_TOOLS_BY_KIND.reflect).toEqual(["reflect_result"]);
    expect(DOMAIN_TOOLS_BY_KIND.role).not.toContain("reflect_result");
    expect(DOMAIN_TOOLS_BY_KIND.facility).not.toContain("reflect_result");

    // 经 domainToolsFor 走一遍：reflect 流只挂 reflect_result
    expect(domainToolsFor("reflect").map((t) => t.name)).toEqual(["reflect_result"]);
    expect(domainToolsFor("role").map((t) => t.name)).not.toContain("reflect_result");
    expect(domainToolsFor("facility").map((t) => t.name)).not.toContain("reflect_result");
  });

  it("T5.4: reflect stream carries no mesh builtins — cannot speak (initiate:[], §3.4)", () => {
    expect(BUILTIN_WHITELIST.reflect).toEqual([]);
    // 对话/设施流有 mesh_send；自省流没有
    expect(BUILTIN_WHITELIST.role).toContain("mesh_send");
    expect(BUILTIN_WHITELIST.facility).toContain("mesh_send");
  });

  it("T5.4: the 10 domain tools form a closed partition across the three streams", () => {
    const kinds: AccountKind[] = ["role", "facility", "reflect"];
    const union = kinds.flatMap((k) => DOMAIN_TOOLS_BY_KIND[k]);

    // 集合相等（每件恰好注册一次，无跨流重复）
    expect([...union].sort()).toEqual([...DOMAIN_TOOL_NAMES].sort());
    expect(new Set(union).size).toBe(DOMAIN_TOOL_NAMES.length);
    // 权威清单也是 10 件封闭
    expect(DOMAIN_TOOL_NAMES).toHaveLength(10);
  });

  it("T5.4: factory-level — reflect account surfaces only reflect_result (exactly one tool)", async () => {
    const captured: { surface?: string } = {};
    const sf = makeSessionFactory({
      classify: (id) => (id === "alice:reflect" ? "reflect" : "role"),
      backend: {
        async create(ctx) {
          captured.surface = toolSurfaceKey(ctx.tools);
          return { session: {}, piSessionId: "p1" };
        },
        async open(ctx) {
          captured.surface = toolSurfaceKey(ctx.tools);
          return { session: {} };
        },
      },
    });

    const reflectCtx = { account: { id: "alice:reflect" as string }, endpoint: { id: "ep-r" }, tools: ALL_BUILTINS };
    await sf.create(reflectCtx as never);
    // reflect 流：mesh 内建全被滤掉，只剩领域工具 reflect_result。
    expect(captured.surface).toBe("reflect_result");
  });

  it("T5.10: policy slots (src/mesh/policies/**) never reference the `ext` identifier", () => {
    const policiesDir = fileURLToPath(new URL("../../src/mesh/policies", import.meta.url));
    const files = readdirSync(policiesDir).filter((f) => f.endsWith(".ts")).sort();
    expect(files.length).toBeGreaterThanOrEqual(1);

    // 与 check-imports R5 同形的「标识符级」扫描：先剥注释再匹配 \bext\b。
    for (const f of files) {
      const src = readFileSync(join(policiesDir, f), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(/\bext\b/.test(code), `${f} reads ext identifier`).toBe(false);
    }
  });
});