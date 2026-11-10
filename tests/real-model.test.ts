// ═══════════════════════════════════════════════════════════════════════════
// 真实模型端到端冒烟（R06「真实用量」/ R13「真实消费」的底座验证）
//
// 把一个 OpenAI 兼容的自定义 provider（demo.config.json 里的 QwenAPI）经
// `createPiBackend` 的 credentialFor（baseUrl + api + api_key）装配进 pi-ai 目录，
// 确认真实 HTTP 生成能回来，并捕获到非零 usage。这是 R05/R06/R13/R17/R22/R34
// 以及 T1/DIF08 真实模型验收链的「模型真的能被拨通」前提。
//
// 卫兵：设置 `PI_ROLE_REAL_MODEL=1` 时才拨真实模型（凭据仍读 demo.config.json，不落盘）。
// 未设置——或找不到 `../pi-agent-mesh/examples/demo.config.json`、缺少 apiKey——时整体
// skip，CI / 无凭据环境 `npm test` 仍绿、零费用。
// ═══════════════════════════════════════════════════════════════════════════

// 卫兵顺序：pi-ai 顶层运行值经动态 import 延迟装载（clipboard 原生模块），
// TERMUX_VERSION 须在任何 pi import 之前就绪。
process.env.TERMUX_VERSION ??= "1";

import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPiBackend, type ModelCredential, type PiAgentBinding } from "../src/mesh/pi-backend.js";
import { createRuntimeInternals } from "../src/runtime/runtime.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";
import { createRoleAgent, writeRoleBlueprint } from "./helpers/role-agents.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempdir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pi-role-real-"));
  tmpDirs.push(d);
  return d;
}

interface RealModelConfig {
  provider: string;
  modelId: string;
  credential: ModelCredential;
}

/** 读 mesh 演示配置（不落盘凭据）。找不到 / 缺 apiKey 时返回 null 以 skip。 */
function loadDemoConfig(): RealModelConfig | null {
  const candidates = [
    join(process.cwd(), "..", "pi-agent-mesh", "examples", "demo.config.json"),
    join(process.cwd(), "examples", "demo.config.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8")) as {
        llm?: { model?: string; providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: string }> };
      };
      const model = cfg.llm?.model ?? "";
      const colon = model.indexOf(":");
      if (colon <= 0) continue;
      const provider = model.slice(0, colon).trim();
      const modelId = model.slice(colon + 1).trim();
      const pconf = cfg.llm?.providers?.[provider];
      if (!provider || !modelId || !pconf?.apiKey) continue;
      return {
        provider,
        modelId,
        credential: {
          type: "api_key",
          key: pconf.apiKey,
          baseUrl: pconf.baseUrl,
          api: pconf.api ?? "openai-completions",
        },
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** durable 会话句柄的最小形状（assemble 返回的实际对象）。 */
interface DurableSession {
  ctx: unknown;
  root: {
    id: number;
    submit(draft: unknown, ctx: unknown): Promise<unknown>;
    waitForIdle(ctx: unknown): Promise<void>;
    entries(
      query: unknown,
      limit: number,
      cursor: unknown,
      ctx: unknown,
    ): Promise<{ items: Array<{ model?: Array<{ role?: string; content?: unknown; usage?: Usage42 }> }> }>;
  };
  close(): Promise<void>;
}

interface Usage42 {
  input?: number;
  output?: number;
  totalTokens?: number;
}

const real = process.env.PI_ROLE_REAL_MODEL ? loadDemoConfig() : null;

describe.skipIf(real === null)("real model backend（demo.config.json 自定义 provider）", () => {
  it("拨通 QwenAPI：真实生成返回非空回复，并捕获非零 usage（真实用量）", async () => {
    const dir = await tempdir();
    const binding: PiAgentBinding = {
      identityDir: join(dir, "identity"),
      sessionsDir: join(dir, "sessions"),
      systemPrompt: "你是被测角色。用中文简短、准确地回复。",
      provider: real!.provider,
      modelId: real!.modelId,
      thinkingLevel: "off",
    };

    const backend = createPiBackend({
      resolveBinding: () => binding,
      credentialFor: (p) => (p === real!.provider ? real!.credential : undefined),
    });

    const ctx = { account: { id: "alice" }, endpoint: { id: "ep-1" }, tools: [] };
    const created = await backend.create(ctx as never);
    const session = created.session as DurableSession;

    try {
      await session.root.submit(
        { type: "input", content: "请精确回复两个字：收到", entry: { kind: "test.msg", data: { envelopeId: "env-1" } } },
        session.ctx,
      );
      await session.root.waitForIdle(session.ctx);

      // 默认 newest-first；扫最近 10 条 entry，收集 assistant 文本与 usage。
      const page = await session.root.entries({}, 10, undefined, session.ctx);
      const texts: string[] = [];
      let usage: Usage42 | undefined;
      for (const e of page.items) {
        for (const m of e.model ?? []) {
          if (m.role !== "assistant") continue;
          const content = Array.isArray(m.content)
            ? (m.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
            : typeof m.content === "string"
              ? m.content
              : "";
          if (content) texts.push(content);
          if (m.usage) usage = m.usage;
        }
      }

      expect(texts.length).toBeGreaterThan(0);
      // 真实模型应给出非空白回复（不强求逐字，避免抽样非确定性当 CI 门槛）。
      expect(texts.join("\n").trim().length).toBeGreaterThan(0);

      // R06「真实用量」：真实模型调用必须带回非零 token 账（input/output 都 > 0）。
      expect(usage).toBeDefined();
      expect(usage!.input ?? 0).toBeGreaterThan(0);
      expect(usage!.output ?? 0).toBeGreaterThan(0);
      expect(usage!.totalTokens ?? 0).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 120_000);
});

describe.skipIf(real === null)("real model full scene（真实 transport 闭环，R13/R15/R21 冒烟）", () => {
  it("真实后端 + 真实 transport：一轮 cue 触发被点名者真实生成并回话", async () => {
    const dir = await tempdir();
    const rt = (await createRuntimeInternals({
      root: dir,
      db: join(dir, "role-agent.db"),
      fake: {}, // 无 fake：真实 PiStreamPort + InProcessTransport + 真实 pi backend
      modelDefaults: { dialogue: { provider: real!.provider, modelId: real!.modelId, thinkingLevel: "off" } },
      credentialFor: (p) => (p === real!.provider ? real!.credential : undefined),
    })) as RuntimeInternals;

    try {
      const blueprint = writeRoleBlueprint(dir, "role");
      await createRoleAgent(rt, blueprint, "teacher", "王老师");

      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [{ agentId: "teacher", role: "teacher" }],
        floorMode: "director",
        maxTurns: 1,
      });
      const res = await rt.scenes.run("s1", undefined, { maxTurns: 1 });

      // 一轮完成（max_turns 熔断，非 idle/挂起）。
      expect(res.turnsCompleted).toBe(1);
      expect(["max_turns", "idle"]).toContain(res.stopReason);

      // A07 真实用量进账：被点名者真实生成后，本轮 token 增量经 harness.usage 回读落库
      // （usageTotalFor 做差），场景累计应 > 0（而非恒 0 的注入缝）。
      expect(res.tokensCumulative).toBeGreaterThan(0);
      expect(res.tokensThisRun).toBeGreaterThan(0);

      // 被点名者真实回话：群里除 system cue 外应有 teacher 的回复消息。
      const msgs = await rt.mesh.observer.messages({ conversationId: est.conversationId });
      const replies = msgs.filter((m) => m.kind !== "system" && (m.from ?? "") !== "");
      // 注意：若真实 transport 在该断言时尚未把回话落进 observer，则此处会暴露时序缺口；
      // 冒烟目的是验证「生成真的发生」而非依赖回话文案——回话条数≥1 即为真实生成证据。
      expect(replies.length).toBeGreaterThan(0);

      await rt.scenes.close("s1");
    } finally {
      await rt.close();
    }
  }, 120_000);
});