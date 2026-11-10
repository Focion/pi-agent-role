// ═══════════════════════════════════════════════════════════════════════════
// 观测视图类型定义（§20.3）
//
// 三个视图的数据结构：MemoryTimeline、ImpressionEvolution、CostView。
// 每个字段标出来自哪一层（本环 / mesh），因为跨库取数的可用性不同。
// ═══════════════════════════════════════════════════════════════════════════

/** 证据完整度（§18.6.4）：L0=有原文 / L1=有 quote / L2=仅锚点。 */
export type EvidenceLevel = "L0" | "L1" | "L2";

// ─── 记忆时间线（§20.3.1）──────────────────────────────────────────────────

export interface MemoryTimeline {
  ownerAgent: string;
  window: { since: string; until: string };
  scenes: TimelineScene[];
  truncated: boolean;
}

export interface TimelineScene {
  sceneId: string;
  name: string | null;
  conversationId: string | null;
  virtualStart: string | null;
  turnCount: number;
  status: string;
  /** 本场景期间收到的 policy_degraded 策略槽名称（mesh 事件流）。 */
  degradedPolicies: string[];
  items: TimelineItem[];
}

export interface TimelineItem {
  episodeId: string;
  kind: "event" | "impression" | "fact" | "self";
  gist: string;
  detail: string | null;
  quote: string | null;
  emotion: string | null;
  valence: number | null;
  salience: number;
  confidence: number;
  retention: number;
  rehearsalCount: number;
  virtualTs: string | null;
  realTs: string;
  subjects: Array<{ subject: string; weight: number }>;
  sourceMsgId: string | null;
  sourceEntryId: string | null;
  evidenceLevel: EvidenceLevel;
  evidence: TimelineEvidence | null;
}

export interface TimelineEvidence {
  conversationId: string;
  seq: number;
  fromAccount: string;
  kind: string;
  routedAt: string;
  text: string;
  delivery: {
    grade: string | null;
    path: string | null;
    woke: boolean;
    state: string;
    dropReason: string | null;
    parkedReason: string | null;
  } | null;
}

// ─── 印象演化曲线（§20.3.2）────────────────────────────────────────────────

export interface ImpressionEvolution {
  ownerAgent: string;
  subjectType: string;
  subjectId: string;
  current: {
    impression: string | null;
    valence: number | null;
    closeness: number | null;
    trust: number | null;
    updatedAt: string;
  };
  points: ImpressionPoint[];
  jumps: ImpressionJump[];
}

export interface ImpressionPoint {
  realTs: string;
  writeId: string;
  valence: number | null;
  closeness: number | null;
  impression: string | null;
  actor: string;
  reflectionId: string | null;
  sceneId: string | null;
  evidenceEpisodeIds: string[];
}

export interface ImpressionJump {
  fromTs: string;
  toTs: string;
  valenceDelta: number;
  hasEvidence: boolean;
  reflectionId: string | null;
  verdict: "explained" | "unexplained";
}

// ─── 成本视图（§20.3.3）────────────────────────────────────────────────────

export interface CostView {
  window: { since: string; until: string };
  windowClampedTo: { since: string; until: string };
  scope: { sceneIds: string[] | "all"; agentIds: string[] | "all" };
  /**
   * 每段实际应用的 scope / 不可得量声明（R35）。三段各自能支持的过滤范围不同：
   * roleOnly 只有 agentIds ∩ 时间窗（mesh 投递层无 sceneId），retrieval / reflection
   * 有 agentIds ∩ sceneIds ∩ 时间窗，scene 累计量只有 sceneIds（生命周期累计、不进时间窗）。
   */
  caveats: string[];

  /** mesh 层：原样展示计数器值 + 派生指标。 */
  meshCounters: {
    bucketGranularity: "hour";
    messagesTotal: number;
    deliveriesTotal: number;
    wakeIdle: number;
    wakeBusy: number;
    verbatimCopies: number;
    silentGrade: number;
    coldHit: number;
    derived: {
      wakePerMessage: number | null;
      wakePerMessageIdle: number | null;
      wakePerMessageBusy: number | null;
      verbatimPerMessage: number | null;
      silentRate: number | null;
      verbatimRate: number | null;
      coldHitRate: number | null;
    };
  };

  /** mesh 层重算（排除自省流后），来自 §20.2.4。 */
  roleOnly: {
    messagesTotal: number;
    deliveriesTotal: number;
    wakesTotal: number;
    silentRate: number | null;
    p1RatePerDelivery: number | null;
    unattributedAccounts: string[];
    caveats: string[];
  };

  /** 本环归一读数（本环口径，勿与 mesh 目标对比），来自 §20.2.3。 */
  roleNormalized: {
    turns: number;
    /** 发言消息数：需 mesh 事件流精确区分 cue/发言，当前不可得（null，不以 0 占位）。 */
    utteranceMessages: number | null;
    verbatimPerTurn: number | null;
    verbatimPerUtterance: number | null;
    audiencePerUtterance: number | null;
  };

  /** 本环层开销：mesh 完全看不见的部分。 */
  localOverhead: {
    retrieval: {
      calls: number;
      tokensL2: number;
      tokensL1: number;
      tokensTransient: number;
      tokensTotal: number;
      clampedCalls: number;
      p50Total: number;
      p95Total: number;
    };
    reflection: {
      runs: number;
      failed: number;
      episodesWritten: number;
      profilesTouched: number;
      wallMsTotal: number;
      /** 需 mesh 事件流（消息/投递/唤醒归因），当前不可得（null，不以 0 占位）。 */
      meshMessages: number | null;
      meshDeliveries: number | null;
      meshWakes: number | null;
    };
    sceneBudget: {
      tokenBudget: number | null;
      tokenSpent: number;
      overBudgetScenes: string[];
    };
  };

  /** 健康标记。 */
  health: {
    policyDegradedEvents: number;
    invariantViolatedEvents: number;
    danglingEvidence: number;
    evidenceLevelMix: { L0: number; L1: number; L2: number };
  };
}

// ─── 共享窗口类型 ──────────────────────────────────────────────────────────

export interface ObserveWindow {
  since: string;
  until: string;
}