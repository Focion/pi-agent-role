// ═══════════════════════════════════════════════════════════════════════════
// 蓝本门面（§24）：把 authoring/ 的生成 Agent 挂到 Runtime.blueprints 上
//
// 薄适配层：只做「root 注入 + 逐方法透传」，不掺任何生成逻辑。生成/落地的全部语义在
// src/authoring/（五步流水线 + staging 白名单 + promote 原子 rename）。
//
// 分层纪律（§22.4 图）：runtime → authoring。本文件不直接 import mesh/db/memory/scene/agent。
// ═══════════════════════════════════════════════════════════════════════════

import { createBlueprintAuthor } from "../authoring/driver.js";
import type { BlueprintApi } from "./types.js";

/** 装配 Runtime.blueprints（§24.5）。root 决定 staging/ 与 templates/ 的落点。 */
export function makeBlueprintApi(deps: { root: string }): BlueprintApi {
  const author = createBlueprintAuthor({ root: deps.root });
  return {
    generate: (input) => author.generate(input),
    promote: (stagingId, opts) => author.promote(stagingId, opts),
  };
}