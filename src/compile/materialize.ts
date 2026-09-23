// ═══════════════════════════════════════════════════════════════════════════
// 实例模板物化（设计 §6.1 / 约束 C5）
//
// 把一份只读蓝本目录（git 管理、人可读可改的 YAML 目录，§4.1）复制成某个 agent 专属的
// 可写「实例模板」目录，并可选地打上一层 JSON Merge Patch（RFC 7386）overlay。
// 物化落点：<root>/agents/<agentId>/identity/。
//
// 职责边界：
//   · 蓝本 → 实例模板 只是一次「复制 + 打补丁」，不解析、不编译基因——身份编译是
//     identity-loader 的活（§5.1），materialize 不碰。
//   · blueprintHash 在复制**之前**计算：它记录的是蓝本的内容血缘（§6.1），而不是副本。
//   · 物化一生只做一次：identityDir 已存在即视为重复创建，抛 ValidationError
//     （agents.create() 会先行拦截，这里再兜底一道硬约束）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hashDirectoryContents, listFiles } from "./fingerprint.js";
import { readYamlFile, stringifyYaml } from "./yaml.js";
import { ValidationError } from "../runtime/errors.js";

/** materialize 入参：蓝本目录 + 工作根 + agentId + 可选 overlay。 */
export interface MaterializeInput {
  /** 蓝本目录（只读，git 管理）。 */
  blueprintDir: string;
  /** 工作根，最终物化到 <root>/agents/<agentId>/identity/。 */
  root: string;
  agentId: string;
  /**
   * JSON-merge-patch。top-level key = 维度文件名去 .yaml 后缀（如 "personal"），
   * 值合并进该 YAML 文件。
   */
  overlay?: Record<string, unknown>;
}

/** materialize 产出：实例模板落点 + 复制清单 + 被 overlay 改动的维度 + 蓝本血缘哈希。 */
export interface MaterializeResult {
  /** <root>/agents/<agentId>/identity。 */
  identityDir: string;
  /** 相对 identityDir 的文件列表（已排序）。 */
  filesCopied: string[];
  /** 被 overlay 改动的文件名（无 .yaml 后缀）。 */
  overlayApplied: string[];
  /** 蓝本目录内容哈希（血缘，设计 §6.1）。 */
  blueprintHash: string;
}

/** 判断是否普通对象（数组 / null / 标量都不是）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * RFC 7386 JSON Merge Patch：null 删键、对象递归合并、其余整体替换。
 * 返回全新对象，绝不改写入参（尤其不 mutate 调用方的 overlay）。
 */
function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }
  const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
    } else {
      base[key] = applyMergePatch(base[key], value);
    }
  }
  return base;
}

/**
 * 物化实例模板：复制蓝本目录到 `<root>/agents/<agentId>/identity/`，再打 overlay。
 * 蓝本哈希在复制前计算；重复物化同一 agentId 抛 ValidationError。
 */
export async function materialize(input: MaterializeInput): Promise<MaterializeResult> {
  const identityDir = join(input.root, "agents", input.agentId, "identity");

  if (existsSync(identityDir)) {
    throw new ValidationError(
      `instance template already exists for agent ${input.agentId}: ${identityDir}`,
    );
  }

  // 蓝本哈希必须在复制前算，反映蓝本而非副本（§6.1 血缘）。
  const blueprintHash = await hashDirectoryContents(input.blueprintDir);

  await mkdir(join(input.root, "agents", input.agentId), { recursive: true });
  await cp(input.blueprintDir, identityDir, { recursive: true });

  const overlayApplied: string[] = [];
  if (input.overlay) {
    for (const key of Object.keys(input.overlay)) {
      const targetPath = join(identityDir, `${key}.yaml`);
      const existing = readYamlFile<Record<string, unknown>>(targetPath);
      if (existing === undefined) {
        throw new ValidationError(`overlay targets missing dimension file: ${key} (${targetPath})`);
      }
      const merged = applyMergePatch(existing, input.overlay[key]);
      await writeFile(targetPath, stringifyYaml(merged), "utf8");
      overlayApplied.push(key);
    }
  }

  const filesCopied = await listFiles(identityDir);

  return {
    identityDir,
    filesCopied,
    overlayApplied: overlayApplied.sort(),
    blueprintHash,
  };
}