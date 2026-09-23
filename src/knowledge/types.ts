// ═══════════════════════════════════════════════════════════════════════════
// 知识记忆（§17）—— 纯类型与纯函数
//
// 与 mesh 边界：**mesh 完全不参与本章**。知识状态落在 role-agent.db 的
// `knowledge_items` + `knowledge_events`。本章只定义：
//   · 七态掌握度状态机（§17.1）的封闭迁移集（T1–T11）与证据门槛（§17.2）；
//   · 误区（§17.4）的正交字段；
//   · 学习队列条目（§17.5.2）；
//   · 知识衰减（§17.5.1）的常量与 τ。
//
// 分层纪律：不 import @pi/agent-mesh（R1）、不出现 mesh_ 表名（R2）、不出现环境字段
// `ext` 的点访问（R3）。落库在 dao.ts / service.ts。
// ═══════════════════════════════════════════════════════════════════════════

/** 六值持久化掌握度（§17.1.1）。`unseen` 是隐含状态——「没有这一行」，永不落库。 */
export type Mastery = "heard" | "understood" | "applied" | "mastered" | "fading" | "forgotten";

/** 证据八值封闭集合（§17.2）。`taught` = 教会了别人；`mentioned` = 被提到（含别人教）。 */
export type EvidenceKind =
  | "mentioned"
  | "explained"
  | "self_explained"
  | "solved"
  | "taught"
  | "failed"
  | "corrected"
  | "decay";

/** 证据八值（与 knowledge_events.evidence_kind 的 CHECK 严格一致，§18.4.2）。 */
export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "mentioned",
  "explained",
  "self_explained",
  "solved",
  "taught",
  "failed",
  "corrected",
  "decay",
] as const;

/** 掌握度阶梯（用于「提升 / 降级」的偏序比较；fading/forgotten 不进此梯）。 */
const MASTERY_ORDER: Record<Mastery, number> = {
  heard: 1,
  understood: 2,
  applied: 3,
  mastered: 4,
  fading: -1,
  forgotten: -1,
};

/** 每个目标状态的最低证据集合（§17.2 表）。fading/forgotten 只由衰减任务写，不在此列。 */
const TARGET_EVIDENCE: Record<Exclude<Mastery, "fading" | "forgotten">, readonly EvidenceKind[]> = {
  heard: ["mentioned"],
  understood: ["explained", "self_explained"],
  applied: ["solved"],
  mastered: ["solved", "taught"],
} as const;

/** 自省可直接调整 confidence 的单次限幅（§17.1.3，与 trustDelta 同源）。 */
export const CONFIDENCE_DELTA_CAP = 0.15;

/** 知识衰减阈值（§17.5.1）：与 episodes 的 0.7/0.45/0.15 刻意不同。 */
export const KNOWLEDGE_DECAY = {
  /** retention < 0.35 ⇒ T7 降级到 fading。 */
  fade: 0.35,
  /** retention < 0.10 ⇒ T8 fading → forgotten。 */
  forget: 0.10,
  /** use_count 的 τ 乘数（§17.5.1：0.8 系数）。 */
  useCountFactor: 0.8,
} as const;

/** masteryFactor（§17.5.1）：mastered 衰减最慢。fading 取 1.0 兜底。 */
export const MASTERY_FACTOR: Record<Mastery, number> = {
  heard: 0.5,
  understood: 1.0,
  applied: 2.0,
  mastered: 4.0,
  fading: 1.0,
  forgotten: 1.0,
};

/**
 * 误区纠正情节的 salience 地板（§17.4.2）。系统注入，不交给 Agent 判断——
 * 被纠正的瞬间往往印象深刻。
 */
export const MISCONCEPTION_CORRECTION_SALIENCE_FLOOR = 0.75;

/** 一次知识状态迁移的提议（自省 propose → 服务校验 → 写入或驳回，§17.2）。 */
export interface KnowledgeUpdateProposal {
  /** 知识点标识，如 `kn:newton-2nd-law`，与 knowledge_items.topic / subject 的 `kn:*` 同源。 */
  topic: string;
  domain?: string;
  /** 「这个 Agent 现在认为它是什么」。缺省退化为 topic（§17.3 示例未给 claim 列）。 */
  claim?: string;
  toMastery: Mastery;
  evidenceKind: EvidenceKind;
  /** 自然语言的具体证据。 */
  evidence: string;
  /** 证据所在情节。须存在且 owner_agent === self（本环校验，非 mesh）。 */
  evidenceEpisode?: string;
  /** 归因（§17.3）：序列化 SubjectRef（"self" / "person:ag-teacher-01"）。默认 "self"。 */
  taughtBy?: string;
  /** 误区（§17.4）：置 1 表示「掌握度不低但内容错了」，与 mastery 正交。 */
  isMisconception?: boolean;
  /** 错误的正确理解（纠正后不清空，作为历史）。 */
  wrongBelief?: string;
  /** confidence 增量（§17.1.3），受 ±CONFIDENCE_DELTA_CAP 限幅。 */
  confidenceDelta?: number;
}

/** 一次迁移的裁决（KnowledgeService.applyUpdate 返回）。 */
export type KnowledgeVerdict =
  | {
      ok: true;
      knId: string;
      from: Mastery | null;
      to: Mastery;
      /** 本轮落库的 knowledge_events id（practice 无事件则为空数组；T5 跳级为两条）。 */
      eventIds: string[];
      /** true = 同态复述（T6），只维护计数不迁移。 */
      practiced: boolean;
    }
  | { ok: false; reason: KnowledgeRejectReason };

/** 六个失败原因（封闭集合，本环定义，非 mesh 错误码，§17.2）。 */
export type KnowledgeRejectReason =
  | "ILLEGAL_TRANSITION"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_NOT_OWNED"
  | "MASTERED_SPAN_TOO_SHORT"
  | "MASTERED_COUNT_TOO_FEW";

/** 学习队列条目（§17.5.2）。 */
export interface LearningQueueItem {
  topic: string; // kn:<slug>
  priority: "high" | "medium" | "low";
  motivation: string; // 「上次被问住了」/「竞赛要考」
}

/** classifyUpdate 的纯函数裁决（不落库；service 据它写）。 */
export type TransitionPlan =
  | {
      ok: true;
      from: Mastery | null; // null = unseen（无此行）
      to: Mastery; // 落库终态
      /** "none"=复述无事件；"one"=一条事件；"skip"=T5 跳级两条事件。 */
      events: "none" | "one" | "skip";
      /** 是否置 is_misconception=1（corrected/failed，§17.4）。 */
      markMisconception: boolean;
    }
  | { ok: false; reason: KnowledgeRejectReason };

/**
 * 封闭迁移集校验（§17.1.2 T1–T11 + §17.2 证据门槛）。
 *
 * `current` 为 null 表示无此行（unseen）。返回统一裁决：
 *   · T1 unseen→heard、T10 forgotten→heard —— 一条事件（mentioned）；
 *   · T2 heard→understood、T3 understood→applied、T4 applied→mastered —— 一条事件；
 *   · T5 heard→applied —— 跳级，两条事件（heard→understood→applied）；
 *   · T6 同态 / 「重教降级」—— 无事件（only practice_count/last_practiced 维护）；
 *   · T9 fading→higher —— 一条事件（任何 use 证据）；
 *   · T11 applied|mastered→understood（corrected/failed）—— 一条事件 + 置误区。
 * 纯函数，无 IO；T4 的「跨 2 虚拟日 / 2 次 solved」在 service 查库，不在此处。
 */
export function classifyUpdate(
  current: Mastery | null,
  to: Mastery,
  kind: EvidenceKind,
): TransitionPlan {
  // fading / forgotten / unseen 只由衰减任务或「无行」表达，Agent 不得提议写入（§17.1.2 T7/T8）。
  if (to === "fading" || to === "forgotten") {
    return { ok: false, reason: "ILLEGAL_TRANSITION" };
  }

  // T9：fading 恢复（再次被使用，任何 use 证据 → 回到更高状态）。
  if (current === "fading") {
    if (kind === "mentioned" || kind === "explained" || kind === "self_explained" || kind === "solved") {
      return { ok: true, from: "fading", to, events: "one", markMisconception: false };
    }
    return { ok: false, reason: "EVIDENCE_MISSING" };
  }

  // T10：forgotten 再接触 → heard。
  if (current === "forgotten") {
    if (to !== "heard") return { ok: false, reason: "ILLEGAL_TRANSITION" };
    return kind === "mentioned"
      ? { ok: true, from: "forgotten", to: "heard", events: "one", markMisconception: false }
      : { ok: false, reason: "EVIDENCE_MISSING" };
  }

  // T1：无行 → heard。
  if (current === null) {
    if (to !== "heard") return { ok: false, reason: "ILLEGAL_TRANSITION" };
    return kind === "mentioned"
      ? { ok: true, from: null, to: "heard", events: "one", markMisconception: false }
      : { ok: false, reason: "EVIDENCE_MISSING" };
  }

  // 纠错降级（T11）：applied|mastered → understood，证据 corrected/failed，并置误区。
  if (kind === "corrected" || kind === "failed") {
    if (current === "applied" || current === "mastered") {
      if (to !== "understood") return { ok: false, reason: "ILLEGAL_TRANSITION" };
      return { ok: true, from: current, to: "understood", events: "one", markMisconception: true };
    }
    // understood/heard 已不高于 understood：同态维护 + 置误区，不迁移。
    if (to === current || to === "heard") {
      return { ok: true, from: current, to: current, events: "none", markMisconception: true };
    }
    return { ok: false, reason: "ILLEGAL_TRANSITION" };
  }

  const order = MASTERY_ORDER[current];
  const orderTo = MASTERY_ORDER[to];
  if (orderTo === undefined || orderTo === -1) return { ok: false, reason: "ILLEGAL_TRANSITION" };

  if (orderTo === order) {
    // T6 同态：复述强化，无事件。
    return { ok: true, from: current, to: current, events: "none", markMisconception: false };
  }

  if (orderTo < order) {
    // 降级但不属于 T11（如 understood→heard「重教」）：§17.1.2 读法 —— 不产生迁移，只维护计数。
    return { ok: true, from: current, to: current, events: "none", markMisconception: false };
  }

  // 提升：验证阶梯边 + 证据。
  const allowed = TARGET_EVIDENCE[to];
  if (!allowed) return { ok: false, reason: "ILLEGAL_TRANSITION" };

  // 阶梯跳：只允许 applied 直接到 applied（T5）；heard→mastered / understood→mastered 非法。
  if (to === "mastered" && current !== "applied") {
    return { ok: false, reason: "ILLEGAL_TRANSITION" };
  }
  if (to === "applied" && current === "heard") {
    // T5 跳级：允许，但要补中间事件（heard→understood→applied）。
    if (kind !== "solved") return { ok: false, reason: "EVIDENCE_MISSING" };
    return { ok: true, from: current, to: "applied", events: "skip", markMisconception: false };
  }

  if (!allowed.includes(kind)) return { ok: false, reason: "EVIDENCE_MISSING" };
  return { ok: true, from: current, to, events: "one", markMisconception: false };
}