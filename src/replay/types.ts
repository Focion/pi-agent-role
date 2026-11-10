// ═══════════════════════════════════════════════════════════════════════════
// 回放与比较公开类型（H03 / R37 / R38）
//
// 记录回放只读当时保存的逐轮/空轮领域决策与检索快照，核对 hash/指纹/来源，
// 缺失或裁剪信息显式标记（fidelity / integrity / missing），当前配置不冒充历史。
// 隔离重执行在独立新环境里用冻结探针脚本 + 冻结虚拟时间/预算重跑领域决策机制。
//
// 分层纪律（§22.4）：本文件不含 @pi/agent-mesh 依赖，纯类型。
// ═══════════════════════════════════════════════════════════════════════════

/** 记录回放的单条领域判定（逐轮/空轮）。components 缺失时 fidelity 降级。 */
export interface DomainDecisionRecord {
  ownerAgent: string;
  sourceMsgId: string;
  path: "P1" | "P2" | "P3";
  score: number;
  writeDecided: boolean;
  written: boolean;
  nudged: boolean;
  virtualTs: string;
  decidedAt: string;
  components: Record<string, unknown> | null;
  fidelity: "full" | "components_missing";
}

/** 检索快照完整性：卡片哈希核对卡片正文。 */
export type RetrievalIntegrity = "ok" | "missing_card" | "hash_mismatch";

export interface RetrievalRecord {
  retrievalId: string;
  sceneId: string | null;
  turn: number | null;
  triggerMsgId: string | null;
  query: unknown;
  candidates: number;
  selectedIds: string[];
  tokens: { l2: number; l1: number; transient: number; total: number };
  clamped: number;
  modelConfigHash: string | null;
  renderedCardSha256: string | null;
  integrity: RetrievalIntegrity;
}

/** agent 指纹（当前/冻结）：只作可审计标识，不重建未记录的历史最终 prompt。 */
export interface AgentFingerprint {
  specHash: string | null;
  blueprintHash: string | null;
  modelConfigHash: string | null;
}

/** 记忆/知识/自省计数（管理视图口径，跨 owner 不含）。 */
export interface ReplayMemoryCounts {
  episodes: number;
  subjects: number;
  knowledgeItems: number;
  reflections: number;
}

/** 成本：record 回放无权威用量（需 mesh 计数器/真实模型，不占位为 0）；重执行给注入口径。 */
export interface ReplayCost {
  source: "injected";
  tokensIn: number;
  tokensOut: number;
  steps: number;
}

export interface DomainDecisionReplay {
  source: "recorded" | "reexecuted";
  ownerAgent: string;
  fingerprint: AgentFingerprint;
  span: { since: string | null; until: string | null };
  turns: DomainDecisionRecord[];
  retrievals: RetrievalRecord[];
  memory: ReplayMemoryCounts;
  cost: ReplayCost | null;
  /** 缺失信息标记（裁剪/无指纹/无卡片/无组件等），逐条描述原因。 */
  missing: string[];
}

export interface ReplayRecordOptions {
  sceneId?: string;
  since?: string;
  until?: string;
  maxItems?: number;
}

/** 冻结探针脚本的一步：投递消息 + 可选固定领域工具动作。全部字段冻结，实际执行不依赖模型。 */
export interface ReplayProbeStep {
  /** 探针消息正文（发送方账号 id 固定）。 */
  text: string;
  from: string;
  virtualTs?: string;
  sceneId?: string;
  turn?: number;
  /** 该轮固定调用的工具动作。不填即纯观察（written 由是否 remember 决定）。 */
  remember?: string;
  recall?: string;
  noteSelf?: string;
}

export interface ReplayReexecuteInput {
  /** 冻结身份指纹：来自此前 record 回放读出的 fingerprint，回放挂起用，不重新编译、不伪造。 */
  fingerprint: AgentFingerprint;
  /** 冻结探针脚本（逐轮确定）。 */
  probes: ReplayProbeStep[];
  /** 冻结虚拟时钟起点（缺省 W1D1T8）。 */
  virtualStart?: string;
  /** 每步推进的虚拟分钟；用于派生缺省 virtualTs（peek 前级）。 */
  stepMinutes?: number;
  /** 冻结记忆策略（缺省 defaultMemoryPolicy）。 */
  policy?: unknown;
  /** 冻结每步 token 用量，作为重执行的新成本分账来源（缺省 0）。 */
  usagePerStep?: { tokensIn: number; tokensOut: number };
}

/** compare 的一侧摘要。 */
export interface ReplayCompareSide {
  ownerAgent: string;
  source: "recorded" | "reexecuted";
  specHash: string | null;
  blueprintHash: string | null;
}

export interface ReplayCompareMetric {
  key: string;
  left: number;
  right: number;
  delta: number;
}

export interface ReplayCompareResult {
  left: ReplayCompareSide;
  right: ReplayCompareSide;
  memory: ReplayCompareMetric[];
  decisions: ReplayCompareMetric[];
  retrieval: ReplayCompareMetric[];
  cost: ReplayCompareMetric[] | null;
  sameMemory: boolean;
  sameDecisions: boolean;
}