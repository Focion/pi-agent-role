// ═══════════════════════════════════════════════════════════════════════════
// SessionFactory（§3.7 ①）——本环唯一直接接触 pi SDK 的槽（唯一必填）
//
// 承载四件事：模型绑定(C6) / System Prompt 注入 / 工具面分叉(§3.8) / ext 注入装饰(C10)。
// 真实后端为 pi-durable 1.5 自建工厂（createPiBackend + Harness.open/root，M01–M02），
// model-resolver + identity 编译器已接上；fake 后端仅供无 LLM 测试。
//
// 三条纪律（§3.7 ①）：
//   1. create 与 open 必须产出等价会话（除历史外）——工具面同源已是这里保证；
//      System Prompt 注入在 P1 同样走同一份组装函数。
//   2. dispose 必须实现（idleEvictMs 到期 evict 时刷出未落库领域状态）。
//   3. 不受 policyTimeoutMs 约束 ≠ 无限慢（NO_SESSION 是六个 park 原因中唯一要告警的）。
//
// 后端（backend）缺省为 fake（无 LLM），供测试冒烟；真实后端经 createPiBackend（pi-durable 1.5）。
// ═══════════════════════════════════════════════════════════════════════════

import { REJECT_CODES } from "@pi/agent-mesh/core";
import type { Account, Endpoint, MeshToolName, MeshToolResult, SessionFactory, ToolDefinition } from "@pi/agent-mesh/core";

import { spreadRoleExt, decodeRoleExt, type RoleExt } from "./ext-role.js";
import { BUILTIN_WHITELIST, domainToolsFor, type AccountKind, type DomainToolHandlers } from "./tools.js";
import { uuid } from "../runtime/id.js";

export interface RoleSessionFactoryContext {
  endpoint: Endpoint;
  account: Account;
  tools: ToolDefinition[];
  runtimeRef?: string;
}

/** 真实 pi 会话后端（createPiBackend 实现，pi-durable 1.5，M01–M02）；缺省 fake。 */
export interface SessionBackend {
  create(ctx: RoleSessionFactoryContext & { tools: ToolDefinition[] }): Promise<{ session: unknown; runtimeRef: string }>;
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
  /**
   * 边界审计（R11 / §18.4.4）：mesh_send 被 mesh 以附录 D reject 十项之一拒绝时回调一次。
   * 由 runtime 装配闭包把该拒绝写成一条 boundary_events（设施非法主动发起 → 拒绝 + 恰一条
   * 审计，与 R31 共用一套 owner/拒绝设计）。缺省不审计。
   */
  boundaryAudit?: (e: BoundaryReject) => void | Promise<void>;
}

/** mesh_send 拒绝事件（附录 D 十项之一）。装饰器从工具结果里提取，绝不把本环工具错误误判为拒绝。 */
export interface BoundaryReject {
  /** 被拒 mesh_send 的发起账号（accountId）。 */
  accountId: string;
  /** 附录 D 十项拒绝码（∈ REJECT_CODES），不含工具层错误码。 */
  reasonCode: string;
  /** 拒绝附带消息（detail_json 用）。 */
  message: string;
  /** 本次工具调用 id（客户的 tool_call id）。 */
  toolCallId: string;
  /** 场景位置（ext.role 已补齐的字段，可空）。 */
  sceneId?: string;
  virtualTs?: string;
  /** 尝试发送的 kind（mesh_send.params.kind，可空）。 */
  attemptedKind?: string;
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
      return { session: { accountId: ctx.account.id }, runtimeRef: `fake-${ctx.account.id}-${uuid()}` };
    },
    async open(ctx) {
      return { session: { accountId: ctx.account.id } };
    },
    async dispose() {},
  };
}

/** 提取工具结果里的拒绝码（只认附录 D 十项；工具层错误码/正常 JSON 一律不算）。 */
function rejectCodeOf(result: MeshToolResult): { code: string; message: string } | undefined {
  const candidates: string[] = [];
  const content = (result as MeshToolResult | undefined)?.content;
  if (typeof content === "string") {
    candidates.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const text = (block as { text?: unknown } | undefined)?.text;
      if (typeof text === "string") candidates.push(text);
    }
  }
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
    if (typeof code === "string" && (REJECT_CODES as readonly string[]).includes(code)) {
      const message = (parsed as { error?: { message?: unknown } }).error?.message;
      return { code, message: typeof message === "string" ? message : "" };
    }
  }
  return undefined;
}

/** §3.6 写法②：包 mesh_send 的 execute，在 handler 前补齐三个 ext.role 字段；若该发送被
 *  mesh 以拒十项之一拒绝，再从结果里抽出拒绝码触发一次边界审计（R11，§18.4.4）。
 *  导出于测试：与 makeBoundaryAudit 组合即可对真实 mesh_send 验证「拒绝 → 恰一条审计」。 */
export function decorateMeshSend(
  tool: ToolDefinition,
  accountId: string,
  extProvider: (accountId: string) => RoleExt,
  boundaryAudit?: (e: BoundaryReject) => void | Promise<void>,
): ToolDefinition {
  if (tool.name !== "mesh_send") return tool;
  const orig = tool.execute;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // A19：用会话的真实 accountId（不是空串），否则 extProvider 拿不到账号、退默认起点。
      const pre = extProvider(accountId) ?? {};
      const existing = decodeRoleExt((params as { ext?: unknown } | undefined)?.ext);
      const merged = spreadRoleExt(existing, pre);
      const next: Record<string, unknown> =
        params && typeof params === "object" ? { ...params, ext: merged } : { ext: merged };
      const result = await orig(toolCallId, next, signal, onUpdate, ctx);
      if (boundaryAudit) {
        const reject = rejectCodeOf(result);
        if (reject) {
          const kind = (next as { kind?: unknown }).kind;
          await boundaryAudit({
            accountId,
            reasonCode: reject.code,
            message: reject.message,
            toolCallId,
            sceneId: pre.sceneId,
            virtualTs: pre.virtualTs,
            attemptedKind: typeof kind === "string" ? kind : undefined,
          });
        }
      }
      return result;
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
    .map((t) => decorateMeshSend(t, ctx.account.id, extProvider, opts.boundaryAudit));
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