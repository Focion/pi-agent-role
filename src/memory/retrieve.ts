// ═══════════════════════════════════════════════════════════════════════════
// 检索排序 + 预算（§14.2 / §14.1.2 / §14.5.3）
//
// 排序公式（五项加权，与 §12.1 的 write 判分是两个不同公式，不合并）：
//   score = 0.40·relevance + 0.25·retention + 0.20·subjectMatch
//         + 0.10·recencyVirtual + 0.05·valenceExtremity
// relevance 由后端导出（FTS5 为 -bm25，向量为相似度），越高越相关，按**本次查询内**归一
// （§14.2.3）；faded/consolidated 候选再乘 penalty（0.5），只在 relevance 足够高（强线索）
// 时才可能入选。
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

/** 后端 relevances（越高越相关）按本次查询最大值归一（§14.2.3）；负值截断为 0，
 *  兼容尚未取反的裸向量后端。 */
function normalizeRelevance(values: number[]): number[] {
  const clamped = values.map((v) => (v < 0 ? 0 : v));
  const max = Math.max(...clamped, 1e-9);
  return clamped.map((v) => v / max);
}

/** 主体的在场集合 key：self 恒 "self"，其余为 `${type}:${id}`（A27）。 */
function subjectKey(s: SubjectRef): string {
  return s.type === "self" ? "self" : `${s.type}:${s.id}`;
}

/**
 * subjectMatch：命中主体数 / 记忆主体数（分母是记忆的主体数，不是在场人数）。
 * 无主体情节给基线分 RETRIEVAL.noSubjectBaseline；self 主体恒命中（§8 段自主恒命中）。
 * 在场集合用 (type,id) 全形 key，避免 person:B / facility:B 类型空间混淆（A27）。
 */
function subjectMatchOf(subjects: SubjectRef[], present: ReadonlySet<string>): number {
  if (subjects.length === 0) return RETRIEVAL.noSubjectBaseline;
  let hit = 0;
  for (const s of subjects) {
    if (s.type === "self" || present.has(subjectKey(s))) hit += 1;
  }
  return hit / subjects.length;
}

/** 打分并排序（带主体集合，真实路径）。返回 score 降序（faded/consolidated 已乘 penalty）。 */
export function rankCandidatesWithSubjects(
  candidates: EpisodeCandidate[],
  subjectsByEpisode: Map<string, SubjectRef[]>,
  ctx: RankContext,
): RankedCandidate[] {
  const relevances = normalizeRelevance(candidates.map((c) => c.relevance));
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
    // A25：整卡获批才扣账；剩余额度装不下一张卡时返回 0，不产生「先占部分再丢弃」的消耗。
    const available = ceiling - this.used;
    if (available < tokens) return 0;
    this.used += tokens;
    return tokens;
  }
}

/**
 * 按分数选卡片直到 token 预算耗尽。返回入选卡片（已渲染）与预算账。
 * `isRecall` 决定走 auto（600 顶）还是 recall（900 全量）的额度路径，由 ledger 方法体现。
 * `callCap` 是**单次 recall 返回总量**上限（§14.5.3 perCallTokenCap），跨卡累计判断，
 * 不是单卡判断（A26）；auto 注入无单次上限，仅受共享 L1 池约束。
 */
export function selectCards(
  ranked: RankedCandidate[],
  render: (c: RankedCandidate) => string,
  ledger: TurnRetrievalLedger,
  isRecall: boolean,
  callCap = RECALL_QUOTA.perCallTokenCap,
): { cards: string[]; selectedIds: string[]; tokens: number; clamped: number } {
  const cards: string[] = [];
  const selectedIds: string[] = [];
  let tokens = 0;
  let clamped = 0;
  let callTokens = 0;
  for (const r of ranked) {
    const text = render(r);
    const t = estimateTokens(text);
    // 单次 recall 返回总量上限：跨卡累计，超出即裁掉剩余卡片（A26）。
    if (isRecall && callTokens + t > callCap) {
      clamped += 1;
      continue;
    }
    // 共享池整卡获取：不足则丢弃且不扣账（A25）。
    const grant = isRecall ? ledger.reserveRecall(t) : ledger.reserveAuto(t);
    if (grant < t) {
      clamped += 1;
      continue;
    }
    cards.push(text);
    selectedIds.push(r.candidate.episodeId);
    tokens += t;
    callTokens += t;
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