// ═══════════════════════════════════════════════════════════════════════════
// 通用用途 purpose_kind（§17.6）—— 教学进度 / 误区纠正等跨角色用途的封闭定义
//
// 纪律：不加教师特例。`teaching_progress` 不是「老师专用」的分支，而是任何角色都能给一段
// 记忆情节打上的通用用途标签——语义只由 purpose_kind 字符串 + 只读地板决定，与调用方角色
// 无关。冷启动一个「学生会主页」或「护士排班」角色时，教学进度/误区纠正仍是同一套 schema。
//
// RETENTION 地板（§17.6 表）：这类情节是系统/进程抬高显著度的「高价值事件」，
// 显著度不交给 Agent 判断（与被纠正的瞬间 / 学习进度一样，主观打分常常偏低）。
// ═══════════════════════════════════════════════════════════════════════════

import { MISCONCEPTION_CORRECTION_SALIENCE_FLOOR } from "../knowledge/types.js";

/** 教学进度情节的 salience 地板（§17.6）：进度里程碑值得≥0.7 地记住。 */
export const TEACHING_PROGRESS_SALIENCE_FLOOR = 0.7;

/**
 * purpose_kind → salience 地板。写入端据此把来自 turn 的显著度抬高到地板（`Math.max`），
 * 不是覆盖——Agent 主观打高时保留原值。无条目的 purpose_kind 不加地板。
 */
export const SALIENCE_FLOOR_BY_KIND: Readonly<Record<string, number>> = {
  teaching_progress: TEACHING_PROGRESS_SALIENCE_FLOOR,
  misconception_corrected: MISCONCEPTION_CORRECTION_SALIENCE_FLOOR,
};

/**
 * `remember` 工具 `purpose` 参数可断言的白名单（封闭）。
 * `misconception_corrected` 由自省服务系统注入（§17.4.2），不让 Agent 通过 remember 自报。
 */
export const ASSIGNABLE_PURPOSES: ReadonlySet<string> = new Set<string>(["teaching_progress"]);

/** 教学进度重复检测的比对窗口：最近 N 条本用途情节的 knowledge 主体。 */
export const TEACHING_PROGRESS_DUP_WINDOW = 5;

/** 用途情节检索默认上限（§17.6「至多 3 条/200 token 独立记账」的 3）。 */
export const PURPOSE_RETRIEVAL_LIMIT = 3;

/** `normalizeAssignablePurpose` 的结果：缺席（无目的）与非法（越界白名单）要分开，否则会把 `""` 静默当无目的。 */
export type PurposeParamResult = { ok: true; purposeKind: string | null } | { ok: false };

/**
 * 把 `remember.params.purpose` 归一到合法的 purpose_kind 或 null（缺席）。
 * 非字符串 / 不在白名单 → `{ ok: false }`，调用方转 ARG_INVALID，
 * 保证写入端只会产出封闭集合内的 purpose_kind。
 */
export function normalizeAssignablePurpose(v: unknown): PurposeParamResult {
  if (v === undefined || v === null || v === "") return { ok: true, purposeKind: null };
  if (typeof v !== "string" || !ASSIGNABLE_PURPOSES.has(v)) return { ok: false };
  return { ok: true, purposeKind: v };
}