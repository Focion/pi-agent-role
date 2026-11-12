// ═══════════════════════════════════════════════════════════════════════════
// 群聊转写收集器：从 runtime 的 onEvent 流里挑出本会话语义的消息（message_routed，
// 每封恰好一次），按信封 id 去重后攒成时间线，供 chat 场景做「只打印新增行」的游标式回放。
//
// 只用公开门面类型 RuntimeEvent；信封是事件回调 payload 里的结构，本文件按最小
// 结构自声明窄化（不 import @pi/agent-mesh）。事件订阅者读 envelope.ext 是合法的
// （mesh §21.1 推论 1：策略槽才禁读 ext），这里用它区分「旁白（用户）／点名（导演）」。
//
// 收发音以 message_routed 为准：每封消息恰好路由一次、带全量信封（from/kind/text/ext）。
// 不用 message_delivered/consumed 兜底的原因：旁白（用户注入）expect:none 不唤醒任何人，
// 被 mesh 折叠成 followUp，只有 message_routed / message_consumed(partial) 而**没有**
// message_delivered——若只看 delivered 会漏掉用户自己的发言；而 consumed 会让建会话的
// 「conversation created」系统喂食消息在 bind 之后才到，混进转写。routed 恰好一次、且序
// 与 bind 时序一致，避开两者。
// ═══════════════════════════════════════════════════════════════════════════

import type { RuntimeEvent } from "@pi/agent-role";

import { PERSONAS } from "./personas.ts";

/** 一条转写行：from=accountId（角色=agentId，旁白/点名=host/@system）。 */
export interface TranscriptLine {
  from: string;
  kind: string;
  text: string;
  /** 展示名：角色回复→MBTI 展示名；system→"旁白/你"。 */
  name: string;
  /** system 线细分：narration=用户旁白，control=导演点名；角色回复为 undefined。 */
  cls?: "narration" | "control";
}

export interface TranscriptOptions {
  /** 覆盖 accountId→展示名 映射（优先级高于 PERSONAS）。 */
  names?: Record<string, string>;
  /** 只收录该会话语义的消息；未绑定前不收录任何消息（chat 在建场景后 bind）。 */
  conversationId?: string;
}

/** mesh 信封在事件里的最小结构（id/conversationId/from/kind/payload/ext）。 */
interface EnvelopeLike {
  id?: string;
  from?: string;
  kind?: string;
  conversationId?: string;
  payload?: { text?: string };
  ext?: { msgClass?: unknown };
}

/** 带全量信封、恰好一次的 mesh 事件：message_routed。 */
const MESSAGE_EVENT_KIND = "message_routed";

export interface Transcript {
  onEvent(e: RuntimeEvent): void;
  /** 绑定待观察的群会话；绑定后 onEvent 才生效（避免收录建场景前的杂讯）。 */
  bind(conversationId: string): void;
  /** 从游标起的所有新增行（游标 = 已消费行数）。 */
  since(cursor: number): TranscriptLine[];
  all(): TranscriptLine[];
  count(): number;
  /** 打印给定行（缺省全部）。 */
  print(lines?: readonly TranscriptLine[]): void;
}

function defaultNames(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const p of PERSONAS) m[p.id] = p.displayName;
  return m;
}

function formatLine(l: TranscriptLine): string {
  if (l.kind !== "system") return `${l.name}：${l.text}`;
  const label = l.cls === "narration" ? "你" : l.cls === "control" ? "旁白" : "旁白/你";
  return `【${label}】${l.text}`;
}

export function createTranscript(opts: TranscriptOptions = {}): Transcript {
  const names = { ...defaultNames(), ...(opts.names ?? {}) };
  let conversationId: string | undefined = opts.conversationId;
  const lines: TranscriptLine[] = [];
  const seen = new Set<string>();

  return {
    bind(id: string): void {
      conversationId = id;
    },

    onEvent(e: RuntimeEvent): void {
      if (!conversationId) return;
      if (e.type !== "mesh" || e.kind !== MESSAGE_EVENT_KIND) return;
      const env = (e.payload as { envelope?: EnvelopeLike } | undefined)?.envelope;
      if (!env || env.conversationId !== conversationId) return;

      // 每封消息只 route 一次；id 去重仍是兜底（防未来事件源重复，也护住重放）。
      const id = env.id;
      if (!id || seen.has(id)) return;
      seen.add(id);

      const from = env.from ?? "";
      const kind = env.kind ?? "";
      const text = env.payload?.text ?? "";
      const msgClass = env.ext?.msgClass;

      if (kind === "system") {
        const cls =
          msgClass === "narration" ? "narration" : msgClass === "control" ? "control" : undefined;
        lines.push({ from, kind, text, name: "旁白/你", cls });
      } else {
        lines.push({ from, kind, text, name: names[from] ?? from });
      }
    },

    since(cursor: number): TranscriptLine[] {
      return lines.slice(Math.max(0, cursor));
    },

    all(): TranscriptLine[] {
      return [...lines];
    },

    count(): number {
      return lines.length;
    },

    print(input?: readonly TranscriptLine[]): void {
      for (const l of input ?? lines) console.log(formatLine(l));
    },
  };
}