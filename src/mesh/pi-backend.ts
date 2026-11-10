// ═══════════════════════════════════════════════════════════════════════════
// pi 后端（§3.7 ① / §9.3 / M01–M02）——本环唯一接触 pi SDK 的地方（SessionFactory 槽内）。
//
// M01（WP03 迁移）：mesh v0.2.0 已迁到 @earendil-works/pi-durable 1.5；本环旧后端仍用
// coding-agent（SessionManager + createAgentSession），其 `runtimeRef`（会话文件 id）对
// mesh 的 streamEntries/replay 不可用（NO_SESSION → 端点 unavailable → 投递 parked）。
// 现改为 pi-durable 自定义工厂：storage.sqlite → Harness.open → root，逐账号装配，
// `runtimeRef = encodeRuntimeRef({storagePath, conversationId})`（mesh MD7 的不透明编码）。
//
// M02：逐账号身份 / 模型 / 注入改走 durable 官方机制——
//   · model → 逐账号 buildModels + AgentChange.model（ModelRef）+ root.configure 重应用（F-G）；
//   · system prompt → AgentChange.instructions（pi.agent 文档的 instructions 段）；
//   · 记忆上下文 last-append → GenerationHooks.beforeRequest（mesh injectContext 同款）；
//   · 压缩前抢救 → CompactionHooks.beforeCompact（副作用提炼，返回 undefined 不接管压缩）。
//
// 分层纪律（§22.4 #4）：本文件在 src/mesh/**，允许 import `@pi/agent-mesh` 与 pi SDK；
// pi-durable / pi-ai / chord 的运行值经本文件惰性装载，其余源码不得直接 import（§22.4 #1）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Context } from "@earendil-works/chord";
import type { Conversation, Harness, ModelRef, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import type { Api, Message, Model, Models, ModelThinkingLevel, ProviderStreams } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@pi/agent-mesh/core";

import type {
  BeforeCompactHook,
  ContextHook,
  RoleSessionFactoryContext,
  SessionBackend,
  SessionBeforeCompactEvent,
} from "./session-factory.js";

// ─── durable 惰性装载（mirror mesh durable-sdk.ts）────────────────────────
interface DurableSdk {
  durable: typeof import("@earendil-works/pi-durable");
  piai: typeof import("@earendil-works/pi-ai");
  builtinModels: typeof import("@earendil-works/pi-ai/providers/all").builtinModels;
  openNodeSqliteStorage: typeof import("@earendil-works/pi-durable/storage/sqlite/node").openNodeSqliteStorage;
  BackgroundContext: Context;
}

let cachedSdk: DurableSdk | undefined;

async function loadDurableSdk(): Promise<DurableSdk> {
  if (cachedSdk) return cachedSdk;
  // R01：库导入不改写进程环境。clipboard 原生模块卫兵延迟到「真正装载 pi SDK」这一刻再设
  // （宿主显式创建真实会话时），而非模块加载时。宿主/测试也可自行预设 TERMUX_VERSION。
  process.env.TERMUX_VERSION ??= "1";
  try {
    const [durable, piai, builtin, nodeSqlite, chordContext] = await Promise.all([
      import("@earendil-works/pi-durable"),
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-ai/providers/all"),
      import("@earendil-works/pi-durable/storage/sqlite/node"),
      import("@earendil-works/chord/context"),
    ]);
    cachedSdk = {
      durable,
      piai,
      builtinModels: builtin.builtinModels,
      openNodeSqliteStorage: nodeSqlite.openNodeSqliteStorage,
      BackgroundContext: chordContext.BACKGROUND_CONTEXT,
    };
    return cachedSdk;
  } catch (err) {
    throw new Error(
      "@pi/agent-role: failed to load pi-durable 1.5 SDK chain — install it " +
        "(npm i @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord) " +
        "or run with `fake: { sessions: true }`. Cause: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// ─── runtimeRef 编码（mesh MD7）─────────────────────────────────────────────
interface RuntimeRefPayload {
  storagePath: string;
  conversationId: number;
}

function encodeRuntimeRef(storagePath: string, conversationId: number): string {
  return JSON.stringify({ storagePath, conversationId } satisfies RuntimeRefPayload);
}

/** 解不出（损坏 / 旧库裸路径）时把整串当作 storagePath 兜底（与 mesh 同语义）。 */
function decodeRuntimeRef(runtimeRef: string | undefined): RuntimeRefPayload | undefined {
  if (!runtimeRef) return undefined;
  try {
    const p = JSON.parse(runtimeRef) as Partial<RuntimeRefPayload>;
    if (typeof p.storagePath === "string" && typeof p.conversationId === "number") {
      return p as RuntimeRefPayload;
    }
  } catch {
    // fall through：旧数据可能只是裸路径。
  }
  return { storagePath: runtimeRef, conversationId: 1 };
}

/** durable storage 文件名（每端点固定，锁与 reopen 都按它定位）。 */
const STORAGE_FILENAME = "storage.sqlite";

// ─── 逐账号装配输入（M02：provider/modelId 是 pi-ai 目录里的原值）───────────
export interface PiAgentBinding {
  /** 实例模板目录（绝对路径）；durable 端作为该账号的环境 cwd。 */
  identityDir: string;
  /** durable storage 文件所在目录（绝对路径；逐账号逐流唯一，R05 主/自省分离）。 */
  sessionsDir: string;
  /** 编译期现渲染的系统提示（§18.2.1：只有指纹落库，运行时快照持有）。 */
  systemPrompt: string;
  provider: string;
  modelId: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
  /**
   * 解析后的采样温度（§5.4 R06「补温度」）。本环把它作为权威解析结果随绑定携带；
   * pi-ai 的温度是逐请求 StreamOptions 项（非 ModelRef/AgentChange 字段），真正的下发在
   * mesh durable-port 的请求路径，不在 role 侧（H01：mesh 固定，只在 role 适配）。
   */
  temperature?: number;
}

/** 宿主提供的模型凭据（pi-durable 1.5 无缺省模型目录，必须显式 key，LD2/LD4）。 */
export interface ModelCredential {
  type: "api_key";
  key: string;
  /** 自定义 provider（OpenAI 兼容等）：请求端点。缺省（undefined）按 pi-ai 内建目录解析。 */
  baseUrl?: string;
  /** API 适配器名（pi-ai `@earendil-works/pi-ai/api/*.lazy`），缺省 "openai-completions"。 */
  api?: string;
  /** 附加请求头（如定制认证头）。 */
  headers?: Record<string, string>;
  /** 上下文窗口（token），缺省 128_000。 */
  contextWindow?: number;
  /** 单次生成上限（token），缺省 4096。 */
  maxTokens?: number;
  /** 该 provider/model 是否具备 reasoning 字段，缺省 false。 */
  reasoning?: boolean;
}

export interface PiBackendOptions {
  /** accountId → 装配绑定（§3.7 ① 策略槽反查）。未知账号返回 undefined ⇒ 后端抛错。 */
  resolveBinding(accountId: string): PiAgentBinding | undefined | Promise<PiAgentBinding | undefined>;
  /** provider → 模型凭据（M05）。缺省不注入——真实请求会在 provider 认证处失败。 */
  credentialFor?(provider: string): ModelCredential | undefined | Promise<ModelCredential | undefined>;
  /** P3 记忆：逐账号返回 P2 context 钩子（记忆卡片注入，§14.1.2）。缺省不注入。 */
  contextHookFor?: (accountId: string) => ContextHook | undefined;
  /** P4 自省：逐账号返回 session_before_compact 抢救提炼钩子（§15.4）。缺省不注入。 */
  beforeCompactFor?: (accountId: string) => BeforeCompactHook | undefined;
  /** 测试缝（M02 faux provider）：覆盖 buildModels 的模型目录装配——宿主/测试注入记录型
   *  Models（如 pi-ai `fauxProvider`），断言注入内容与 create/open 等价；缺省走 builtinModels。 */
  modelsFor?(binding: PiAgentBinding): Models | Promise<Models>;
}

// ─── 逐账号模型目录（mesh buildModels 的内建目录子集 + 自定义 provider）────────
/** 自定义 provider 的 chat 模型条目（字段对齐 pi-ai `Model<Api>`，mirror mesh customModelFor）。 */
function customModelFor(binding: PiAgentBinding, cred: ModelCredential, api: string): Model<Api> {
  return {
    id: binding.modelId,
    name: binding.modelId,
    api: api as Api,
    provider: binding.provider,
    baseUrl: cred.baseUrl as string,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: cred.reasoning ?? false,
    contextWindow: cred.contextWindow ?? 128_000,
    maxTokens: cred.maxTokens ?? 4096,
  };
}

/** 按 api 名懒装 pi-ai adapter（mirror mesh loadProviderApi；.lazy 模块只在首次真实流式时加载重型实现）。 */
async function loadProviderApi(api: string): Promise<ProviderStreams> {
  switch (api) {
    case "anthropic-messages":
      return (await import("@earendil-works/pi-ai/api/anthropic-messages.lazy")).anthropicMessagesApi();
    case "openai-completions":
      return (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi();
    case "openai-responses":
      return (await import("@earendil-works/pi-ai/api/openai-responses.lazy")).openAIResponsesApi();
    case "openai-codex-responses":
      return (await import("@earendil-works/pi-ai/api/openai-codex-responses.lazy")).openAICodexResponsesApi();
    case "azure-openai-responses":
      return (await import("@earendil-works/pi-ai/api/azure-openai-responses.lazy")).azureOpenAIResponsesApi();
    case "google-generative-ai":
      return (await import("@earendil-works/pi-ai/api/google-generative-ai.lazy")).googleGenerativeAIApi();
    case "google-vertex":
      return (await import("@earendil-works/pi-ai/api/google-vertex.lazy")).googleVertexApi();
    case "mistral-conversations":
      return (await import("@earendil-works/pi-ai/api/mistral-conversations.lazy")).mistralConversationsApi();
    case "bedrock-converse-stream":
      return (await import("@earendil-works/pi-ai/api/bedrock-converse-stream.lazy")).bedrockConverseStreamApi();
    case "pi-messages":
      return (await import("@earendil-works/pi-ai/api/pi-messages.lazy")).piMessagesApi();
    default:
      throw new Error(`@pi/agent-role: unknown pi-ai api adapter "${api}"`);
  }
}

async function buildModels(
  binding: PiAgentBinding,
  sdk: DurableSdk,
  external: PiBackendOptions,
): Promise<{ models: Models; modelRef: ModelRef }> {
  const modelRef: ModelRef = { provider: binding.provider, modelId: binding.modelId };
  if (external.modelsFor) {
    // M02 faux provider 缝：直接采用注入目录。
    const models = await external.modelsFor(binding);
    if (!models.getModel(binding.provider, binding.modelId)) {
      throw new Error(
        `@pi/agent-role: no model "${binding.provider}/${binding.modelId}" in the injected models catalog`,
      );
    }
    return { models, modelRef };
  }

  const { piai } = sdk;
  const credentials = new piai.InMemoryCredentialStore();
  const cred = external.credentialFor ? await external.credentialFor(binding.provider) : undefined;
  if (cred) {
    await credentials.modify(binding.provider, async () => ({ type: "api_key" as const, key: cred.key }));
  }

  // 自定义 provider（凭据带 baseUrl）：按 pi-ai createProvider 装配目录，auth 从内存凭据库回读。
  if (cred?.baseUrl) {
    const api = cred.api ?? "openai-completions";
    const provider = piai.createProvider({
      id: binding.provider,
      name: binding.provider,
      baseUrl: cred.baseUrl,
      ...(cred.headers ? { headers: cred.headers } : {}),
      auth: { apiKey: piai.envApiKeyAuth(binding.provider, []) },
      models: [customModelFor(binding, cred, api)],
      api: await loadProviderApi(api),
    });
    const models = piai.createModels({ credentials });
    models.setProvider(provider);
    if (!models.getModel(binding.provider, binding.modelId)) {
      throw new Error(
        `@pi/agent-role: no model "${binding.provider}/${binding.modelId}" in the custom provider catalog ` +
          `(is credentialFor supplying that provider's baseUrl + api_key?)`,
      );
    }
    return { models, modelRef };
  }

  const models = sdk.builtinModels({ credentials });
  if (!models.getModel(binding.provider, binding.modelId)) {
    throw new Error(
      `@pi/agent-role: no model "${binding.provider}/${binding.modelId}" in the pi-ai builtin catalog ` +
        `(is credentialFor supplying that provider's api_key?)`,
    );
  }
  return { models, modelRef };
}

// ─── mesh 工具 → durable 工具桥接（mirror mesh bridgeTools）────────────────
function bridgeTools(tools: readonly ToolDefinition[], sdk: DurableSdk): ToolRegistration[] {
  return tools.map((t) =>
    sdk.durable.defineTool({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      replay: "safe",
      async execute(args, api, _ctx) {
        const r = await t.execute(api.callId, args as Record<string, unknown>, undefined, undefined, undefined);
        const content =
          typeof r.content === "string" ? r.content : (r.content ?? []).map((c) => c.text).join("\n");
        return { output: [{ type: "text" as const, text: content }] };
      },
    }),
  );
}

// ─── 角色钩子扩展（M02）─────────────────────────────────────────────────────
//
// 记忆上下文 → GenerationHooks.beforeRequest：last-append。M02 已对齐：memory/service 的记忆/
// 学习队列卡片改回 durable 端 pi-ai UserMessage（{role:"user", content, timestamp}），此处透传并
// 由记录型 faux provider（tests/pi-backend-faux.test.ts）校验注入内容仍是合法 Message。
//
// 压缩前抢救 → CompactionHooks.beforeCompact：副作用提炼后返回 undefined（不接管、不取消压缩）。
// M02 已对齐：toBeforeCompactEvent 把 durable EntryRecord（kind + data.envelopeId + model 首条
// user 消息）映射为本环 branchEntries（customType + id + content），runtime.extractRoleMessages
// 据此按 kind==="mesh.msg" 提炼角色消息（单元覆盖见 tests/pi-backend-faux.test.ts）。
function roleHooksExtension(
  sdk: DurableSdk,
  contextHook: ContextHook | undefined,
  beforeCompact: BeforeCompactHook | undefined,
) {
  const hooks: Array<ReturnType<DurableSdk["durable"]["hook"]>> = [];
  if (contextHook) {
    hooks.push(
      sdk.durable.hook(sdk.durable.GenerationTask, {
        beforeRequest: async (req, _api, context) => {
          const out = await contextHook({ type: "context", messages: req.messages as unknown[] }, context);
          const messages = ((out?.messages ?? req.messages) as unknown) as readonly Message[];
          return { messages };
        },
      }),
    );
  }
  if (beforeCompact) {
    hooks.push(
      sdk.durable.hook(sdk.durable.CompactionTask, {
        beforeCompact: async (compaction, _api, _context) => {
          try {
            await beforeCompact(toBeforeCompactEvent(compaction));
          } catch {
            // §15.4 时序纪律 2：抢救提炼失败不得阻止压缩。
          }
          return undefined;
        },
      }),
    );
  }
  if (hooks.length === 0) return undefined;
  return sdk.durable.defineExtension({ name: "pi-agent-role:role-hooks", hooks });
}

/** durable compaction 载荷 → 本环 SessionBeforeCompactEvent（形状映射，M02 已对齐）。 */
export function toBeforeCompactEvent(compaction: {
  reason?: unknown;
  entries?: readonly unknown[];
  firstKept?: unknown;
  instructions?: string;
}): SessionBeforeCompactEvent {
  const reason =
    compaction.reason === "manual" || compaction.reason === "threshold" || compaction.reason === "overflow"
      ? compaction.reason
      : "threshold";
  const branchEntries: SessionBeforeCompactEvent["branchEntries"] = (compaction.entries ?? []).map((entry) => {
    const e = entry as { id?: unknown; kind?: unknown; data?: unknown; model?: readonly unknown[] };
    const kind = typeof e.kind === "string" ? e.kind : "mesh.msg";
    // H2 去重键：mesh 投递把 envelopeId 放进 entry.data；无 data 时兜底用 durable 条目 id。
    const data = (e.data ?? {}) as { envelopeId?: unknown };
    const envelopeId = typeof data.envelopeId === "string" ? data.envelopeId : String(e.id ?? "");
    // 角色消息原文在 entry.model 的首条 user 消息里（deliver 对 input 走 content、对 write 走
    // model 数组，二者都落进 EntryRecord.model），不在 data 里。
    let content = "";
    for (const m of (e.model ?? []) as Array<{ role?: unknown; content?: unknown }>) {
      if (m.role === "user" && typeof m.content === "string") {
        content = m.content;
        break;
      }
    }
    return { type: "custom_message", id: envelopeId, customType: kind, content };
  });
  return { type: "session_before_compact", reason, branchEntries };
}

// ─── 会话装配（create/open 等价，守卫①③；mirror mesh session-factory.assemble）────
async function assemble(
  sdk: DurableSdk,
  binding: PiAgentBinding,
  tools: readonly ToolDefinition[],
  storagePath: string,
  mode: "create" | "open",
  contextHook: ContextHook | undefined,
  beforeCompact: BeforeCompactHook | undefined,
  external: PiBackendOptions,
): Promise<{ session: unknown; runtimeRef: string }> {
  const ctx = sdk.BackgroundContext;
  const registry = sdk.durable.createRegistry();
  const bridged = bridgeTools(tools, sdk);
  if (bridged.length > 0) {
    registry.install(sdk.durable.defineExtension({ name: "pi-agent-role:role-tools", tools: bridged }));
  }
  const roleHooks = roleHooksExtension(sdk, contextHook, beforeCompact);
  if (roleHooks) registry.install(roleHooks);

  await mkdir(dirname(storagePath), { recursive: true });
  const { models, modelRef } = await buildModels(binding, sdk, external);
  const storage = await sdk.openNodeSqliteStorage(storagePath);
  const harness: Harness = await sdk.durable.Harness.open(storage, { models, registry }, ctx);

  const thinkingLevel = binding.thinkingLevel === "off" ? undefined : (binding.thinkingLevel as ModelThinkingLevel);
  const agentChange = {
    model: modelRef,
    tools: bridged,
    modelTools: bridged,
    instructions: binding.systemPrompt,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };

  let root: Conversation;
  if (mode === "create") {
    root = await harness.root(ctx, { agent: agentChange });
  } else {
    root = await harness.root(ctx);
    // F-G：每次 warm 对 root 重应用当前模型/工具/身份（open 重配置，M02 验收点）。
    await root.configure(agentChange, ctx);
  }

  const session = {
    endpointId: "",
    ctx,
    harness,
    root,
    registry,
    async configure(model: ModelRef, level?: ModelThinkingLevel) {
      await root.configure({ model, ...(level ? { thinkingLevel: level } : {}) }, ctx);
    },
    async close() {
      await harness.close(ctx);
    },
  };
  return { session, runtimeRef: encodeRuntimeRef(storagePath, root.id) };
}

/** A07：账号累计用量回读（σ models+tools 各桶的 input/output/totalTokens）。 */
export interface UsageBreakdown {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
}

export function createPiBackend(opts: PiBackendOptions): SessionBackend & { usageBreakdownFor(accountId: string): Promise<UsageBreakdown> } {
  async function bindingOf(accountId: string): Promise<PiAgentBinding> {
    const binding = await opts.resolveBinding(accountId);
    if (!binding) {
      throw new Error(
        `@pi/agent-role: no pi binding for account ${accountId} (agent not registered in this runtime?)`,
      );
    }
    return binding;
  }

  // A07：逐账号最近装配的 harness/ctx。同 storage 的多次 open 读写同一 durable 状态（pi.usage），
  // 任一存活的 harness 实例都能回读对累计；evict/close 后该实例读不了则降级返回 0（不阻断场景推进）。
  const sessions = new Map<string, { harness: Harness; ctx: unknown }>();

  function record(accountId: string, session: unknown): void {
    const s = session as { harness?: unknown; ctx?: unknown } | null | undefined;
    if (s && s.harness !== undefined && s.ctx !== undefined) {
      sessions.set(accountId, { harness: s.harness as Harness, ctx: s.ctx });
    }
  }

  /** A07：回读账号累计 usage（σ models+tools 各桶 input/output/totalTokens），
   *  场景预算按 totalTokens 熔断，onCost 分 input/output 上抛宿主。 */
  async function usageBreakdownFor(accountId: string): Promise<UsageBreakdown> {
    const entry = sessions.get(accountId);
    if (!entry) return { tokensIn: 0, tokensOut: 0, totalTokens: 0 };
    try {
      const state = await entry.harness.usage(entry.ctx as Context);
      let tokensIn = 0;
      let tokensOut = 0;
      let totalTokens = 0;
      for (const bucket of [state.models, state.tools] as const) {
        for (const key of Object.keys(bucket)) {
          const u = bucket[key] as { input?: unknown; output?: unknown; totalTokens?: unknown } | undefined;
          if (typeof u?.input === "number") tokensIn += u.input;
          if (typeof u?.output === "number") tokensOut += u.output;
          if (typeof u?.totalTokens === "number") totalTokens += u.totalTokens;
        }
      }
      return { tokensIn, tokensOut, totalTokens };
    } catch {
      return { tokensIn: 0, tokensOut: 0, totalTokens: 0 }; // 降级：读不到不阻断推进（该轮预算/上抛视为 0）。
    }
  }

  return {
    usageBreakdownFor,
    async create(ctx: RoleSessionFactoryContext & { tools: ToolDefinition[] }) {
      const binding = await bindingOf(ctx.account.id);
      const sdk = await loadDurableSdk();
      const runtimeRef: string | undefined = ctx.runtimeRef
        ? decodeRuntimeRef(ctx.runtimeRef)?.storagePath
        : undefined;
      const storagePath = runtimeRef ?? join(binding.sessionsDir, STORAGE_FILENAME);
      const created = await assemble(
        sdk,
        binding,
        ctx.tools,
        storagePath,
        "create",
        opts.contextHookFor?.(ctx.account.id),
        opts.beforeCompactFor?.(ctx.account.id),
        opts,
      );
      record(ctx.account.id, created.session);
      return created;
    },
    async open(ctx: RoleSessionFactoryContext & { tools: ToolDefinition[] }) {
      const binding = await bindingOf(ctx.account.id);
      if (!ctx.runtimeRef) {
        throw new Error(`@pi/agent-role: open() without runtimeRef for account ${ctx.account.id}`);
      }
      const sdk = await loadDurableSdk();
      const storagePath = decodeRuntimeRef(ctx.runtimeRef)?.storagePath ?? join(binding.sessionsDir, STORAGE_FILENAME);
      const { session } = await assemble(
        sdk,
        binding,
        ctx.tools,
        storagePath,
        "open",
        opts.contextHookFor?.(ctx.account.id),
        opts.beforeCompactFor?.(ctx.account.id),
        opts,
      );
      record(ctx.account.id, session);
      return { session };
    },
    // dispose 不实现（§9.3 注 6）：mesh evict 退化为 session.close()；本环不在驱逐这类运维事件上做业务收尾。
  };
}