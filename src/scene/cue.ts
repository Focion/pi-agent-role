// ═══════════════════════════════════════════════════════════════════════════
// 点名 cue（§7.3）——组场景「该谁出场」的唯一机制
//
// cue = kind:"system" + expect:"reply" + to:[一人] + ext(RoleExt 直接)。唤醒由
// activation 的内建判据 expect:"reply" 命中（点名必醒）；发言权由 floor 判（director
// 只给被点名者）。cue 的 from 是主持人账号（非 @system 也行——floor 恒放行 host）。
//
// ext 的四字段（§7.3 表）：sceneId / turn / virtualTs / cue(审计 actor/target/reason)。
// logicalTs 同步设成 virtualNow，喂 mesh 的 LogicalClock.compare（回放时钟一致）。
//
// 分层纪律：`ext` 作为 SendInput 的字段值是合法领域通道；但本文件**不得对 `ext` 做成员
// 访问**（R3 门禁扫注释，任何「ext 紧跟点号」都会误报）。领域层 role.* 的写入统一走
// RoleExt（不包 .role）。
// ═══════════════════════════════════════════════════════════════════════════

import type { AccountId, ConversationId, MeshHost, SendInput } from "../mesh/public-types.js";
import type { RoleExt } from "../mesh/ext-role.js";
import type { CueAudit, CueMessage, CueReason } from "./types.js";

export interface CueSendArgs {
  from: AccountId;
  conversationId: ConversationId;
  /** 被点名者（单一人，§14.1 expect 恰一目标）。 */
  to: AccountId;
  text: string;
  ext: RoleExt;
  logicalTs?: string;
}

/** 真正发出 cue（返回 mesh 分配的 messageId/seq）。 */
export function sendCue(
  mesh: MeshHost,
  args: CueSendArgs,
): Promise<{ messageId: string; seq: number }> {
  const input: SendInput & { from: string } = {
    from: args.from,
    conversationId: args.conversationId,
    kind: "system",
    expect: "reply",
    to: [args.to],
    text: args.text,
    logicalTs: args.logicalTs,
    ext: args.ext,
  };
  return mesh.send(input);
}

export interface BuildCueArgs {
  conversationId: ConversationId;
  from: AccountId;
  target: AccountId;
  sceneId: string;
  turn: number;
  virtualTs: string;
  text: string;
  audit: CueAudit;
}

/** 组装一条 cue 消息（含 RoleExt 四字段 + cue 审计）。不发出，供编曲器/测试自检。 */
export function buildCue(args: BuildCueArgs): CueMessage {
  const ext: RoleExt = {
    sceneId: args.sceneId,
    turn: args.turn,
    virtualTs: args.virtualTs,
    cue: {
      actor: args.from,
      target: args.target,
      reason: args.audit.reason,
      ...(args.audit.score !== undefined ? { score: args.audit.score } : {}),
      ...(args.audit.runnerUp ? { runnerUp: args.audit.runnerUp } : {}),
      ...(args.audit.policyDegraded ? { policyDegraded: true } : {}),
    },
    msgClass: "control",
  };
  return {
    conversationId: args.conversationId,
    kind: "system",
    expect: "reply",
    to: [args.target],
    text: args.text,
    ext,
  };
}

export type { CueReason };

/** 旁白（narration）发送入参（O05 scenes.inject）：kind:"system" + msgClass:"narration"，
 *  `expect:"none"` 且无 to/mentions —— 旁白不该唤醒任何人（§3.5 / §7.2）。from 是 host/@system。 */
export interface NarrationSendArgs {
  from: AccountId;
  conversationId: ConversationId;
  sceneId: string;
  virtualTs: string;
  text: string;
}

/** 注入一条旁白（不点名、不唤醒），返回 mesh 分配的 messageId/seq。 */
export function sendNarration(mesh: MeshHost, args: NarrationSendArgs): Promise<{ messageId: string; seq: number }> {
  const ext: RoleExt = { sceneId: args.sceneId, virtualTs: args.virtualTs, msgClass: "narration" };
  const input: SendInput & { from: string } = {
    from: args.from,
    conversationId: args.conversationId,
    kind: "system",
    expect: "none",
    text: args.text,
    ext,
  };
  return mesh.send(input);
}