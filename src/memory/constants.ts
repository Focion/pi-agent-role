// ═══════════════════════════════════════════════════════════════════════════
// 记忆常量（§14 / §15）—— 全局常量，不进 MemoryPolicy、不进任何附录表
//
// 失真阈值由 F3 规定为「封闭的代码常量」：若让 `detailRetention` 高的角色把 quote 阈值
// 压到 0.4，「记不清原话」这个跨角色可比的现象就没了。它们的封闭性由 F3 + 单测保证。
//
// 本文件不 import @pi/agent-mesh（R1）、不出现 mesh_ 表名（R2）、不出现环境字段 `ext` 的点访问
// （R3）。它只是数字。
// ═══════════════════════════════════════════════════════════════════════════

/** 失真三段阈值（§15.3）：作用在「注入」上，不作用在「存储」上（F1）。 */
export const DISTORTION_THRESHOLDS = {
  /** < 0.70 不再注入原话 quote。 */
  quote: 0.7,
  /** < 0.45 不再注入细节 detail。 */
  detail: 0.45,
  /** < 0.15 转 faded（默认不再被常规检索召回）。 */
  fade: 0.15,
  /** faded 记忆被强线索唤起所需的最低 relevance（§14.2.4）。 */
  fadedRecallRelevance: 0.75,
} as const;

/** 检索分层硬上限（§14.1.2）。L2 优先于 L1，次序不可反。 */
export const RETRIEVAL_BUDGET = {
  l3: 1200,
  l2: 500,
  l1: 900,
  transient: 150,
  total: 2750,
} as const;

/** recall 配额（§14.5.3）：与自动注入共享 L1 的 900 token 池，但保留 300 底线。 */
export const RECALL_QUOTA = {
  /** 无论如何留给 recall 的底线（自动注入最多只能用 cap−floor）。 */
  recallFloor: 300,
  /** 单次 recall 返回卡片数默认值。 */
  defaultCards: 3,
  /** 单次 recall 返回卡片数上限（超限静默截断）。 */
  maxCards: 5,
  /** 单次 recall 返回 token 上限。 */
  perCallTokenCap: 600,
  /** 每轮 recall 调用次数上限。 */
  callsPerTurn: 2,
} as const;

/** 检索排序加权（§14.2.1）。五项归一 [0,1]，权重和为 1。 */
export const SORT_WEIGHTS = {
  relevance: 0.4,
  retention: 0.25,
  subjectMatch: 0.2,
  recencyVirtual: 0.1,
  valenceExtremity: 0.05,
} as const;

/** 复述强化与候选检索参数（§14.2.3 / §14.4）。 */
export const RETRIEVAL = {
  /** 常规命中并注入后的 retention 增量（§14.4.2）。 */
  regularBoost: 0.08,
  /** 强线索唤起 faded 记忆的 retention 增量（§15.2）。 */
  strongCueBoost: 0.15,
  /** faded/consolidated 记忆参与最终排序时乘的折扣（§14.2.4 的 penalty）。 */
  fadedMatchPenalty: 0.5,
  /** FTS 候选查询的 LIMIT（§14.2.3 candidateLimit）。 */
  candidateLimit: 50,
  /** 无主体情节的 subjectMatch 基线分（§14.2.1）。 */
  noSubjectBaseline: 0.3,
} as const;

/** 写入端的常量（§12.3 / §12.4 / §12.6）。 */
export const WRITE = {
  /** remember 指向本 Agent 从未接触过的 person 时自动降权到的 weight（§12.3）。 */
  unknownSubjectWeight: 0.3,
  /** B 模式兜底追问连续未果的熔断次数（§12.4）。 */
  nudgeCircuitBreaker: 5,
  /** 最近 20 条 gist 用于 novelty/repetition 与发送方 selfRelevance 比对（§12.1.3）。 */
  recentGistLimit: 20,
} as const;

/** 折叠溢出补写的 observation 记忆的 confidence（§12.1.2 ③）。 */
export const OBSERVATION_CONFIDENCE = 0.4;