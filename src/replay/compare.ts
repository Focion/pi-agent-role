// ═══════════════════════════════════════════════════════════════════════════
// 结构化比较（H03/R38）：两条回放的记忆/知识/决策/检索/成本差异
//
// 固定蓝本、探针、虚拟时间、预算下的确定性机制差异 → 硬指标（可在 CI 必过）；
// 真实模型质量抽样不在此处，不把非确定性评分设成必过值（§H03 关闭口径 3）。
//
// 纯函数：不触库、不 import @pi/agent-mesh。
// ═══════════════════════════════════════════════════════════════════════════

import type {
  DomainDecisionReplay,
  ReplayCompareMetric,
  ReplayCompareResult,
  ReplayCompareSide,
} from "./types.js";

function metric(key: string, left: number, right: number): ReplayCompareMetric {
  return { key, left, right, delta: right - left };
}

function sideOf(r: DomainDecisionReplay): ReplayCompareSide {
  return {
    ownerAgent: r.ownerAgent,
    source: r.source,
    specHash: r.fingerprint.specHash,
    blueprintHash: r.fingerprint.blueprintHash,
  };
}

/** 比较两条回放（记录回放 vs 记录回放，或记录 vs 重执行）。纯函数。 */
export function compareReplays(left: DomainDecisionReplay, right: DomainDecisionReplay): ReplayCompareResult {
  const memory = [
    metric("episodes", left.memory.episodes, right.memory.episodes),
    metric("subjects", left.memory.subjects, right.memory.subjects),
    metric("knowledgeItems", left.memory.knowledgeItems, right.memory.knowledgeItems),
    metric("reflections", left.memory.reflections, right.memory.reflections),
  ];

  const writesOf = (r: DomainDecisionReplay): number => r.turns.filter((t) => t.written).length;
  const decidedOf = (r: DomainDecisionReplay): number => r.turns.filter((t) => t.writeDecided).length;
  const decisions = [
    metric("turnCount", left.turns.length, right.turns.length),
    metric("writeDecidedCount", decidedOf(left), decidedOf(right)),
    metric("writtenCount", writesOf(left), writesOf(right)),
  ];

  const sumRetrieval = (r: DomainDecisionReplay, key: "tokens" | "clamped" | "count"): number => {
    if (key === "count") return r.retrievals.length;
    if (key === "clamped") return r.retrievals.reduce((s, x) => s + x.clamped, 0);
    return r.retrievals.reduce((s, x) => s + x.tokens.total, 0);
  };
  const retrieval = [
    metric("retrievalCount", sumRetrieval(left, "count"), sumRetrieval(right, "count")),
    metric("tokensTotal", sumRetrieval(left, "tokens"), sumRetrieval(right, "tokens")),
    metric("clamped", sumRetrieval(left, "clamped"), sumRetrieval(right, "clamped")),
  ];

  const cost =
    left.cost && right.cost
      ? [
          metric("costTokensIn", left.cost.tokensIn, right.cost.tokensIn),
          metric("costTokensOut", left.cost.tokensOut, right.cost.tokensOut),
          metric("costSteps", left.cost.steps, right.cost.steps),
        ]
      : null;

  const sameMemory = memory.every((m) => m.delta === 0);
  const sameDecisions = decisions.every((m) => m.delta === 0);

  return {
    left: sideOf(left),
    right: sideOf(right),
    memory,
    decisions,
    retrieval,
    cost,
    sameMemory,
    sameDecisions,
  };
}