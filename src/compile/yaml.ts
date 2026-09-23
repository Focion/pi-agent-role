// ═══════════════════════════════════════════════════════════════════════════
// YAML 读取（编译期唯一数据入口）
//
// 蓝本/实例模板是「人可读可改的 YAML 目录」（§4.1 / §6.1）。解析用 confbox（`parseYAML`），
// 它是本环 runtime 依赖下唯一的 YAML 实现，无注入、无自解释陷阱。
//
// 失败语义：解析/类型错误抛 ValidationError（§2.5 ① 的第一道关卡），标签里带文件路径，
// 让「哪一份模板坏了」一眼可查。缺省所有文件必读；optional 文件缺失返回 undefined（B2 降级）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from "node:fs";

import { parseYAML, stringifyYAML } from "confbox/yaml";

import { ValidationError } from "../runtime/errors.js";

/** 解析一段 YAML 文本；失败抛 ValidationError（带标签，便于定位坏模板）。 */
export function parseYamlText<T>(text: string, label: string): T {
  try {
    return parseYAML<T>(text, { filename: label });
  } catch (err) {
    throw new ValidationError(`invalid YAML in ${label}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * 读取一个 YAML 文件为对象。
 *   · 缺省（optional=false）：文件必须存在，否则抛 ValidationError。
 *   · optional=true：文件不存在返回 undefined；存在但解析失败仍抛错（坏数据不是「没有」）。
 */
export function readYamlFile<T>(
  path: string,
  opts: { optional?: boolean; label?: string } = {},
): T | undefined {
  const label = opts.label ?? path;
  if (!existsSync(path)) {
    if (opts.optional) return undefined;
    throw new ValidationError(`required YAML file missing: ${path}`);
  }
  const text = readFileSync(path, "utf8");
  return parseYamlText<T>(text, label);
}

/** 序列化回 YAML（materialize 覆写 overlay 后的文件用）。 */
export function stringifyYaml(value: unknown): string {
  return stringifyYAML(value);
}