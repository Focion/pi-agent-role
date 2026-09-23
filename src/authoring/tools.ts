// ═══════════════════════════════════════════════════════════════════════════
// 蓝本生成的三件工具（§24.4）：blueprint_write / blueprint_read / blueprint_validate
//
// 与本环那 10 个领域工具（§3.8）完全不相交，也不挂 mesh 会话：它们全只碰文件系统，
// 一条消息都不产生。isolated 关键在 **staging 路径白名单**——任何写入/读取先解析绝对
// 路径再做前缀匹配，越出 staging 即拒绝。blueprint_validate 内部直调 schema.validate
// （= agents.create() 的 loader）。
//
// 分层纪律（§22.4 约束 2）：本文件不 import mesh/db/memory/scene/agent。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { ValidationError } from "../runtime/errors.js";
import type { BlueprintSchema, ValidationReport } from "./types.js";

/** 允许写入的文件扩展（§24.4：只 .yaml / .md）。 */
const ALLOWED_EXT = /\.(yaml|yml|md)$/;
/** 单文件硬上限（§24.4 约束的落地：防止生成器写爆某个文件）。 */
const MAX_FILE_BYTES = 1_000_000;

export interface BlueprintWriteResult {
  bytes: number;
}

export interface BlueprintTools {
  /** blueprint_write：{ path, content } → { bytes }。path 必须落进 staging 白名单。 */
  write(path: string, content: string): BlueprintWriteResult;
  /** blueprint_read：{ path } → { content }。读取范围同上。 */
  read(path: string): string;
  /** blueprint_read 的 fileSpecs 只读查询（让 Agent 自查字段规格）。 */
  spec(file: string): { file: string; description: string; neverInferFields: string[] } | undefined;
  /** blueprint_validate：{ } → ValidationReport。无参，只校验当前 staging。 */
  validate(): Promise<ValidationReport>;
}

interface BlueprintToolsDeps {
  stagingDir: string;
  schema: BlueprintSchema;
}

/**
 * 把相对路径解析到 staging 白名单内；越界（绝对路径、`..` 逃逸、非 .yaml/.md）抛
 * ValidationError（工具层拒绝，§24.4 第一道墙）。
 */
function resolveInsideStaging(stagingDir: string, path: string): string {
  if (isAbsolute(path)) {
    throw new ValidationError(`blueprint path must be relative: ${path}`);
  }
  if (!ALLOWED_EXT.test(path)) {
    throw new ValidationError(`blueprint path must end in .yaml/.md: ${path}`);
  }
  const root = resolve(stagingDir);
  const target = resolve(stagingDir, path);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new ValidationError(`blueprint path escapes staging: ${path}`);
  }
  return target;
}

/** 组装三件工具（§24.4）。 */
export function makeBlueprintTools(deps: BlueprintToolsDeps): BlueprintTools {
  const { stagingDir, schema } = deps;

  return {
    write(path: string, content: string): BlueprintWriteResult {
      const target = resolveInsideStaging(stagingDir, path);
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
        throw new ValidationError(`blueprint file exceeds size cap: ${path}`);
      }
      const parent = dirname(target);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(target, content, "utf8");
      return { bytes: statSync(target).size };
    },

    read(path: string): string {
      const target = resolveInsideStaging(stagingDir, path);
      if (!existsSync(target)) throw new ValidationError(`blueprint file not found: ${path}`);
      return readFileSync(target, "utf8");
    },

    spec(file: string) {
      const spec = schema.fileSpecs[file];
      if (!spec) return undefined;
      return {
        file: spec.file,
        description: spec.description,
        neverInferFields: [...spec.neverInferFields],
      };
    },

    validate() {
      return schema.validate(stagingDir);
    },
  };
}