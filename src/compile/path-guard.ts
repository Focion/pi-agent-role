// ═══════════════════════════════════════════════════════════════════════════
// 路径边界守卫（R02 / A01/A02/A15/A16）
//
// 凡是把外部输入当作「单一路径段」拼进受控目录（<root>/agents/<id>、<root>/staging/<id>、
// <root>/templates/.../<id>、overlay 维度名、promote 的 stagingId/targetId）的地方，
// 必须先过 `assertSafeSegment`：拒绝空、`.`、`..`、绝对路径、路径分隔符与 NUL——一个
// 不含分隔符且非 . / .. 的段拼作叶节点时不可能穿越父目录。`assertContained` 再做
// resolve 后前缀包含的兜底复核，两者配套使用，先白名单再包含检查。
//
// 分层：本文件落在 compile/（authoring/ 与 runtime/ 都能 import 的最低共享层），只依赖
// runtime/errors 叶子（与 materialize.ts 同款边），维护 scripts/check-imports.mjs 的门禁。
// ═══════════════════════════════════════════════════════════════════════════

import { isAbsolute, resolve, sep } from "node:path";
import { ValidationError } from "../runtime/errors.js";

/** 单个路径段校验：非空、非 `.`/`..`、不含 `/`、`\` 或 NUL、不是绝对路径。 */
export function assertSafeSegment(segment: string, label: string): void {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new ValidationError(`invalid ${label}: must be a non-empty path segment`);
  }
  if (segment === "." || segment === "..") {
    throw new ValidationError(`invalid ${label}: "${segment}" (dot segments are not allowed)`);
  }
  if (isAbsolute(segment) || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
    throw new ValidationError(`invalid ${label}: "${segment}" (must not contain path separators)`);
  }
}

/** resolve 后校验 candidate 仍落在 base 内，返回规范化绝对路径（兜底复核）。 */
export function assertContained(base: string, candidate: string, label: string): string {
  const rBase = resolve(base);
  const rCand = resolve(candidate);
  if (rCand !== rBase && !rCand.startsWith(rBase + sep)) {
    throw new ValidationError(`${label} escapes base directory: ${candidate}`);
  }
  return rCand;
}