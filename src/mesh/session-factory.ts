// ═══════════════════════════════════════════════════════════════════════════
// SessionFactory（§3.7 ①）——本环唯一直接接触 pi SDK 的槽（唯一必填）
//
// 承载四件事：模型绑定(C6) / System Prompt 注入 / 工具面分叉(§3.8) / ext 注入装饰(C10)。
// P0 先落工具面分叉 + ext 装饰；模型绑定与 System Prompt 编译在 P1（model-resolver
// + identity 编译器）接上，届时 backend 换成 mesh 的 createPiSessionFactory。
//
// 三条纪律（§3.7 ①）：
//   1. create 与 open 必须产出等价会话（除历史外）——工具面同源已是这里保证；
//      System Prompt 注入在 P1 同样走同一份组装函数。
//   2. dispose 必须实现（idleEvictMs 到期 evict 时刷出未落库领域状态）。
//   3. 不受 policyTimeoutMs 约束 ≠ 无限慢（NO_SESSION 是六个 park 原因中唯一要告警的）。
//
// 后端（backend）缺省为 fake（无 LLM），供测试与 P0 冒烟；P1 接 pi SDK。
// ═══════════════════════════════════════════════════════════════════════════

import type { Account, Endpoint, MeshToolName, SessionFactory, ToolDefinition } from "@pi/agent-mesh/core";

import { spreadRoleExt, decodeRoleExt, type RoleExt } from "./ext-role.js";
import { BUILTIN_WHITELIST, domainToolsFor, type AccountKind, type DomainToolHandlers } from "./tools.js";
import { uuid } from "../runtime/id.js";

export interface RoleSessionFactoryContext {
  endpoint: Endpoint;
  account: Account;
  tools: ToolDefinition[];
  piSessionId?: string;
}

/** 真实 pi 会话后端（P1 用 mesh 的 createPiSessionFactory 实现）；P0 用 fake。 */
export interface SessionBackend {
  create(ctx: RoleSessionFactoryContext & { tools: ToolDefinition[] }): Promise<{ session: unknown; piSessionId: string }>;
  open(ctx: RoleSessionFactoryContext & { tools: ToolDefinition[] }): Promise<{ session: unknown }>;
  dispose?(ctx: { endpoint: Endpoint; session: unknown }): Promise<void>;
}

export interface RoleSessionFactoryOptions {
  /** 会话后端；缺省 = fake（无 LLM 测试，§21.2） */
  backend?: SessionBackend;
  /** accountId → AccountKind（工具面分叉；bootstrap 从注册表取） */
  classify?: (accountId: string) => AccountKind;
  /** 发送装饰：按 accountId 返回当前场景要补齐的三个 ext.role 字段（sceneId/turn/virtualTs）。P0 返回 {}。 */
  extProvider?: (accountId: string) => RoleExt;
  /** 领域工具处理器（P3/P4 注入）；P0 缺省为占位 */
  domainHandlers?: DomainToolHandlers;
  /** 逐账号领域工具处理器（P3 记忆：remember/recall 需按 owner 分区闭包；异步装配）。 */
  domainHandlersFor?: (accountId: string) => Promise<DomainToolHandlers> | DomainToolHandlers;
}

/**
 * pi SDk `context` 事件钩子的处理器契约（§14.1.2 / §14.4）。R3 追加：返回
 * `{ messages: [...event.messages, newMsg] }` 做 last-append，不覆盖已有消息。
 * 类型刻意放宽为 unknown[]，避免在 mesh 层 import pi 的 AgentMessage 类型。
 */
export type ContextHook = (
  event: { type: "context"; messages: unknown[] },
  ctx: unknown,
) => Promise<{ messages?: unknown[] } | void> | { messages?: unknown[] } | void;

/** 压缩前抢救提炼的载荷（§15.4）——只暴露调用方所需的结构字段，不经 pi SDK 类型。 */
export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  /** 压缩触发源：手动 / 阈值 / 上下文溢出恢复。 */
  reason: "manual" | "threshold" | "overflow";
  /** 即将被压缩的会话条目；调用方按 type/customType 自辨角色消息（H1）。 */
  branchEntries: Array<{
    type: string;
    id: string;
    customType?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    details?: unknown;
  }>;
}

/** 挂在 session_before_compact 上（§10.5）：返回 void（不接管压缩），自行 try/catch 不抛错。 */
export type BeforeCompactHook = (event: SessionBeforeCompactEvent) => Promise<void> | void;

function fakeBackend(): SessionBackend {
  return {
    async create(ctx) {
      return { session: { accountId: ctx.account.id }, piSessionId: `fake-${ctx.account.id}-${uuid()}` };
    },
    async open(ctx) {
      return { session: { accountId: ctx.account.id } };
    },
    async dispose() {},
  };
}

/** §3.6 写法②：包 mesh_send 的 execute，在 handler 前补齐三个 ext.role 字段。 */
function decorateMeshSend(tool: ToolDefinition, extProvider: (accountId: string) => RoleExt): ToolDefinition {
  if (tool.name !== "mesh_send") return tool;
  const orig = tool.execute;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const pre = extProvider("") ?? {};
      const existing = decodeRoleExt((params as { ext?: unknown } | undefined)?.ext);
      const merged = spreadRoleExt(existing, pre);
      const next: Record<string, unknown> =
        params && typeof params === "object" ? { ...params, ext: merged } : { ext: merged };
      return orig(toolCallId, next, signal, onUpdate, ctx);
    },
  };
}

/**
 * 组装最终工具面（确定性：同一 account 得到同一工具名集合 → create/open 等价，守卫③）。
 * 异步：P3 的领域工具处理器按 owner 分区闭包逐账号装配（domainHandlersFor）。
 */
async function assembleTools(
  ctx: RoleSessionFactoryContext,
  opts: RoleSessionFactoryOptions,
): Promise<ToolDefinition[]> {
  const kind: AccountKind = opts.classify?.(ctx.account.id) ?? "role";
  const allowed = new Set<MeshToolName>(BUILTIN_WHITELIST[kind]);
  const extProvider = (accountId: string) => opts.extProvider?.(accountId) ?? {};
  const builtins = ctx.tools
    .filter((t) => allowed.has(t.name as MeshToolName))
    .map((t) => decorateMeshSend(t, extProvider));
  const handlers = (await opts.domainHandlersFor?.(ctx.account.id)) ?? opts.domainHandlers;
  const domain = domainToolsFor(kind, handlers);
  return [...builtins, ...domain];
}

export function makeSessionFactory(opts: RoleSessionFactoryOptions = {}): SessionFactory {
  const backend = opts.backend ?? fakeBackend();

  return {
    async create(ctx) {
      const tools = await assembleTools(ctx, opts);
      return backend.create({ ...ctx, tools });
    },
    async open(ctx) {
      const tools = await assembleTools(ctx, opts);
      return backend.open({ ...ctx, tools });
    },
    // dispose 只在后端自实现时透传（§9.3 注 6）：本环不实现 dispose 时，mesh evict
    // 退化为 pi AgentSession.dispose()——工厂层不做「场景收尾」这类业务逻辑。
    ...(backend.dispose
      ? {
          async dispose(ctx: { endpoint: Endpoint; session: unknown }) {
            await backend.dispose!(ctx);
          },
        }
      : {}),
  };
}

/** 工具面指纹（守卫③的等价性断言用）：排序后的工具名集合。 */
export function toolSurfaceKey(tools: ToolDefinition[]): string {
  return [...new Set(tools.map((t) => t.name))].sort().join(",");
}