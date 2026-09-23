// ═══════════════════════════════════════════════════════════════════════════
// 检索排序 + 预算（§14.2 / §14.1.2 / §14.5.3）
//
// 排序公式（五项加权，与 §12.1 的 write 判分是两个不同公式，不合并）：
//   score = 0.40·relevance + 0.25·retention + 0.20·subjectMatch
//         + 0.10·recencyVirtual + 0.05·valenceExtremity
// relevance 经 bm25 取反后按**本次查询内**归一（§14.2.3）；faded/consolidated 候选
// 再乘 penalty（0.5），只在 relevance 足够高（强线索）时才可能入选。
//
// 预算（§14.1.2 / §14.5.3）：L1 卡片 900 token，自动注入与 recall 共享同一池，
// recall 保留 300 底线。TurnRetrievalLedger 是这一约束的唯一实现。
// ═══════════════════════════════════════════════════════════════════════════

import { DISTORTION_THRESHOLDS, RECALL_QUOTA, RETRIEVAL, RETRIEVAL_BUDGET, SORT_WEIGHTS } from "./constants.js";
import { estimateTokens, projectEpisode, renderMemoryCard, type RenderCardInput } from "./render.js";
import type { EpisodeCandidate } from "./dao.js";
import type { SubjectRef } from "./subject.js";

export interface RankContext {
  nowHours: number;
  tau0Hours: number;
  /** 当前在场主体的 id 集合（person:agent_id / facility:id / self 的 "self"）。 */
  presentSubjects: ReadonlySet<string>;
}

export interface RankedCandidate {
  candidate: EpisodeCandidate;
  relevance: number;
  subjectMatch: number;
  recencyVirtual: number;
  valenceExtremity: number;
  score: number;
}

/** bm25 负值取反后按本次查询最大值归一（§14.2.3 normalizeRelevance）。 */
function normalizeRelevance(bm25Values: number[]): number[] {
  const s = bm25Values.map((b) => -b);
  const max = Math.max(...s, 1e-9);
  return s.map((v) => v / max);
}

/**
 * subjectMatch：命中主体数 / 记忆主体数（分母是记忆的主体数，不是在场人数）。
 * 无主体情节给基线分 RETRIEVAL.noSubjectBaseline；self 主体恒命中（§8 段自主恒命中）。
 */
function subjectMatchOf(subjects: SubjectRef[], present: ReadonlySet<string>): number {
  if (subjects.length === 0) return RETRIEVAL.noSubjectBaseline;
  let hit = 0;
  for (const s of subjects) {
    if (s.type === "self" || present.has(s.id)) hit += 1;
  }
  return hit / subjects.length;
}

/** 打分并排序（带主体集合，真实路径）。返回 score 降序（faded/consolidated 已乘 penalty）。 */
export function rankCandidatesWithSubjects(
  candidates: EpisodeCandidate[],
  subjectsByEpisode: Map<string, SubjectRef[]>,
  ctx: RankContext,
): RankedCandidate[] {
  const relevances = normalizeRelevance(candidates.map((c) => c.bm25));
  const ranked: RankedCandidate[] = candidates.map((c, i) => {
    const relevance = relevances[i]!;
    const retention = c.retention;
    const subjects = subjectsByEpisode.get(c.episodeId) ?? [];
    const subjectMatch = subjectMatchOf(subjects, ctx.presentSubjects);
    const ageHours = Math.max(0, ctx.nowHours - c.virtualHours);
    const recencyVirtual = Math.exp(-ageHours / Math.max(ctx.tau0Hours, 1e-9));
    const valenceExtremity = Math.abs(c.valence ?? 0);
    let score =
      SORT_WEIGHTS.relevance * relevance +
      SORT_WEIGHTS.retention * retention +
      SORT_WEIGHTS.subjectMatch * subjectMatch +
      SORT_WEIGHTS.recencyVirtual * recencyVirtual +
      SORT_WEIGHTS.valenceExtremity * valenceExtremity;
    if (c.status !== "active") score *= RETRIEVAL.fadedMatchPenalty;
    return { candidate: c, relevance, subjectMatch, recencyVirtual, valenceExtremity, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/** faded 记忆只在其 relevance 达到强线索阈值时才保留为候选（§14.2.4）。 */
export function strongCueFilter(ranked: RankedCandidate[], includeFaded: boolean): RankedCandidate[] {
  if (includeFaded) {
    return ranked.filter(
      (r) => r.candidate.status === "active" || r.relevance >= DISTORTION_THRESHOLDS.fadedRecallRelevance,
    );
  }
  return ranked.filter((r) => r.candidate.status === "active");
}

/**
 * 轮级预算账本（§14.5.3）。turn 开始重置；自动注入先扣、保留 recall 底线；
 * recall 占用整个 cap 的余量。
 */
export class TurnRetrievalLedger {
  private used = 0;
  private calls = 0;

  constructor(
    private readonly cap: number = RETRIEVAL_BUDGET.l1,
    private readonly recallFloor: number = RECALL_QUOTA.recallFloor,
  ) {}

  /** 自动注入走这条：可用额度扣掉给 recall 预留的底线。返回实际获批 token。 */
  reserveAuto(tokens: number): number {
    return this.take(tokens, this.cap - this.recallFloor);
  }

  /** recall 走这条：可用额度是整个 cap 的余量。 */
  reserveRecall(tokens: number): number {
    return this.take(tokens, this.cap);
  }

  /** 每轮 recall 调用次数是否还允许（≤ callsPerTurn）。 */
  tryRecall(limit = RECALL_QUOTA.callsPerTurn): boolean {
    return this.calls++ < limit;
  }

  usedTokens(): number {
    return this.used;
  }

  /** 本轮已发生的 recall 调用次数（供 recall 返回 quotaRemaining）。 */
  callCount(): number {
    return this.calls;
  }

  private take(tokens: number, ceiling: number): number {
    const grant = Math.max(0, Math.min(tokens, ceiling - this.used));
    this.used += grant;
    return grant;
  }
}

/**
 * 按分数选卡片直到 token 预算耗尽。返回入选卡片（已渲染）与预算账。
 * `isRecall` 决定走 auto（600 顶）还是 recall（900 全量）的遗留逻辑，由 ledger 方法体现。
 */
export function selectCards(
  ranked: RankedCandidate[],
  render: (c: RankedCandidate) => string,
  ledger: TurnRetrievalLedger,
  isRecall: boolean,
  perCardCap = RECALL_QUOTA.perCallTokenCap,
): { cards: string[]; selectedIds: string[]; tokens: number; clamped: number } {
  const cards: string[] = [];
  const selectedIds: string[] = [];
  let tokens = 0;
  let clamped = 0;
  for (const r of ranked) {
    const text = render(r);
    const t = estimateTokens(text);
    // recall 单次返回 cap（600）：超出丢弃后续所有卡片。
    if (isRecall && t > perCardCap) {
      clamped += 1;
      continue;
    }
    const grant = isRecall ? ledger.reserveRecall(t) : ledger.reserveAuto(t);
    if (grant <= 0) {
      clamped += 1;
      continue;
    }
    // 若卡片 token 超过当次获批（grant < t），按获批截断不注入，丢弃该卡。
    if (grant < t) {
      clamped += 1;
      continue;
    }
    cards.push(text);
    selectedIds.push(r.candidate.episodeId);
    tokens += t;
  }
  return { cards, selectedIds, tokens, clamped };
}

/**
 * 渲染单个候选成 `<<<MEMORY … MEMORY>>>` 卡片的工厂（把当前虚拟时钟与主体标签固化为闭包）。
 * `labelOf` 把 subject_id 解析成显示名（person → 已知 Agent displayName，其余退化为 id）。
 */
export function makeRankedCardRenderer(opts: {
  subjectsByEpisode: Map<string, SubjectRef[]>;
  nowHours: number;
  labelOf?: (ref: SubjectRef) => string;
}): (c: RankedCandidate) => string {
  return (c) => {
    const subjects = opts.subjectsByEpisode.get(c.candidate.episodeId) ?? [];
    const subjectLabels = subjects.map((s) => opts.labelOf?.(s) ?? s.id);
    const input: RenderCardInput = {
      kind: c.candidate.kind,
      projected: projectEpisode(c.candidate),
      retention: c.candidate.retention,
      confidence: c.candidate.confidence,
      virtualHours: c.candidate.virtualHours,
      nowHours: opts.nowHours,
      subjects,
      subjectLabels,
    };
    return renderMemoryCard(input);
  };
}