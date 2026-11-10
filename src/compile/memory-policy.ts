// ═══════════════════════════════════════════════════════════════════════════
// policy-mapper（§12.2）—— 角色差异全部由数据表达（C1）
//
// 把 psychology.yaml + narrative_voice.yaml 的模板字段编译成 MemoryPolicy。这是 C1
// 最关键的一处：老师 / 学生 / 校长的记忆倾向必须不同，但代码里**不能**出现
// `if (role === "teacher")`。编译器对所有人一视同仁，只读模板字段。
//
// 可检测手段（§12.2）：grep -rE "'(teacher|student|principal)'" src/ 在 CI 里必须
// 零命中——本文件用到的都是模板字段名（big_five / emotion / cognition / …），
// 不出现任何角色名。
//
// 所有 big_five 取值约定为 [0,1]，0.5 = 中性；分值离 0.5 越远，倾向越强。
// 缺字段 → 中性基线 defaultMemoryPolicy()，反复可测。
// ═══════════════════════════════════════════════════════════════════════════

import { defaultMemoryPolicy } from "./types.js";
import type { MemoryPolicy } from "./types.js";

/** 参与编译的模板输入（psychology / narrative_voice / evolution / relationships）。 */
export interface MemoryPolicyTemplateInput {
  psychology?: unknown;
  narrativeVoice?: unknown;
  evolution?: unknown;
  relationships?: unknown;
}

// ─── 只读取值助手（缺字段一律回退，不抛）────────────────────────────────────

function record(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** 点分路径取数：`pick(v, "big_five", "neuroticism")`。缺失/非 object 返回 undefined。 */
function pick(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const seg of path) {
    cur = record(cur)[seg];
  }
  return cur;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 归一化到 [0,1]，越界钳制。 */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 把 [0,1] 的中性分映射成围绕 1 的乘数（0 → 0，0.5 → 1，1 → 2）。 */
function gain(trait: number): number {
  return 1 + (trait - 0.5) * 2;
}

/**
 * `narrative_voice.sensory.dominant_channel` → renderHints 通道 key（§16.3.2）。
 * 蓝本常写中文字面量（「视觉」「听觉」「触觉」「嗅觉」），renderHints 键是英文；
 * 这里兼容两种拼写，归一到英文 key。未知值 → undefined（退化为中性串接）。
 */
const SENSORY_CHANNEL_ALIAS: Record<string, "visual" | "auditory" | "tactile" | "olfactory"> = {
  visual: "visual",
  auditory: "auditory",
  tactile: "tactile",
  olfactory: "olfactory",
  视觉: "visual",
  听觉: "auditory",
  触觉: "tactile",
  嗅觉: "olfactory",
};

/**
 * 编译记忆策略（§12.2 映射表）。`base` 提供中性基线，缺省 defaultMemoryPolicy()。
 * 每个输出字段只被「存在」的模板字段改写：模板没写 big_five ⇒ 全部保持基线，
 * 所以蓝本里只有 `personality` 时，师资与学生的差异自然为零——差异由模板数据驱动。
 */
export function compileMemoryPolicy(
  input: MemoryPolicyTemplateInput,
  base: MemoryPolicy = defaultMemoryPolicy(),
): MemoryPolicy {
  const p: MemoryPolicy = {
    ...base,
    w: { ...base.w },
    authorityWeights: { ...base.authorityWeights },
    reflection: { ...base.reflection },
  };

  const psy = record(input.psychology);
  const nv = record(input.narrativeVoice);
  const evo = record(input.evolution);

  // big_five（缺省 0.5 = 中性）
  const openness = num(pick(psy, "big_five", "openness"), 0.5);
  const conscientiousness = num(pick(psy, "big_five", "conscientiousness"), 0.5);
  const neuroticism = num(pick(psy, "big_five", "neuroticism"), 0.5);

  // emotion / attachment / cognition / sensory
  const empathy = num(pick(psy, "emotion", "empathy_level"), 0.5);
  const attachmentStyle = pick(psy, "attachment_style");
  const attentionSpan = pick(psy, "cognition", "attention_span");
  const noticingPattern = pick(psy, "sensory", "noticing_pattern");

  const anxious = attachmentStyle === "anxious";
  const scattered = attentionSpan === "scattered";
  const detailOriented = noticingPattern === "detail_oriented";

  // —— 权重（§12.2 表）——
  p.w.novelty = gain(openness); // 开放性 ↑ ⇒ 对新鲜事更敏感
  // selfRelevance ↓：共情高的人不只记与自己有关的（下限 0.2，避免彻底无私）
  p.w.selfRelevance = Math.max(0.2, gain(1 - empathy));
  if (anxious) {
    p.w.authority = 1.5; // 焦虑依恋对权威评价过度敏感
  }

  // —— 阈值 / 保留 ——
  // 尽责性 ↑ ⇒ 阈值 ↓（记得更多）、细节保留 ↑、更频繁复盘
  p.writeThreshold = clamp01(0.5 - (conscientiousness - 0.5) * 0.4);
  p.detailRetention = clamp01(0.5 + (conscientiousness - 0.5) * 0.4 + (detailOriented ? 0.15 : 0));
  p.reflection.episodesPerReflection = Math.max(3, Math.round(6 - (conscientiousness - 0.5) * 6));

  // —— 情绪 / 衰减 ——
  p.arousalGain = gain(neuroticism); // 神经质 ↑ ⇒ 情绪放大
  p.negativeBias = gain(neuroticism); // 神经质 ↑ ⇒ 负面事件记得更牢更久

  // —— 设施观察感官通道（§16.3.2 / R22）：narrative_voice.sensory.dominant_channel ——
  const dominantChannel = pick(nv, "sensory", "dominant_channel");
  if (typeof dominantChannel === "string") {
    p.dominantChannel = SENSORY_CHANNEL_ALIAS[dominantChannel.trim()];
  }

  // —— 认知（注意力分散）——
  if (scattered) {
    p.maxWritesPerTurn = 1; // 一轮里记不住那么多
    p.p2Damping = 0.4; // 看摘要更是留不下印象
  }

  // —— 信任默认值（焦虑 ⇒ 初始更不信任）——
  if (anxious) p.defaultTrust = 0.35;

  // —— 成长速率（evolution.growth_rules）留给 P4（§13.5）——
  const growthRules = record(pick(evo, "growth_rules"));
  void growthRules;

  return p;
}