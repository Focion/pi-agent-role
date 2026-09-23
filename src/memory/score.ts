// ═══════════════════════════════════════════════════════════════════════════
// 打分函数（§12.1.3 / §12.5）—— 纯函数，无 IO、无 LLM
//
// `scoreMemorability` 回答「这件事值得记吗」，`scoreSenderMemorability` 回答「我说的
// 这句话值得我自己记吗」。两者与 §14.2 的检索排序是两个**不同**的公式，不合并。
//
// 归属分工（§12.1.3）：打分与阈值是确定性代码（可回放，mesh §23.2 要求策略与判定
// 纯函数式）；gist / detail / emotion / 主体归因由 Agent 经 remember 工具写（主观）。
//
// songs 纯函数契约：只吃已解码的 MemoryTrigger（`ext` 已由 src/mesh/ext-role.js 解出），
// 因此本文件不出现环境字段 `ext` 的点访问（R3）。
// ═══════════════════════════════════════════════════════════════════════════

import type { MemoryPolicy } from "../compile/types.js";
import type { RoleExt } from "../mesh/ext-role.js";

/** 三条进上下文路径（mesh §7.6）。 */
export type MemoryPath = "P1" | "P2" | "P3";

/** 一条待判定消息的「记忆视角」（从 Envelope + 已解码 RoleExt 而来）。 */
export interface MemoryTrigger {
  messageId: string;
  /** 发送方 accountId（mesh 的 from，一个字符串）。 */
  from: string;
  text: string;
  path: MemoryPath;
  roleExt: RoleExt;
  kind: string;
  to?: string[];
  mentions?: string[];
}

export interface Score {
  salience: number;
  write: boolean;
  /** 六路组件，可解释性——「为什么这件事他没记住」的唯一答案（§12.1.3）。 */
  components: Record<string, number>;
}

/** 打分所需的外部信号（由 MemoryService 经 DAO / 注册表解析后注入，保持本文件纯）。 */
export interface ScoreSignals {
  /** 接收方（记忆的主人）的 accountId。 */
  currentAccountId: string;
  /** 发送方角色（由 accountId 反查注册表，不读 ext，§12.1.3）。 */
  senderRole: string;
  /** 对发送方的信任度（读 subject_profiles.trust，未知主体用 defaultTrust，§12.6）。 */
  trustOfSender: number;
  /** 主人最近 20 条 gist，用于 novelty 与 repetition。 */
  recentGists: string[];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ─── 字面相关度：trigram（中文零依赖，§14.2.3 同源）────────────────────────

function trigrams(s: string): Set<string> {
  const t = new Set<string>();
  const str = s.replace(/\s+/g, "");
  for (let i = 0; i + 2 < str.length + 1 && i + 3 <= str.length; i++) {
    t.add(str.slice(i, i + 3));
  }
  // 短文本（<3 字）退化为整串 + 双字
  if (str.length < 3) t.add(str);
  if (str.length >= 2) t.add(str.slice(0, 2));
  return t;
}

/** Dice 系数：2·|A∩B| / (|A|+|B|)，∈ [0,1]。空集两两为 0。 */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

export function maxSimilarity(text: string, gists: string[]): number {
  let best = 0;
  for (const g of gists) {
    const s = trigramSimilarity(text, g);
    if (s > best) best = s;
  }
  return best;
}

// ─── 情绪唤醒（确定性启发式，无 LLM）────────────────────────────────────────

const NEGATIVE_AFFECT: readonly string[] = [
  "失败", "错", "批评", "骂", "生气", "哭", "怕", "担心", "讨厌",
  "恨", "难过", "委屈", "罚", "糟糕", "崩溃", "缺", "不会",
];
const HIGH_AROUSAL: readonly string[] = [
  "惊喜", "太棒", "厉害", "佩服", "震惊", "居然", "竟然", "激动", "太好了",
];

/** 文本情绪唤醒度 [0,1]。纯字符/词表启发式，可回放。 */
export function emotionalArousal(text: string): number {
  // 2..3 字中文滑窗计数，避免重复标点把分数顶爆
  let hits = 0;
  const exclam = (text.match(/[!！]/g) ?? []).length;
  const quest = (text.match(/[?？]/g) ?? []).length;
  hits += Math.min(3, exclam) + Math.min(2, quest);
  for (const w of NEGATIVE_AFFECT) if (text.includes(w)) hits += 1;
  for (const w of HIGH_AROUSAL) if (text.includes(w)) hits += 1;
  return clamp01(hits * 0.12);
}

// ─── 主体 / 提及 ─────────────────────────────────────────────────────────────

function mentionsSelf(t: MemoryTrigger, accountId: string): boolean {
  return t.mentions?.includes(accountId) ?? false;
}

function addressedTo(t: MemoryTrigger, accountId: string): boolean {
  return t.to?.includes(accountId) ?? false;
}

/** hintWeight（§12.6）：信任度 × hint.importance。信任未知 ⇒ defaultTrust，发送方改不到。 */
function hintWeightOf(t: MemoryTrigger, trustOfSender: number): number {
  const hint = t.roleExt.rememberHint;
  const importance = typeof hint?.importance === "number" ? hint.importance : 0;
  return trustOfSender * clamp01(importance);
}

// ─── 主打分（§12.1.3，v2 入参差异见 §12.1.3 表）─────────────────────────────

/**
 * 接收方记忆判定。`signals.recentGists` 用于 novelty 与 repetition（同一份比对集）。
 * `components` 必须保留进 memory_decisions.components_json。
 */
export function scoreMemorability(
  t: MemoryTrigger,
  p: MemoryPolicy,
  signals: ScoreSignals,
): Score {
  const text = t.text || "";
  const hint = t.roleExt.rememberHint;

  const novelty = 1 - maxSimilarity(text, signals.recentGists);
  const arousal = clamp01(emotionalArousal(text) * p.arousalGain);
  const selfRelevance = mentionsSelf(t, signals.currentAccountId)
    ? 1
    : addressedTo(t, signals.currentAccountId)
      ? 0.7
      : 0.3;
  const hintWeight = hintWeightOf(t, signals.trustOfSender);
  const similarPrior = signals.recentGists.filter((g) => trigramSimilarity(text, g) >= 0.5).length;
  const repetition = similarPrior > 1 ? 0.6 : 0;
  const authority = p.authorityWeights[signals.senderRole] ?? 0.5;

  const raw =
    p.w.novelty * novelty +
    p.w.arousal * arousal +
    p.w.selfRelevance * selfRelevance +
    p.w.hint * hintWeight +
    p.w.repetition * repetition +
    p.w.authority * authority;

  // P2 只看到未读摘要：原文 quote 一路为空，打分照走但打折扣（§12.1.2②）。
  const damp = t.path === "P2" ? p.p2Damping : 1;
  const salience = clamp01(raw * damp);

  return {
    salience,
    write: raw * damp >= p.writeThreshold,
    components: { novelty, arousal, selfRelevance, hintWeight, repetition, authority },
  };
}

/** 发送方记忆判定（§12.5）：selfRelevance 恒 1、hint 与 authority 缺席。 */
export function scoreSenderMemorability(
  t: MemoryTrigger,
  p: MemoryPolicy,
  signals: Omit<ScoreSignals, "trustOfSender" | "senderRole">,
): Score {
  const text = t.text || "";

  const novelty = 1 - maxSimilarity(text, signals.recentGists);
  const arousal = clamp01(emotionalArousal(text) * p.arousalGain);
  const similarPrior = signals.recentGists.filter((g) => trigramSimilarity(text, g) >= 0.5).length;
  const repetition = similarPrior > 1 ? 0.6 : 0;

  const raw =
    p.w.novelty * novelty +
    p.w.arousal * arousal +
    p.w.selfRelevance * 1.0 +
    p.w.repetition * repetition;

  return {
    salience: clamp01(raw),
    write: raw >= p.writeThreshold,
    components: { novelty, arousal, selfRelevance: 1.0, hintWeight: 0, repetition, authority: 0 },
  };
}