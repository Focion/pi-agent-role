// ═══════════════════════════════════════════════════════════════════════════
// 自省与巩固（§13 / §15.2）—— 纯类型与纯函数
//
// 不 import @pi/agent-mesh（R1）、不出现 mesh_ 表名（R2）、不出现环境字段 ext 的点访问（R3）。
// 只定义：触发器六值、三档深度、反射往返载荷的契约、以及 delta 限幅 / 三档分级的
// 纯函数。落库与发送在 dao.ts / service.ts。
// ═══════════════════════════════════════════════════════════════════════════

import type { MemoryPolicy } from "../compile/types.js";
import type { KnowledgeUpdateProposal, LearningQueueItem } from "../knowledge/types.js";

/** 触发器六值（§13.2），优先级判定在 service.ts。 */
export type ReflectionTrigger =
  | "episodes_since"
  | "scene_end"
  | "arousal_spike"
  | "pre_compaction"
  | "daily"
  | "manual";

/** 三档深度（§13.3）：skip 不reflect；light 只做衰减 sweep；full 走一次 reflect 往返。 */
export type ReflectionDepth = "skip" | "light" | "full";

/** DB 列 reflections.trigger 的封闭四值（001_init.sql §18.4.3）。 */
const TRIGGER_COLUMN = {
  episodes_since: "threshold",
  arousal_spike: "threshold",
  scene_end: "scene_end",
  pre_compaction: "periodic",
  daily: "periodic",
  manual: "manual",
} as const;

/** 触发器 → reflections.trigger 落库值（六值折叠进封闭四值，与 schema 注释一致）。 */
export function triggerColumn(t: ReflectionTrigger): string {
  return TRIGGER_COLUMN[t];
}

/**
 * 三档分级（§13.3）：
 *   · pre_compaction / arousal_spike / manual → full（显式/导火索，恒深挖）
 *   · scene_end → 自上次后有条情节才 full，否则 light（只衰减收尾）
 *   · episodes_since → 条数达到 episodesPerReflection 才 full，否则 skip
 *   · daily → light（只衰减节拍）
 */
export function gradeDepth(
  trigger: ReflectionTrigger,
  opts: { episodesSinceCount: number; maxArousal: number; episodesPerReflection: number },
): ReflectionDepth {
  switch (trigger) {
    case "pre_compaction":
    case "arousal_spike":
    case "manual":
      return "full";
    case "scene_end":
      return opts.episodesSinceCount > 0 ? "full" : "light";
    case "episodes_since":
      return opts.episodesSinceCount >= opts.episodesPerReflection ? "full" : "skip";
    case "daily":
      return "light";
  }
}

/** 一条主体画像的增量（§13.4.2）。subject 用序列化后的 SubjectRef 字面量（"self" / "person:x"）。 */
export interface ProfileDelta {
  /** 序列化 SubjectRef，如 "self" / "person:aria" / "facility:classroom"。 */
  subject: string;
  /** 整体印象（整段覆写；§13.4.2 impression 是「重写」不是「追加」）。 */
  impression?: string;
  /** 情感价（覆盖）。 */
  valence?: number;
  /** 亲近度增量（Δ，非绝对值；K3 限幅后累加）。 */
  closenessDelta?: number;
  /** 信任度增量（Δ；facility/self 不适用）。 */
  trustDelta?: number;
  /** 特质 JSON（覆盖）。 */
  traits?: unknown;
}

/** 一条巩固（§15.2 L1→L2）：多条 active 情节折成一条 impression。 */
export interface ConsolidationSpec {
  /** 待折的原 L1 情节 id（须全属 owner，否则整次拒绝）。 */
  episodeIds: string[];
  gist: string;
  salience?: number;
}

/** 一条自我洞察（kind 'self'）。 */
export interface SelfInsight {
  gist: string;
  detail?: string;
  salience?: number;
}

/** 状态微调（mood 文字 + intensity/energy 的 Δ，K3 限幅）。 */
export interface StateAdjust {
  mood?: string;
  moodDelta?: number;
  energyDelta?: number;
}

/** 知识更新（§13.4.2 #3 结构化结论，§17.2 提案契约；校验与落库在 KnowledgeService）。 */
export type KnowledgeUpdate = KnowledgeUpdateProposal;

/** 反射往返的「结果」契约（reflect_result 工具的 updates 载荷，§13.4.2）。 */
export interface ReflectionOutput {
  /** 本轮自省实际依据的情节 id（证据声明；须全属 owner）。 */
  basedOnEpisodes?: string[];
  /** 欲与出结论情节合并的 id（须全属 owner）。 */
  mergeEpisodeIds?: string[];
  profileUpdates?: ProfileDelta[];
  consolidations?: ConsolidationSpec[];
  selfInsights?: SelfInsight[];
  knowledgeUpdates?: KnowledgeUpdate[];
  stateAdjust?: StateAdjust;
  /** 本轮仍未澄清、留给下次自省继续思考的问题（§13.4.1 旧问题连续，R17）。 */
  openQuestions?: string[];
  /** 留给下次的学习意图（§17.5.2 第 6 项）。服务层整理后存 output_json。 */
  learningQueue?: LearningQueueItem[];
}

/** 发给自省流的输入摘要（cue 的正文源，§13.4.1）。 */
export interface ReflectionInput {
  trigger: ReflectionTrigger;
  sceneId?: string;
  virtualTs: string;
  virtualHours: number;
  episodesSinceCount: number;
  sinceStartedAt: string;
  maxArousal: number;
  episodes: Array<{
    episodeId: string;
    kind: string;
    gist: string;
    detail: string | null;
    quote: string | null;
    emotion: string | null;
    valence: number | null;
    arousal: number | null;
    salience: number;
    retention: number;
    status: string;
    virtualTs: string | null;
    sceneId: string | null;
  }>;
  profiles: Array<{
    subject: string;
    impression: string | null;
    valence: number | null;
    closeness: number | null;
    trust: number | null;
    episodeCount: number;
  }>;
  knowledgeSummary: string;
  /** 上一轮留下的学习队列（§17.5.2）：模型应继续处理的问题（A22 完整可引用输入）。 */
  learningQueue?: LearningQueueItem[];
  /** 上一轮仍未澄清的问题（§13.4.1 旧问题连续，R17）。 */
  openQuestions?: string[];
  currentState: { mood: string; moodIntensity: number; energy: number };
  /** 仅 pre_compaction 档：即将被压缩、尚未入记忆的角色消息（§15.4 抢救提炼）。 */
  preCompactMessages?: Array<{ msgId: string; text: string }>;
}

/** run() 的单次结果（供 ReflectApi 与测试观察）。 */
export interface ReflectionRunResult {
  agentId: string;
  trigger: ReflectionTrigger;
  depth: ReflectionDepth;
  sent: boolean;
  reflectionId?: string;
  /** light 档衰减扫到的 active 条数。 */
  decayed?: number;
  /** 未发送的原因（无 reflect 流 / 无情节等）。 */
  skipped?: string;
  /**
   * 仅 pre_compaction 档（harvest）：有界等待 reflect_result 落地后的结果。
   *   · true  —— 自省流已回传并落地（提炼完成，来源已记为已消化）；
   *   · false —— 超过 resultTimeoutMs 仍未落地（cue 已在途，稍后仍会异步落地，不吞错）。
   * 非 pre_compaction 档保持 undefined（run 仍是 fire-and-forget 语义，§15.4/R20）。
   */
  settled?: boolean;
}

/** subject_profiles 一行（DAO 反查快照）。 */
export interface ProfileRow {
  impression: string | null;
  valence: number | null;
  closeness: number | null;
  trust: number | null;
}

/** applyResult（reflect_result 落地）的返回值。 */
export interface ReflectionApplyResult {
  reflectionId: string;
  episodesWritten: number;
  profilesTouched: number;
  /** 知识迁移：接受的条数（§13.4.3 ⑦ 只回计数，不回原因）。 */
  knowledgeAccepted: number;
  knowledgeRejected: number;
}

/** R34：自省流账号的累计用量快照（镜像 pi-backend 的 UsageBreakdown，形状在此分离）。 */
export interface UsageSnapshot {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
}

/** ReflectApi.read 的快照。 */
export interface ReflectSnapshot {
  profiles: Array<{
    subject: string;
    impression: string | null;
    valence: number | null;
    closeness: number | null;
    trust: number | null;
    episodeCount: number;
  }>;
  reflections: Array<{
    reflectionId: string;
    trigger: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    episodesWritten: number;
    profilesTouched: number;
  }>;
  state: { mood: string; moodIntensity: number; energy: number };
}