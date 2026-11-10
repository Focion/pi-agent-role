// ═══════════════════════════════════════════════════════════════════════════
// M02 faux provider：记录型 pi-durable 集成校验（M01/M02 语义对等，非类型层）
//
// 覆盖：
//   M02-1  记忆/学习队列卡片作为 durable 端 UserMessage（role:"user" + 字符串 content）
//          经 GenerationHooks.beforeRequest last-append 到达模型（真实注入内容校验）；
//   M02-weak  system prompt（AgentChange.instructions）进入模型请求（system 段）；
//   M01     create 装配出真实 Harness/root、storage.sqlite 落盘、runtimeRef 编解码往返；
//   M02-2   toBeforeCompactEvent 把 durable EntryRecord（kind + data.envelopeId + model 首条
//           user 消息）归一为本环 branchEntries；extractRoleMessages 按 kind==="mesh.msg" 提炼。
//
// 说明：pi-ai 的 fauxProvider 是官方测试替身，无需真模型/真凭据；它记录模型收到的
// request.messages（经 beforeRequest 修改后的最终形态），据此断言「记忆卡片已以合法
// UserMessage 注入链尾」。beforeCompact 由真实压缩触发（难以小规模制造 context 溢出），
// 故其映射 + 提炼语义用纯函数单元覆盖（M02-2），不冒称已过真实压缩。
// ═══════════════════════════════════════════════════════════════════════════

// 卫兵顺序：pi-ai 顶层运行值经动态 import 延迟到本模块 body 之后（clipboard 原生模块），
// 故 TERMUX_VERSION 须在任何 pi import 之前就绪；这里先于动态装载点设置。
process.env.TERMUX_VERSION ??= "1";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPiBackend,
  toBeforeCompactEvent,
  type PiAgentBinding,
} from "../src/mesh/pi-backend.js";
import { extractRoleMessages } from "../src/runtime/runtime.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempdir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pi-role-faux-"));
  tmpDirs.push(d);
  return d;
}

/** durable 会话句柄的最小形状（assemble 返回的实际对象）。 */
interface DurableSession {
  ctx: unknown;
  root: {
    id: number;
    submit(draft: unknown, ctx: unknown): Promise<unknown>;
    waitForIdle(ctx: unknown): Promise<void>;
  };
  close(): Promise<void>;
}

/** 惰性装载 pi-ai faux 运行值（卫兵之后）。 */
async function loadFauxProviders() {
  const piai = await import("@earendil-works/pi-ai");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  return { piai, createModels };
}

describe("pi-backend faux provider（M02 记录型校验）", () => {
  it("M02-1: 记忆卡片以 UserMessage 注入 beforeRequest 链尾，且 system prompt 到达模型", async () => {
    const dir = await tempdir();
    const { piai, createModels } = await loadFauxProviders();

    const faux = piai.fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);

    const seenRequests: Array<readonly unknown[]> = [];
    // FauxResponseFactory：记录模型最终收到的 messages（beforeRequest 修改后的结果）。
    faux.setResponses([
      (context: { messages: readonly unknown[] }) => {
        seenRequests.push(context.messages);
        return piai.fauxAssistantMessage("ok");
      },
    ]);

    const binding: PiAgentBinding = {
      identityDir: join(dir, "identity"),
      sessionsDir: join(dir, "sessions"),
      systemPrompt: "SYSTEM PROMPT ⟨m02-marker⟩",
      provider: faux.provider.name,
      modelId: faux.getModel().id,
      thinkingLevel: "off",
    };

    const backend = createPiBackend({
      resolveBinding: () => binding,
      modelsFor: () => models,
      contextHookFor: () => async (event) => {
        const existing = ((event.messages as unknown[]) ?? []);
        const card = { role: "user", content: "MEMORY CARD ⟨m02-marker⟩", timestamp: Date.now() };
        return { messages: [...existing, card] };
      },
    });

    const ctx = { account: { id: "alice" }, endpoint: { id: "ep-1" }, tools: [] };
    const created = await backend.create(ctx as never);
    const session = created.session as DurableSession;

    // 起一轮真实 durable 生成（faux 应答）→ beforeRequest 应被触发一次以上。
    await session.root.submit(
      { type: "input", content: "hello", entry: { kind: "test.msg", data: { envelopeId: "env-1" } } },
      session.ctx,
    );
    await session.root.waitForIdle(session.ctx);
    await session.close();

    expect(seenRequests.length).toBeGreaterThan(0);
    const msgs = seenRequests[seenRequests.length - 1] as Array<{ role?: string; content?: unknown }>;

    // M02-1 核心：记忆卡片是合法的 pi-ai UserMessage（role:"user" + 字符串 content），且在链尾。
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe("user");
    expect(typeof last?.content).toBe("string");
    expect(last?.content).toContain("MEMORY CARD ⟨m02-marker⟩");

    // M02-weak：system prompt（instructions）进入了模型请求的 system 段（rendered 在
    // SystemMessage.sections.instructions，content 为 ""，见 pi-ai SystemMessage 形状）。
    const systemMsg = msgs.find((m) => m.role === "system") as { sections?: { instructions?: string } } | undefined;
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.sections?.instructions ?? "").toContain("SYSTEM PROMPT ⟨m02-marker⟩");
  });

  it("M01: runtimeRef 编解码往返 + create/open 重开同一会话", async () => {
    const dir = await tempdir();
    const { piai, createModels } = await loadFauxProviders();

    const faux = piai.fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([piai.fauxAssistantMessage("ok")]);

    const binding: PiAgentBinding = {
      identityDir: join(dir, "identity"),
      sessionsDir: join(dir, "sessions"),
      systemPrompt: "system",
      provider: faux.provider.name,
      modelId: faux.getModel().id,
      thinkingLevel: "off",
    };
    const backend = createPiBackend({ resolveBinding: () => binding, modelsFor: () => models });

    const ctx = { account: { id: "bob" }, endpoint: { id: "ep-2" }, tools: [] };
    const created = await backend.create(ctx as never);
    const createdSession = created.session as DurableSession;

    // runtimeRef 是 `{storagePath, conversationId}` 的 JSON 编码（MD7 不透明串）。
    const payload = JSON.parse(created.runtimeRef) as { storagePath: string; conversationId: number };
    expect(payload.conversationId).toBe(createdSession.root.id);
    expect(payload.storagePath).toContain("storage.sqlite");

    // open 用同一 runtimeRef 重开：同一会话（root id 不变，历史仍在）。
    const opened = await backend.open({ ...ctx, runtimeRef: created.runtimeRef } as never);
    const openedSession = opened.session as DurableSession;
    expect(openedSession.root.id).toBe(createdSession.root.id);

    await createdSession.close();
    await openedSession.close();
  });

  it("M02-2: toBeforeCompactEvent + extractRoleMessages 按 durable kind 提炼角色消息", () => {
    // 构造 durable compaction 载荷：entry.model 首条 user 消息是原文，data.envelopeId 是 H2 去重键。
    const event = toBeforeCompactEvent({
      reason: "threshold",
      entries: [
        {
          id: 10,
          kind: "mesh.msg",
          data: { envelopeId: "env-alpha" },
          model: [{ role: "user", content: "老师问：受力分析", timestamp: 1 }],
        },
        {
          id: 11,
          kind: "mesh.nudge",
          model: [{ role: "user", content: "nudge 不是角色消息", timestamp: 2 }],
        },
        {
          id: 12,
          kind: "tool",
          data: { envelopeId: "ignored" },
          model: [{ role: "tool", content: "工具结果", timestamp: 3 }],
        },
        {
          id: 13,
          kind: "mesh.msg",
          data: {}, // 无 envelopeId → 兜底用条目 id
          model: [{ role: "assistant", content: "跳过非 user" }, { role: "user", content: "学生回应", timestamp: 4 }],
        },
      ],
    });

    expect(event.type).toBe("session_before_compact");
    expect(event.reason).toBe("threshold");
    expect(event.branchEntries).toHaveLength(4);

    const msgs = extractRoleMessages(event);
    expect(msgs).toEqual([
      { msgId: "env-alpha", text: "老师问：受力分析" },
      { msgId: "13", text: "学生回应" },
    ]);
  });

  it("M02-2: 无 mesh.msg 条目时 extractRoleMessages 提炼零条（§15.4 no-op）", () => {
    const event = toBeforeCompactEvent({
      reason: "manual",
      entries: [{ id: 1, kind: "mesh.nudge", model: [{ role: "user", content: "cue", timestamp: 1 }] }],
    });
    expect(event.reason).toBe("manual");
    expect(extractRoleMessages(event)).toEqual([]);
  });

  it("A07: usageBreakdownFor 回读 harness.usage 累计 usage（σ models+tools 桶，跨轮单调递增）", async () => {
    const dir = await tempdir();
    const { piai, createModels } = await loadFauxProviders();

    const faux = piai.fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);

    // faux 同步响应（"ok" → 每次 output 1 token：pi-ai 按真实码流重算 usage，
    // 不以我们在 assistant message 上注入的自定义 usage 为准，故不在此断言具体 token 数）。
    faux.setResponses([piai.fauxAssistantMessage("ok"), piai.fauxAssistantMessage("ok")]);

    const binding: PiAgentBinding = {
      identityDir: join(dir, "identity"),
      sessionsDir: join(dir, "sessions"),
      systemPrompt: "system",
      provider: faux.provider.name,
      modelId: faux.getModel().id,
      thinkingLevel: "off",
    };
    const backend = createPiBackend({ resolveBinding: () => binding, modelsFor: () => models });

    const ctx = { account: { id: "carol" }, endpoint: { id: "ep-3" }, tools: [] };
    const created = await backend.create(ctx as never);
    const session = created.session as DurableSession & {
      harness: {
        usage(c: unknown): Promise<{
          models: Record<string, { input?: number; output?: number; totalTokens?: number }>;
          tools: Record<string, { input?: number; output?: number; totalTokens?: number }>;
        }>;
      };
    };

    // 直接读 harness.usage 并按同口径（σ models+tools 各桶 input/output/totalTokens）算真值对照。
    const raw = async (): Promise<{ tokensIn: number; tokensOut: number; totalTokens: number }> => {
      const st = await session.harness.usage(session.ctx);
      let tokensIn = 0;
      let tokensOut = 0;
      let totalTokens = 0;
      for (const bucket of [st.models, st.tools]) {
        for (const k of Object.keys(bucket)) {
          const u = bucket[k];
          tokensIn += u?.input ?? 0;
          tokensOut += u?.output ?? 0;
          totalTokens += u?.totalTokens ?? 0;
        }
      }
      return { tokensIn, tokensOut, totalTokens };
    };

    try {
      await session.root.submit(
        { type: "input", content: "t1", entry: { kind: "test.msg", data: { envelopeId: "env-t1" } } },
        session.ctx,
      );
      await session.root.waitForIdle(session.ctx);
      const first = await backend.usageBreakdownFor("carol");
      expect(first).toEqual(await raw()); // 回读口径 = harness.usage 的 σ 桶（三字段逐一对齐）
      expect(first.totalTokens).toBeGreaterThan(0);
      expect(first.tokensOut).toBeGreaterThan(0); // faux 必有真实 output

      await session.root.submit(
        { type: "input", content: "t2", entry: { kind: "test.msg", data: { envelopeId: "env-t2" } } },
        session.ctx,
      );
      await session.root.waitForIdle(session.ctx);
      const second = await backend.usageBreakdownFor("carol");
      expect(second.totalTokens).toBeGreaterThan(first.totalTokens); // 跨轮累计单调递增
      expect(second).toEqual(await raw());

      // 未知账号 / 未装配会话 → 全 0（不抛，供场景降级）。
      await expect(backend.usageBreakdownFor("nobody")).resolves.toEqual({ tokensIn: 0, tokensOut: 0, totalTokens: 0 });
    } finally {
      await session.close();
    }
  });
});