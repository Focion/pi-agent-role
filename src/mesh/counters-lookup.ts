// ═══════════════════════════════════════════════════════════════════════════
// mesh 计数器快照读取（§20.3.3 meshCounters 段的供数方）
//
// mesh 的 23 个计数器无标签、按小时分桶（§20.1.2），只有经 Observer.counters()
// 这个只读接口能触及（replay/forkAt 均 P2 延期，§23.2）。本文件把成本视图需要的
// 9 个计数器一次性读成纯数据快照——不在这里做任何派生：派生口径（唤醒率/静默率/…）
// 由 observe/cost-view.ts 在天侧（无 mesh 依赖）统一计算，保持 E1「只读不碰写」。
//
// 分层纪律（§22.4 R1/R2）：本文件不写 mesh_ 表名 SQL（读计数器走 Observer 而非
// 直连 mesh_counters），但 import Observer 类型故落位 src/mesh/**。
// ═══════════════════════════════════════════════════════════════════════════

import type { Observer } from "@pi/agent-mesh/core";

/** B 组 7 个派生指标分子分母 + 2 个 A 组健康事件（§20.3.3 需要的全集）。 */
const MESH_COUNTER_NAMES = [
  "messages_total",
  "deliveries_total",
  "wake_per_message_idle",
  "wake_per_message_busy",
  "verbatim_copies",
  "silent_grade",
  "cold_hit",
  "policy_degraded",
  "invariant_violated",
] as const;

/** meshCounters 段的纯数据快照（天侧可无 mesh 依赖地消费）。 */
export interface MeshCounterSnapshot {
  messagesTotal: number;
  deliveriesTotal: number;
  wakePerMessageIdle: number;
  wakePerMessageBusy: number;
  verbatimCopies: number;
  silentGrade: number;
  coldHit: number;
  /** A 组：策略槽降级次数（§20.3.3 health.policyDegradedEvents）。 */
  policyDegraded: number;
  /** A 组：不变量违反次数（§20.3.3 health.invariantViolatedEvents）。 */
  invariantViolated: number;
}

/**
 * 读 mesh 计数器快照。`counters` 返回 `Record<string, number>`，缺名补 0；
 * `since` 透传给 Observer.counters 做分桶下界过滤（ISO 字面量）。
 */
export async function readMeshCounterSnapshot(
  observer: Pick<Observer, "counters">,
  since?: string,
): Promise<MeshCounterSnapshot> {
  const c = await observer.counters([...MESH_COUNTER_NAMES], since);
  return {
    messagesTotal: c["messages_total"] ?? 0,
    deliveriesTotal: c["deliveries_total"] ?? 0,
    wakePerMessageIdle: c["wake_per_message_idle"] ?? 0,
    wakePerMessageBusy: c["wake_per_message_busy"] ?? 0,
    verbatimCopies: c["verbatim_copies"] ?? 0,
    silentGrade: c["silent_grade"] ?? 0,
    coldHit: c["cold_hit"] ?? 0,
    policyDegraded: c["policy_degraded"] ?? 0,
    invariantViolated: c["invariant_violated"] ?? 0,
  };
}