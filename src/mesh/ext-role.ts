// ═══════════════════════════════════════════════════════════════════════════
// ext.role.* —— 领域信息的唯一通道（C10）
//
// 封闭八字段（附录 C / §3.6）：
//   sceneId, turn, virtualTs, rememberHint, refs, facilityEvent, cue, msgClass
//
// 纪律（C10）：
//   · 领域信息只能进 Envelope.ext.role.*；mesh 不读、不校验、不索引、不判断。
//   · 策略槽**不得**读 ext（mesh 的 devMode Proxy 会拦）；本环的事件订阅者在
//     事件里读 ext 是合法的（mesh §21.1 推论 1）。
//   · 写入方只有本环（含本环的工具实现）；接收方 Agent 经工具写入 rememberHint/refs。
// ═══════════════════════════════════════════════════════════════════════════

import type { Envelope } from "@pi/agent-mesh/core";

/** 领域细分（§3.5）。`MessageKind` 是封闭五值，`kind:"system"` 的旁白 vs 控制只能靠它区分。 */
export type MsgClass = "narration" | "control";

/** 记忆建议（§12.6）。**建议不是命令**：接收方打折采信。 */
export interface RememberHint {
  /** 0..1 建议权重 */
  importance?: number;
  tags?: string[];
  subjectHints?: string[];
  reason?: string;
}

/** 点名消息的元信息，本环场景编排写入，仅用于审计（§3.6）。 */
export interface RoleCue {
  /** 点名动作的发起者（通常是场景编排的 @system 账号） */
  actor?: string;
  /** 被点名者 */
  target?: string;
  [key: string]: unknown;
}

/**
 * 设施事件载荷（§16.3）。库不读、不校验、不索引（ext 四条禁令）；事件类型是本环自定义的
 * 封闭集合，与 mesh 的 `kind` 无关。写入方是设施 Agent。
 */
export interface FacilityEventPayload {
  /** 本条事件涉及的设施主体。值是 facility_id，不是 accountId。 */
  facilities: string[];
  /** 事件类型（封闭五值）。与 mesh 的 kind 无关。 */
  event: "enter" | "leave" | "state_change" | "rule_enforced" | "ambient";
  /** 结构化的设施状态，供渲染过滤。自然语言在 renderHints 里。 */
  state: Record<string, string | number | boolean>;
  /** 按感官通道分组的可选描述片段（§16.3.2 感官过滤）。 */
  renderHints?: {
    visual?: string[];
    auditory?: string[];
    tactile?: string[];
    olfactory?: string[];
  };
  /** 异常标记。true 时打分函数的 novelty 分量拉满（§16.3 ③）。 */
  anomalous?: boolean;
}

export interface RoleExt {
  sceneId?: string;
  turn?: number;
  virtualTs?: string;
  rememberHint?: RememberHint;
  refs?: string[];
  facilityEvent?: FacilityEventPayload;
  cue?: RoleCue;
  msgClass?: MsgClass;
}

/** 封闭字段集（附录 C）。任何超出这八个字段的写都是 C10 违反。 */
export const ROLE_EXT_KEYS = [
  "sceneId",
  "turn",
  "virtualTs",
  "rememberHint",
  "refs",
  "facilityEvent",
  "cue",
  "msgClass",
] as const;

export type RoleEnvelope = Envelope<RoleExt>;

/**
 * 只保留封闭八字段，丢弃未知键。返回 undefined 当且仅当输入的 ext 连一个 ROLE_EXT_KEYS
 * 字段都没有（此时 `envelope.ext` 不是本环写出的领域数据）。
 */
export function decodeRoleExt(ext: unknown): RoleExt | undefined {
  if (ext === null || typeof ext !== "object") return undefined;
  const src = ext as Record<string, unknown>;
  let out: RoleExt | undefined;
  for (const k of ROLE_EXT_KEYS) {
    if (k in src) {
      out ??= {};
      (out as Record<string, unknown>)[k] = src[k];
    }
  }
  return out;
}

/** 构造分层合并：后值的非 undefined 字段覆盖前值。用于 `mesh_send` 装饰补齐三个字段（§3.6 写法②）。 */
export function spreadRoleExt(...parts: Array<RoleExt | undefined>): RoleExt {
  const out: RoleExt = {};
  for (const p of parts) {
    if (!p) continue;
    for (const k of ROLE_EXT_KEYS) {
      const v = p[k];
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * 从 mesh Envelope 取出本环领域字段（`envelope.ext` → RoleExt）。
 *
 * 这是 `ext.` 字面量的**唯一**出口集中点：`src/memory/**` 等非 mesh 目录受 CI R3 门禁
 * 约束（不得出现 `ext.`），因此记忆服务经本函数拿到已解码的 RoleExt 后再逐字段读取，
 * 不再触碰原始 `envelope.ext`。
 */
export function roleExtOf(envelope: Envelope): RoleExt {
  return decodeRoleExt(envelope?.ext) ?? {};
}

/** 消息正文（`payload.text`；mesh 载荷是 `{text?, data?, attachments?}` JSON，§12.1.3）。 */
export function envelopeText(envelope: Envelope): string {
  const payload = envelope?.payload as { text?: unknown } | undefined;
  return typeof payload?.text === "string" ? payload.text : "";
}