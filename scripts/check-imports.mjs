#!/usr/bin/env node
// CI 门禁（§22.4 五条静态约束 + I22 裸 clearQueue）。任何一项命中即 exit 1。
//
//   R1 依赖门禁：`@pi/agent-mesh` 只允许出现在 `src/mesh/**`（约束 #4）
//   R2 表名门禁：mesh_ 表名 SQL 引用（FROM/JOIN/INTO/… mesh_xxx）只允许出现在 `src/mesh/**`（约束 #5）
//   R3 字面量门禁：`ext.`（dot）只允许出现在 `src/mesh/**`（约束 #5）
//   R4 禁用 API：裸 `clearQueue(`（不被 `before` 前导）即失败（I22）
//   R5 策略纯度：`src/mesh/policies/**` 不得出现 `ext` 标识符（§22.4 约束 #5 特化）
//   R6 authoring 隔离：`src/authoring/**` 不得 import mesh/db/memory/scene/agent（§22.4 约束 #2）
//
// 约束 #1（agent/ → db/）与 #2（authoring/ → db|memory|scene|agent|mesh）在 P1/PA
// 相应目录出现时再落；约束 #3（`runtime/` 反向 import `runtime/`）此刻由目录事实
// 保证（runtime/ 是叶子层），暂不扫描。
//
// 措辞与 mesh 自己的 scripts/check-imports.mjs 同形。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

const MESH_PKG = "@pi/agent-mesh";
// 表名门禁：SQL 关键字后紧跟 mesh_<表名>
const MESH_TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+mesh_[a-z_]+/gi;
// ext. 字面量：非字母下划线数字前导（排除 "context." "text." "next." 误伤）
const EXT_DOT_RE = /(?:^|[^A-Za-z0-9_])ext\./g;

const violations = [];
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|mts)$/.test(name)) files.push(p);
  }
}
walk(SRC);

const importRe = /(?:^|\s)(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
const dynamicImportRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** 去掉 // 行注释与 /* 块注释，供 R5「标识符级」扫描，避免命中注释里的 ext。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

for (const f of files) {
  const rel = relative(ROOT, f).replaceAll("\\", "/");
  const src = readFileSync(f, "utf8");
  const isMesh = rel.startsWith("src/mesh/");
  const isPolicy = rel.startsWith("src/mesh/policies/");

  // R1 依赖门禁
  const specs = [];
  for (const m of src.matchAll(importRe)) specs.push(m[1]);
  for (const m of src.matchAll(dynamicImportRe)) specs.push(m[1]);
  for (const spec of specs) {
    if (!isMesh && (spec === MESH_PKG || spec.startsWith(MESH_PKG + "/"))) {
      violations.push(`R1 ${rel}: imports "${spec}" outside src/mesh/** (§22.4 #4)`);
    }
  }

  // R2 表名门禁
  if (!isMesh) {
    for (const m of src.matchAll(MESH_TABLE_RE)) {
      violations.push(`R2 ${rel}: mesh table SQL reference "${m[0].trim()}" (§22.4 #5)`);
    }
  }

  // R3 ext. 字面量门禁
  if (!isMesh) {
    for (const m of src.matchAll(EXT_DOT_RE)) {
      const snippet = src.slice(m.index, m.index + 16);
      violations.push(`R3 ${rel}: "ext." literal "${snippet.trim()}" (§22.4 #5)`);
    }
  }

  // R4 裸 clearQueue(（I22）
  for (const m of src.matchAll(/clearQueue\s*\(/g)) {
    const before = src.slice(Math.max(0, m.index - 6), m.index);
    if (!before.endsWith("before")) {
      violations.push(`R4 ${rel}: bare clearQueue( must go through beforeClearQueue (I22)`);
    }
  }

  // R5 策略槽纯度：policy 文件禁用 ext 标识符（§3.7 契约① / C10）
  if (isPolicy) {
    const code = stripComments(src);
    if (/\bext\b/.test(code)) {
      violations.push(`R5 ${rel}: policy slot references "ext" identifier (§22.4 #5 / C10)`);
    }
  }

  // R6 authoring 隔离（§22.4 约束 #2）：authoring/** 不得直接 import mesh/db/memory/scene/agent
  if (rel.startsWith("src/authoring/")) {
    const fileDir = rel.slice(0, rel.lastIndexOf("/"));
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      const resolved = join(ROOT, fileDir, spec);
      const relResolved = relative(SRC, resolved).replaceAll("\\", "/");
      if (/^(mesh|db|memory|scene|agent)\//.test(relResolved)) {
        violations.push(`R6 ${rel}: imports "${spec}" → "${relResolved}" (§22.4 约束 #2)`);
      }
    }
  }
}

if (violations.length) {
  console.error(`✗ pi-agent-role gates FAILED (${violations.length} violation(s)):`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(`✓ pi-agent-role gates passed (${files.length} source files checked)`);