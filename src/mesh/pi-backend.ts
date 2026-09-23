// ═══════════════════════════════════════════════════════════════════════════
// pi 后端（§3.7 ① / §9.3）——本环唯一接触 pi SDK 的地方（SessionFactory 槽内）。
//
// mesh 的 `createPiSessionFactory` 是参考实现，但它的 model / thinkingLevel / tools 是
// 构造期**静态**的；本环要求**逐账号**绑定（层间事实 7：SessionFactory 是本环绑 pi 的
// 唯一时机），故自备后端：`resolveBinding(accountId)` 反查本环侧快照（不查库，O(1)），
// 把「模型(C6) + System Prompt(§3.7) + 实例目录 cwd + 会话持久化目录」喂给 pi 的
// `createAgentSession`。装配走同一个 assemble → create/open 等价（守卫①③）。
//
// 三条纪律（§9.3）：
//   1. create 与 open 共用 assemble，装配输入完全一致（回放核对要求）；
//   2. `noTools:"all"` + customTools：内置工具全关，能力只由白名单给出（§19.2.1）；
//      传入的 tools 是 mesh 14 个 + 领域工具（已由 §9.3 assembleTools 分叉），全作 customTools；
//   3. 本文件不实现 dispose（§9.3 注 6）：session 关闭由 mesh evict 驱动，交回
//      pi AgentSession.dispose()，本环不在驱逐这类运维事件上做业务收尾。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdir } from "node:fs/promises";

import type { RoleSessionFactoryContext, SessionBackend, ContextHook, BeforeCompactHook, SessionBeforeCompactEvent } from "./session-factory.js";

// TERMUX 卫兵：必须在任何 pi import 之前执行（与 mesh pi-sdk.ts 同手法）。pi 的 clipboard
// 原生模块在 import 时即 dlopen，本环境会挂死；设 TERMUX_VERSION="1" 跳过原生化。
process.env.TERMUX_VERSION ??= "1";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

let cachedPi: PiSdk | undefined;

async function loadPiSdk(): Promise<PiSdk> {
  if (cachedPi) return cachedPi;
  try {
    cachedPi = (await import("@earendil-works/pi-coding-agent")) as PiSdk;
  } catch (err) {
    throw new Error(
      "@pi/agent-role: failed to load optional peer @earendil-works/pi-coding-agent — install it " +
        "(npm i @earendil-works/pi-coding-agent) or run with `fake: { sessions: true }`. Cause: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return cachedPi;
}

/** accountId → 一条会话要绑定的全部装配输入（模型 C6 + system prompt §3.7 + cwd/sessions）。 */
export interface PiAgentBinding {
  /** 实例模板目录（绝对路径）；session 的 cwd 指向这里（§9.3 spec.templateDir / §19.2.1 cwd 收窄）。 */
  identityDir: string;
  /** 会话 JSONL 持久化目录（绝对路径；C8 root 之外零副作用）。 */
  sessionsDir: string;
  /** 编译期现渲染的系统提示（§18.2.1：只有指纹落库，此处由运行时快照持有）。 */
  systemPrompt: string;
  /** dialogue 模型（C6 五层链最终值）。provider/modelId 是 pi-ai 目录里的原值。 */
  provider: string;
  modelId: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
}

export interface PiBackendOptions {
  /** accountId → 装配绑定（§3.7 ① 策略槽反查）。未知账号返回 undefined ⇒ 后端抛错。 */
  resolveBinding(
    accountId: string,
  ): PiAgentBinding | undefined | Promise<PiAgentBinding | undefined>;
  /** pi 全局配置目录（透传 createAgentSession.agentDir）。缺省用 pi 自身默认。 */
  agentDir?: string;
  /** P3 记忆：逐账号返回 P2 context 钩子（记忆卡片注入，§14.1.2）。缺省不注入。 */
  contextHookFor?: (accountId: string) => ContextHook | undefined;
  /** P4 自省：逐账号返回 session_before_compact 抢救提炼钩子（§15.4）。缺省不注入。
   *  只对角色主 Account 返回；设施/自省流/系统账号应返回 undefined（无需提炼）。 */
  beforeCompactFor?: (accountId: string) => BeforeCompactHook | undefined;
}

/** {provider, modelId} → pi-ai 的 Model 对象（M1 宿主注入；C6 逐账号）。 */
async function resolvePiModel(binding: PiAgentBinding): Promise<unknown> {
  const ai = await import("@earendil-works/pi-ai/compat");
  const getModel = ai.getModel as unknown as (provider: string, modelId: string) => unknown;
  let model: unknown;
  try {
    model = getModel(binding.provider, binding.modelId);
  } catch (err) {
    throw new Error(
      `@pi/agent-role: failed to resolve model "${binding.provider}/${binding.modelId}" — ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (!model) {
    throw new Error(
      `@pi/agent-role: no model resolved for "${binding.provider}/${binding.modelId}" (is it in the pi-ai catalog?)`,
    );
  }
  return model;
}

/** 统一的会话装配（守卫①③：create/open 完全一致的模型/提示/工具面）。 */
async function assemble(
  pi: PiSdk,
  binding: PiAgentBinding,
  sm: unknown,
  tools: unknown[],
  agentDir: string,
  contextHook?: ContextHook,
  beforeCompact?: BeforeCompactHook,
): Promise<unknown> {
  const model = await resolvePiModel(binding);
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: binding.identityDir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: binding.systemPrompt,
  });
  const { session } = await pi.createAgentSession({
    cwd: binding.identityDir,
    agentDir,
    model: model as never,
    thinkingLevel: binding.thinkingLevel as never,
    noTools: "all",
    customTools: tools as never[],
    resourceLoader,
    sessionManager: sm as never,
    settingsManager: pi.SettingsManager.inMemory() as never,
  });
  if (contextHook || beforeCompact) registerHookExtension(session, contextHook, beforeCompact);
  return session;
}

/** pi SDK 的扩展容器（extensionRunner.extensions 是 TS-private 字段，靠结构体防御性解出）。 */
interface ExtensionRunnerSlot {
  extensionRunner?: {
    extensions?: Array<{
      path: string;
      resolvedPath?: string;
      hidden?: boolean;
      sourceInfo?: unknown;
      handlers?: Map<string, unknown[]>;
      tools?: unknown;
      messageRenderers?: unknown;
      commands?: unknown;
      flags?: unknown;
      shortcuts?: unknown;
    }>;
  };
}

/**
 * 把记忆卡片 context 钩子 + 压缩前抢救钩子注册成一条临时扩展（§14.1.2 / §15.4）。pi 的
 * transformContext 在每个 LLM 调用里遍历 extensions 的 context handler 做 last-append
 * （R3 追加），因此 context 只注册一次、每次调用都重跑（副作用由 service 幂等守门）。
 * session_before_compact 走同一条 handlers.Map 分派（runner.emit 按 event.type 取 handler），
 * 本钩子必须返回 void（不取消压缩、不接管），并自行 try/catch（§10.5）。
 */
function registerHookExtension(
  session: unknown,
  contextHook?: ContextHook,
  beforeCompact?: BeforeCompactHook,
): void {
  const slot = session as ExtensionRunnerSlot;
  const exts = slot.extensionRunner?.extensions;
  if (!exts || typeof exts.unshift !== "function") return;

  const handlers = new Map<string, unknown[]>();
  if (contextHook) handlers.set("context", [contextHook as unknown]);
  if (beforeCompact) {
    const hook = async (event: SessionBeforeCompactEvent): Promise<void> => {
      // §10.5 / §15.4 S4：先提炼后压缩——await 完抢救钩子再返回；失败只放行，不抛错、不取消。
      try {
        await beforeCompact(event);
      } catch {
        // 抢救提炼失败不得阻止压缩（§15.4 时序纪律 2）。
      }
    };
    handlers.set("session_before_compact", [hook]);
  }
  if (handlers.size === 0) return;

  exts.unshift({
    path: "pi-agent-role:role-hooks",
    resolvedPath: "pi-agent-role:role-hooks",
    hidden: true,
    sourceInfo: { path: "pi-agent-role:role-hooks", source: "pi-agent-role", scope: "temporary", origin: "package" },
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  });
}

export function createPiBackend(opts: PiBackendOptions): SessionBackend {
  async function bindingOf(accountId: string): Promise<PiAgentBinding> {
    const binding = await opts.resolveBinding(accountId);
    if (!binding) {
      throw new Error(
        `@pi/agent-role: no pi binding for account ${accountId} (agent not registered in this runtime?)`,
      );
    }
    return binding;
  }

  return {
    async create(ctx: RoleSessionFactoryContext) {
      const binding = await bindingOf(ctx.account.id);
      const pi = await loadPiSdk();
      const agentDir = opts.agentDir ?? pi.getAgentDir();
      await mkdir(binding.sessionsDir, { recursive: true });
      const sm = pi.SessionManager.create(binding.identityDir, binding.sessionsDir);
      const contextHook = opts.contextHookFor?.(ctx.account.id);
      const beforeCompact = opts.beforeCompactFor?.(ctx.account.id);
      const session = await assemble(pi, binding, sm, ctx.tools as unknown[], agentDir, contextHook, beforeCompact);
      return { session, piSessionId: sm.getSessionFile() ?? sm.getSessionId() };
    },
    async open(ctx: RoleSessionFactoryContext) {
      const binding = await bindingOf(ctx.account.id);
      if (!ctx.piSessionId) {
        throw new Error(`@pi/agent-role: open() without piSessionId for account ${ctx.account.id}`);
      }
      const pi = await loadPiSdk();
      const agentDir = opts.agentDir ?? pi.getAgentDir();
      await mkdir(binding.sessionsDir, { recursive: true });
      const sm = pi.SessionManager.open(ctx.piSessionId, binding.sessionsDir, binding.identityDir);
      const contextHook = opts.contextHookFor?.(ctx.account.id);
      const beforeCompact = opts.beforeCompactFor?.(ctx.account.id);
      const session = await assemble(pi, binding, sm, ctx.tools as unknown[], agentDir, contextHook, beforeCompact);
      return { session };
    },
    // dispose 不实现（§9.3 注 6）：mesh evict 会退化为 session.dispose()。
  };
}