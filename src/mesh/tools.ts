// ═══════════════════════════════════════════════════════════════════════════
// 领域工具面（§3.8）—— 10 个领域工具的封闭定义 + 按 Account 类型分叉
//
// 一个 Agent 的完整工具面 = mesh 14 内建的一个子集 + 本环 10 领域工具的一个子集。
// 两个集合都是封闭的，不得增删。
//
// 分叉规则（§3.8 末）：按 Account 类型分叉——对话 / 自省现在是两个 Account 两条流，
// 工具注册发生在建流时，分叉是机制的自然结果。唯一硬性挂载规则：
//   `reflect_result` 只在自省流挂载。
//
// 四条宿主自定义工具规则（mesh §21.4）：
//   ① 不得用 mesh_* 前缀、不得覆盖内建
//   ② 产生消息的工具必须走 Router.route（只有 facility_enforce 可能）
//   ③ 入参不得出现 from/fromEndpoint/seq/seal（身份从闭包来）
//   ④ 写 session 必须走 StreamPort（note_self 走 StreamPort.note，P3）
//
// P0：工具名字/描述/入参 schema 是封闭权威；execute 处理器在 P3/P4 注入。
//     未注入时返回明确的「未实装」错误，而非静默成功。
// ═══════════════════════════════════════════════════════════════════════════

import type { MeshToolName, MeshToolResult, ToolDefinition } from "@pi/agent-mesh/core";

export type ToolExecute = NonNullable<ToolDefinition["execute"]>;

export type AccountKind = "role" | "facility" | "reflect";

/** 每条流的 mesh 内建子集（§3.8 表）。一律不给 conversation_admin / create_conversation / claim / shared_*。 */
export const BUILTIN_WHITELIST: Record<AccountKind, MeshToolName[]> = {
  role: [
    "mesh_send",
    "mesh_ack",
    "mesh_lookup",
    "mesh_inbox",
    "mesh_history",
    "mesh_conversations",
    "mesh_members",
    "mesh_contacts",
  ],
  facility: ["mesh_send", "mesh_ack", "mesh_inbox", "mesh_members"],
  // 自省流 initiate:[] 且不对外发言（§3.4）：无 mesh_send
  reflect: [],
};

/** 每条流挂载的领域工具（§3.8 表）。reflect_result 只在自省流。 */
export const DOMAIN_TOOLS_BY_KIND: Record<AccountKind, string[]> = {
  role: ["remember", "recall", "identity_read", "protocol_query", "note_self"],
  facility: ["facility_query", "facility_report", "facility_enforce", "facility_record"],
  reflect: ["reflect_result"],
};

export const DOMAIN_TOOL_NAMES = [
  "remember",
  "recall",
  "identity_read",
  "reflect_result",
  "protocol_query",
  "note_self",
  "facility_query",
  "facility_report",
  "facility_enforce",
  "facility_record",
] as const;

export type DomainToolName = (typeof DOMAIN_TOOL_NAMES)[number];

interface ToolSpec {
  label: string;
  description: string;
  parameters: object; // JSON Schema（TypeBox 兼容）
}

const SPECS: Record<DomainToolName, ToolSpec> = {
  remember: {
    label: "记住一件事",
    description:
      "主动把当前这件事写进自己的记忆。owner 由运行时闭包注入，模型不能指定（C4）。",
    parameters: {
      type: "object",
      properties: {
        gist: { type: "string", description: "记忆摘要，一句话" },
        detail: { type: "string", description: "细节（可较长）" },
        quote: { type: "string", description: "极短原文摘录，可选" },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "number", description: "0..1 建议权重" },
        subjectRefs: {
          type: "array",
          items: { type: "string" },
          description: "相关主体 id（person:* / facility:* / self 等）",
        },
      },
      required: ["gist"],
      additionalProperties: false,
    },
  },
  recall: {
    label: "回想记忆",
    description: "检索自己的记忆。结果严格限于本人分区；检索失败（想不起来）是特性。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "返回条数上限" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  identity_read: {
    label: "读自己的身份定义",
    description: "读自己的身份定义（只读）。模板回写走 rt.agents.respec，不由模型触发（C5）。",
    parameters: { type: "object", additionalProperties: false },
  },
  reflect_result: {
    label: "提交自省结论",
    description: "提交一次自省的结论（含 trustDelta 等）。只在自省流挂载（§3.8）。",
    parameters: {
      type: "object",
      properties: {
        updates: { type: "object", description: "结构化结论，含 trustDelta / profileUpdates 等" },
      },
      required: ["updates"],
      additionalProperties: false,
    },
  },
  protocol_query: {
    label: "查询场景规程",
    description: "查询本场景的规程/规则（如「课堂上能不能直接打断老师」）。读本环规程表，不读 mesh。",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  note_self: {
    label: "给自己留笔记",
    description: "给自己留一条不进对话的笔记，走 P3（持久化但不进 LLM 上下文）。",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  facility_query: {
    label: "查询设施自身状态",
    description: "被问时查自身状态。应答必须携带当前 correlationId（§3.2）。",
    parameters: { type: "object", additionalProperties: false },
  },
  facility_report: {
    label: "输出设施应答",
    description: "输出应答内容，携带当前 correlationId（§3.2）。",
    parameters: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
  },
  facility_enforce: {
    label: "执行设施规则",
    description: "执行物理约束/规则（如「座位已满」）。产生的通告是 kind:event，走 Router.route。",
    parameters: {
      type: "object",
      properties: { rule: { type: "string" }, detail: { type: "object" } },
      required: ["rule"],
      additionalProperties: false,
    },
  },
  facility_record: {
    label: "写设施事实记录",
    description: "写自身事实记录到 facility_state（设施无主观记忆，不写 episodes，C7）。",
    parameters: {
      type: "object",
      properties: { fact: { type: "string" } },
      required: ["fact"],
      additionalProperties: false,
    },
  },
};

export interface DomainToolHandlers {
  remember?: ToolExecute;
  recall?: ToolExecute;
  identity_read?: ToolExecute;
  reflect_result?: ToolExecute;
  protocol_query?: ToolExecute;
  note_self?: ToolExecute;
  facility_query?: ToolExecute;
  facility_report?: ToolExecute;
  facility_enforce?: ToolExecute;
  facility_record?: ToolExecute;
}

function notImplemented(name: string): ToolExecute {
  return async () => ({
    content: `[domain tool] \`${name}\` 未实装（其处理器在 P3/P4 注入）。`,
  });
}

/** 构建单个领域工具的 ToolDefinition；handler 缺省为「未实装」占位。 */
export function makeDomainTool(name: DomainToolName, handlers: DomainToolHandlers = {}): ToolDefinition {
  const spec = SPECS[name];
  return {
    name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    execute: handlers[name] ?? notImplemented(name),
  };
}

/** 按 AccountKind 返回该流的全部领域工具（含占位处理器）。 */
export function domainToolsFor(kind: AccountKind, handlers: DomainToolHandlers = {}): ToolDefinition[] {
  return DOMAIN_TOOLS_BY_KIND[kind].map((n) => makeDomainTool(n as DomainToolName, handlers));
}