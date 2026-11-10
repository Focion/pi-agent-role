// ═══════════════════════════════════════════════════════════════════════════
// 指纹工具（§4.2 步骤 5 / §9.4 / §6.1）
//
// 三个不同量级、一个也不许混（§18.2.1 的三粒度区分）：
//   · `blueprint_hash`  蓝本目录内容哈希（血缘）          → hashDirectoryContents
//   · `prompt_version`  参与编译的文件 + 编译器版本（快照） → fingerprintOf
//   · `spec_hash`       assemble() 全量装配输入（open 校验）→ fingerprintOf（caller 拼字段）
// 全部用 sha256，十六进制小写；文件类哈希按「相对路径 + 内容」排序拼接，保证稳定可复现。
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ModelConfig } from "./types.js";

/** 单个字符串/缓冲的 sha256，十六进制小写。 */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 键序稳定的规范序列化：递归按键名排序、跳过 undefined 叶子。保证同配置无论构造顺序都同哈希。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 模型配置哈希（R06 E09：情节/自省/检索写“实际配置 hash”）。ModelConfig 只含
 * provider/modelId/thinkingLevel/temperature/budget，不含任何凭据，故哈希与快照天然无凭据。
 * 键序稳定的 sha256，用作同一条配置的可审计指纹。
 */
export function modelConfigHash(config: ModelConfig): string {
  return sha256Hex(canonicalJson(config));
}

/**
 * 从 agents.model_config_json 原文算哈希。空/坏 JSON 返回 null —— 不可得标 unknown，
 * 绝不伪造旧来源（R06「旧来源不伪造」）。
 */
export function modelConfigHashFromJson(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    return modelConfigHash(JSON.parse(json) as ModelConfig);
  } catch {
    return null;
  }
}

/** 顺序敏感聚合指纹：把若干部分按序喂进同一个 hash。用于 promptVersion / spec_hash。 */
export function fingerprintOf(parts: Array<string | Buffer>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

/** 递归列出目录下所有文件（相对目录根），按相对路径排序。 */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(relative(dir, p));
    }
  }
  await walk(dir);
  return out.sort();
}

/** 目录内容哈希：每个「相对路径 + 内容」排序拼接后 sha256。蓝本血缘用。 */
export async function hashDirectoryContents(dir: string): Promise<string> {
  const files = await listFiles(dir);
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(await readFile(join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** 显式文件列表哈希：同样「相对路径 + 内容」排序拼接。参与编译文件用。 */
export async function hashFileContents(
  dir: string,
  relPaths: string[],
): Promise<string> {
  const sorted = [...relPaths].sort();
  const h = createHash("sha256");
  for (const rel of sorted) {
    h.update(rel);
    h.update("\0");
    h.update(await readFile(join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}