// ═══════════════════════════════════════════════════════════════════════════
// 卡片渲染（§14.3 / §15.3）—— 本环自持，完全不经 mesh 的 Renderer
//
// 三条格式规则（§14.3.4）：
//   1. 强度 + 相对虚拟时间；  2. 第一人称主观标注；  3. confidence < 0.6 显式标注不确定。
// 失真裁剪（§15.3）：作用在「注入」上而非「存储」上（F1）——projectEpisode 是卡片渲染的
// **唯一**取值入口，quote 只在 retention>=0.70、detail 只在 retention>=0.45 时注入。
// 被裁掉的字段渲染成「记不清」的表述，而不是静默省略。
// ═══════════════════════════════════════════════════════════════════════════

import { DISTORTION_THRESHOLDS, RETRIEVAL } from "./constants.js";
import type { SubjectRef } from "./subject.js";

/** 可按 retention 裁剪的一条记忆的可注入字段（§15.3 projectEpisode）。 */
export interface ProjectedEpisode {
  gist: string;
  detail?: string;
  quote?: string;
  emotion?: string;
  valence?: number;
  arousal?: number;
}

interface EpisodeLike {
  gist: string;
  detail: string | null;
  quote: string | null;
  emotion: string | null;
  valence: number | null;
  arousal: number | null;
  retention: number;
}

/** 按 retention 裁剪可注入字段（F1：不改存储列，只决定注入什么）。 */
export function projectEpisode(ep: EpisodeLike): ProjectedEpisode {
  const out: ProjectedEpisode = { gist: ep.gist };
  if (ep.retention >= DISTORTION_THRESHOLDS.detail && ep.detail) out.detail = ep.detail;
  if (ep.retention >= DISTORTION_THRESHOLDS.quote && ep.quote) out.quote = ep.quote;
  if (ep.emotion != null) out.emotion = ep.emotion;
  if (ep.valence != null) out.valence = ep.valence;
  if (ep.arousal != null) out.arousal = ep.arousal;
  return out;
}

/** 相对虚拟时间（§14.3.4 规则 1）："3天前" 而非绝对日期。 */
export function renderRelativeTime(nowHours: number, epHours: number): string {
  const dh = nowHours - epHours;
  if (dh <= 0) return "刚刚";
  const weeks = Math.floor(dh / 168);
  if (weeks >= 1) return `${weeks}周前`;
  const days = Math.floor(dh / 24);
  if (days >= 1) return `${days}天前`;
  const hours = Math.floor(dh);
  return `${hours}小时前`;
}

/** 粗 token 估算：字节数 / 4（与 identity-loader 的 lazySection 同口径）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const KIND_LABEL: Record<string, string> = {
  event: "情节",
  impression: "印象",
  fact: "事实",
  self: "自我",
};

export interface RenderCardInput {
  kind: string;
  projected: ProjectedEpisode;
  /** 记忆强度 = retention（衰减后的导出量）。 */
  retention: number;
  confidence: number;
  virtualHours: number;
  nowHours: number;
  subjects: SubjectRef[];
  /** 已解析好的主体显示名（与 subjects 平行；缺省退化为 subject id）。 */
  subjectLabels?: string[];
}

/**
 * 渲染单张 `<<<MEMORY … MEMORY>>>` 卡片。subjects 为空时省略「关于」子句；
 * 有主体但标签缺失时用 subject_id 占位（设备 / npc / 群体本就用 id 表达）。
 * 字段被失真裁剪（缺 detail/quote）时补写「记不清」，而非静默省略（§15.3）。
 */
export function renderMemoryCard(input: RenderCardInput): string {
  const { projected: p, subjects, subjectLabels } = input;
  const when = renderRelativeTime(input.nowHours, input.virtualHours);
  const label = KIND_LABEL[input.kind] ?? "情节";
  const aboutText =
    subjects.length > 0
      ? ` · 关于 ${subjects.map((s, i) => subjectLabels?.[i] ?? s.id).filter(Boolean).join("、")}`
      : "";

  const affect: string[] = [];
  if (p.emotion != null) affect.push(String(p.emotion));
  if (p.valence != null) affect.push(String(p.valence));
  const affectLine = affect.length > 0 ? `\n（我的感受：${affect.join("，")}）` : "";

  let distortion = "";
  if (input.confidence < 0.6) distortion = "\n（我记得好像是……不太确定）";
  else if (!p.quote) distortion = "\n（具体怎么说的记不清了）";

  // A28：projectEpisode 已按阈值保留了 detail（≥0.45）/quote（≥0.70），
  // 渲染层必须实际展示它们，不能只给 gist；被裁掉的字段仍以「记不清」兜底。
  const detailLine = p.detail ? `\n（细节：${p.detail}）` : "";
  const quoteLine = p.quote ? `\n（原话：${p.quote}）` : "";

  // 强度保留两位，供模型与检索审计一致地读数
  const strength = input.retention.toFixed(2);

  return [
    "<<<MEMORY",
    `[${label} · ${when} · 强度${strength}${aboutText}]`,
    `${p.gist}${distortion}${detailLine}${quoteLine}${affectLine}`,
    "MEMORY>>>",
  ].join("\n");
}

/** 把多张卡片拼成一个块，预算截断由 retrieve 层完成后再交这里。 */
export function renderMemoryBlocks(cards: string[]): string {
  return cards.join("\n\n");
}