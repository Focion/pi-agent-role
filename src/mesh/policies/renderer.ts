// ═══════════════════════════════════════════════════════════════════════════
// Renderer（§3.7 ④）——角色沉浸感的落点
//
// §3.6 里被删除的 from 子字段（displayName / title）在这里由 accountId 反查
// `agents` 实时取当前值，不冻结在消息里。例：`李老师（班主任）说：「…」`。
//
// 硬约束（C10）：渲染器**不得读 ext**。renderSystem 想显示虚拟时间，
// 虚拟时间必须来自 logicalTs（意图层）而非 ext.role.virtualTs。
//
// M4 防线不可丢：一切外来内容必须包在 <<<MSG>>>…<<<END MSG>>> 内。因此本槽
// 复用 mesh 的 DefaultRenderer 保底外层，只覆盖「名字」这一处领域定制。
// P0 尚未接 compile/identity.yaml（P1），故 nameOf 恒为 undefined ⇒ 退化为内建。
// ═══════════════════════════════════════════════════════════════════════════

import type { Envelope, Renderer } from "@pi/agent-mesh/core";
import { DefaultRenderer, escapeDelims } from "@pi/agent-mesh/core";

const MSG_OPEN = "<<<MSG";
const MSG_CLOSE = "<<<END MSG>>>";

/** 由 accountId 反查角色的展示名。P1 接 `agents.display_name`（§3.7 ④）。 */
export type NameResolver = (accountId: string) => string | undefined;

export function makeRenderer(nameOf?: NameResolver): Renderer {
  const base = new DefaultRenderer();
  // P0：无名字反查时与内建渲染器逐字节一致。
  if (!nameOf) return base;

  return {
    renderMessage(env: Envelope, ctx: { recipient: import("@pi/agent-mesh/core").Account; senderName: string }): string {
      // sink/external 走结构化 JSON（与内建一致，§5.7）
      if (ctx.recipient.endpointClass !== "stream") {
        return base.renderMessage(env, ctx);
      }
      const name = nameOf(env.from) ?? ctx.senderName ?? env.from;
      const text = escapeDelims(env.payload.text ?? "");
      const header =
        `id="${env.id}" seq="${env.seq}" conv="${env.conversationId}" ` +
        `from="${env.from}" name="${escapeDelims(name)}" kind="${env.kind}"`;
      return `${MSG_OPEN} ${header}>>>\n${text}\n${MSG_CLOSE}`;
    },
    renderInbox(view, recent) {
      return base.renderInbox(view, recent);
    },
    renderSystem(env) {
      return base.renderSystem(env);
    },
  };
}