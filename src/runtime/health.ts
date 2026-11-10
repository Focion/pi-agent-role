// ═══════════════════════════════════════════════════════════════════════════
// 内部健康保护（R31 · §20.1 / §26.1 必订事件）——不依赖宿主 onEvent
//
// 七个受 `policyTimeoutMs` 约束的策略槽降级时 mesh 发 `policy_degraded`；mesh 自检发现
// 内部不变量被破坏时发 `invariant_violated`。这二者都是「行为不对但可能不报错」的静默
// 信号，本环必须在宿主是否订阅 onEvent 之外**独立**接住（§26.1 三条必订事件之二，其一
// `message_consumed` 已在 MemoryService 接住）。
//
// 异常定位与**只停止相关记忆写入**：
//   · `invariant_violated`      —— 污染本环的一切结论（§26.1），整体 fail-closed，停止记忆
//     写入，等人工介入；
//   · `accessControl` 槽降级    —— 九槽里唯一 fail-closed 的槽（§20.1 注 2）：它超时/抛错时
//     退化为**放行**，owner 隔离变成纸糊，记忆写入依赖 owner 隔离，故也必须停写；
//   · 其余七槽降级              —— 只做观察（记 degradedSlots + 告警），不阻断记忆写入
//     （它们降级为不唤醒/静默等，只是少记不是错记）。
//
// 分层纪律（§22.4 R1）：本文件在 `src/runtime/**`，不 import `@pi/agent-mesh`，payload 用
// 最小结构类型（slot/code 字符串）防御性读取；`mesh.on(...)` 的订阅发生在 runtime 装配层。
// ═══════════════════════════════════════════════════════════════════════════

/** 降级即停写的策略槽（§20.1 注 2：accessControl 是唯一 fail-closed 槽）。 */
const MEMORY_FAIL_CLOSED_SLOTS: ReadonlySet<string> = new Set(["accessControl"]);

export interface HealthSnapshot {
  /** 是否已进入 fail-closed（停止记忆写入）。 */
  blockMemoryWrites: boolean;
  /** 停写缘由：策略槽降级 / 不变量违反；null 表示未被阻断。 */
  blockReason: { kind: "policy"; slot: string } | { kind: "invariant"; code: string } | null;
  /** 观测到的 policy_degraded 槽名（按首次出现顺序去重）。 */
  degradedSlots: string[];
  /** invariant_violated 累计次数（期望恒为 0，§23 P0/P6）。 */
  invariantCount: number;
}

/** 运行时健康哨兵：只读状态 + 供 MemoryService 询问「此刻能否写记忆」。 */
export interface HealthGuard {
  /** 记忆写入是否放行。fail-closed 后不自动恢复，等人工介入（§26.1）。 */
  writesAllowed(): boolean;
  /** 接 `policy_degraded` 事件（mesh 原样 payload）。 */
  onPolicyDegraded(payload: { slot?: unknown; reason?: unknown; degradedTo?: unknown }): void;
  /** 接 `invariant_violated` 事件（mesh 原样 payload）。 */
  onInvariantViolated(payload: { code?: unknown; detail?: unknown }): void;
  /** 只读快照（供观测 / inspect / 测试）。 */
  snapshot(): HealthSnapshot;
}

export function makeHealthGuard(): HealthGuard {
  let blockReason: HealthSnapshot["blockReason"] = null;
  const degradedSlots: string[] = [];
  let invariantCount = 0;

  return {
    writesAllowed(): boolean {
      return blockReason === null;
    },
    onPolicyDegraded(payload): void {
      const slot = typeof payload.slot === "string" ? payload.slot : undefined;
      if (slot === undefined) return;
      if (!degradedSlots.includes(slot)) degradedSlots.push(slot);
      // 只停相关记忆写入：唯 fail-closed 槽（accessControl）降级才阻断；首个阻断缘由保留。
      if (MEMORY_FAIL_CLOSED_SLOTS.has(slot) && blockReason === null) {
        blockReason = { kind: "policy", slot };
      }
    },
    onInvariantViolated(payload): void {
      invariantCount += 1;
      if (blockReason === null) {
        blockReason = { kind: "invariant", code: typeof payload.code === "string" ? payload.code : "unknown" };
      }
    },
    snapshot(): HealthSnapshot {
      return { blockMemoryWrites: blockReason !== null, blockReason, degradedSlots: [...degradedSlots], invariantCount };
    },
  };
}