// ═══════════════════════════════════════════════════════════════════════════
// ActivationPolicy（§3.7 ②）——「这条消息要不要唤醒他」
//
// v1 §16.2 的 `reactive` 打分被拆成两半：`wasAddressed`（是否被点到）落到本槽，
// 其余三项落到 FloorPolicy。本槽只回答「醒不醒」，不回答「醒了谁说话」。
//
// 强唤醒判据（mesh §7.3）：`expect ∈ {ack, reply}` ⇒ 必醒。
// 本槽负责的领域判断只有「被点名才醒」：
//   mentions 含本人          → 醒
//   to 精确指向本人（A4）    → 醒
//   群消息、未点名            → 不醒（交给折叠机制攒成 <<<CATCHUP>>>）
//
// C10 陷阱（§3.7 ②末）：旁白消息（kind:"system" + ext.role.msgClass="narration"）
// 「不唤醒」**不能**靠读 ext 实现——策略槽不得读 ext。正确做法是让旁白消息的
// to/mentions/expect 全为空，于是内建判据自然不唤醒。
//
// 单聊（direct）的强制唤醒由 mesh 自己叠加（directConversationWakes），不在本槽内。
// 唤醒限流由 mesh 的 wakeRateLimit 管，本环不得自建（C9）。
// ═══════════════════════════════════════════════════════════════════════════

import type { ActivationPolicy } from "@pi/agent-mesh/core";

export function makeActivationPolicy(): ActivationPolicy {
  return {
    shouldWake(ctx) {
      const { envelope, recipient, expect } = ctx;

      // 唯一强唤醒判据：expect ∈ {ack, reply} ⇒ 必醒
      if (expect === "ack" || expect === "reply") return true;

      // mentions 含本人 → 醒（点名）
      if (envelope.mentions?.includes(recipient.id)) return true;

      // to 精确指向本人 → 醒（A4：寻址即投递集）
      if (envelope.to && envelope.to.length === 1 && envelope.to[0] === recipient.id) {
        return true;
      }

      // 群消息、未点名 → 不醒（交给 mesh 折叠/摘要）
      return false;
    },
  };
}