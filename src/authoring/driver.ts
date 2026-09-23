// ═══════════════════════════════════════════════════════════════════════════
// 蓝本生成 Agent 五步流水线驱动（§24.3）+ 落地（§24.6）
//
// generate() 五步：normalize → scaffold → seed core → expand → validate。前两步与第 5 步
// 的分配核对是**确定性的**（库侧骨架）；第 3/4 步的内容填写经注入的 `AuthorModel`（宿主
// 接 LLM，本库不自带模型——必过集禁真模型）。产物只写 staging，绝不落地；落地是显式的
// 第二次调用 promote()（§24.6）。
//
// 隔离（§24.1/§24.4）：
//   · 所有蓝本文件写入/校验都经 `BlueprintTools`（staging 路径白名单，tools.ts）。
//   · 模型返回的文件只取「已 scaffold 的文件」且经字段白名单净化（schema 驱动结构）。
//   · neverInfer 字段不进模型 targets、不进净化白名单——只能被留空，绝不被推断。
//   · 描述以数据块携带给模型，绝不拼进指令（模型请求把 description 单独建模）。
//
// 分层纪律（§22.4 约束 2）：不 import mesh/db/memory/scene/agent；只 import compile/（yaml）
// 与 runtime/errors（叶子）。
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { readYamlFile, stringifyYaml } from "../compile/yaml.js";
import { ValidationError } from "../runtime/errors.js";
import { neverInferFiles, schemaFor } from "./schema.js";
import { makeBlueprintTools, type BlueprintTools } from "./tools.js";
import type {
  AuthorModelRequest,
  AuthorModelResponse,
  AuthorModelTarget,
  BlueprintAuthor,
  BlueprintReport,
  BlueprintSchema,
  Fact,
  GenerateInput,
  PromoteInput,
  PromoteResult,
  ValidationReport,
} from "./types.js";

/** 谱系元数据（generate 落盘、promote 读回固化成 provenance.yaml）。隐藏 .json，不在蓝本文件集内。 */
const META_FILE = ".provenance-meta.json";
const PROVENANCE_FILE = "provenance.yaml";

interface ProvenanceMeta {
  description: string;
  kind: "identity" | "facility";
  model: string;
  cost: BlueprintReport["cost"];
  suggestedId: string;
  needsHumanReview: boolean;
  needsHumanReviewReasons: string[];
}

// ─── 第 1 步：normalize（确定性）────────────────────────────────────────────

/** 按中文句末标点 / 换行切句，逐句成 Fact 并编号。 */
function splitSentences(text: string): string[] {
  return text
    .replace(/\r?\n+/g, "\n")
    .split(/(?<=[。！？!?；;]|\n)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 关键词打分，把一句事实归到某个维度文件（命中数取胜；平手取声明序在前者）。 */
function tagSentence(text: string, schema: BlueprintSchema): { file: string | null; field: string } {
  let best: { file: string; score: number } | null = null;
  for (const spec of Object.values(schema.fileSpecs)) {
    let score = 0;
    for (const kw of spec.keywords) if (text.includes(kw)) score++;
    if (score > 0 && (!best || score > best.score)) best = { file: spec.file, score };
  }
  return best ? { file: best.file, field: best.file } : { file: null, field: "" };
}

function normalizeDescription(description: string, schema: BlueprintSchema): Fact[] {
  return splitSentences(description).map((text, i) => {
    const tag = tagSentence(text, schema);
    return {
      factId: i + 1,
      text,
      file: tag.file,
      field: tag.field,
      reason: tag.file === null ? "描述未命中任何维度关键词，无法自动归位" : undefined,
    };
  });
}

// ─── 第 2 步：scaffold（确定性）────────────────────────────────────────────

/** 命中了事实的可选文件，随需创建（§24.3 第 2 步）。 */
function matchedOptionalFiles(facts: Fact[], schema: BlueprintSchema): string[] {
  return schema.optionalFiles.filter((f) => facts.some((x) => x.file === f));
}

/** manifest.yaml 内容：identity 冷启动 6 份 + lazy 可选；facility 只列文件。 */
function buildManifest(kind: "identity" | "facility", schema: BlueprintSchema, id: string, files: string[]): Record<string, unknown> {
  const filesArr = files.map((f) => {
    const entry: Record<string, unknown> = { path: `${f}.yaml` };
    if (kind === "identity") entry.priority = schema.requiredFiles.includes(f) ? "cold_start" : "lazy";
    return entry;
  });
  return { [kind]: { id }, files: filesArr };
}

async function scaffold(tools: BlueprintTools, schema: BlueprintSchema, id: string, facts: Fact[]): Promise<string[]> {
  const files = [...schema.requiredFiles, ...matchedOptionalFiles(facts, schema)];
  tools.write("manifest.yaml", stringifyYaml(buildManifest(schema.kind, schema, id, files)));
  // 其它文件先写空骨架（必需文件即便模型不填也存在，loader 可过；§24.3 第 2 步）。
  for (const f of files) {
    if (f === "manifest") continue;
    tools.write(`${f}.yaml`, stringifyYaml({}));
  }
  return files;
}

// ─── 第 3/4 步：模型填写（注入 model，库侧只做「净化」）────────────────────

function buildTargets(schema: BlueprintSchema, stage: "seed" | "expand", scaffolded: string[]): AuthorModelTarget[] {
  const rows: AuthorModelTarget[] = [];
  for (const spec of Object.values(schema.fileSpecs)) {
    if (!scaffolded.includes(spec.file)) continue;
    if ((stage === "seed") !== spec.core) continue;
    const fields = Object.keys(spec.fields).filter(
      (f) => !spec.neverInferFields.some((nf) => f === nf || f.startsWith(`${nf}.`)),
    );
    rows.push({ file: spec.file, fields, guide: spec.description, required: spec.required });
  }
  return rows;
}

function buildRequest(schema: BlueprintSchema, stage: "seed" | "expand", state: {
  description: string;
  facts: Fact[];
  core: Record<string, unknown>;
  scaffolded: string[];
}, feedback?: string[]): AuthorModelRequest {
  return {
    kind: schema.kind,
    stage,
    description: state.description,
    facts: state.facts,
    core: state.core,
    targets: buildTargets(schema, stage, state.scaffolded),
    ...(feedback ? { feedback } : {}),
  };
}

/**
 * 字段白名单净化：值里只有 fileSpecs 声明的字段子集能保留（终端字段原样，容器字段递归），
 * 未声明字段与 neverInfer 字段整棵丢弃。结构由 schema 驱动，模型只填已声明的格子。
 */
function sanitizeFileValue(value: unknown, spec: NonNullable<BlueprintSchema["fileSpecs"][string]>): unknown {
  const allowed = Object.keys(spec.fields).filter(
    (f) => !spec.neverInferFields.some((nf) => f === nf || f.startsWith(`${nf}.`)),
  );
  function walk(v: unknown, path: string): unknown {
    if (Array.isArray(v) || typeof v !== "object" || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const p = path === "" ? k : `${path}.${k}`;
      if (allowed.includes(p)) out[k] = child;
      else if (allowed.some((a) => a.startsWith(`${p}.`))) out[k] = walk(child, p);
    }
    return out;
  }
  return walk(value, "");
}

interface ModelAcc {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  conflicts: string[];
  core: Record<string, unknown>;
}

/** 应用模型返回：只取已 scaffold 的文件，净化后落盘，累计用量与冲突。 */
function applyModelResponse(
  tools: BlueprintTools,
  schema: BlueprintSchema,
  scaffolded: string[],
  res: AuthorModelResponse,
  acc: ModelAcc,
  isCore: boolean,
): void {
  acc.turns++;
  if (res.usage) {
    acc.inputTokens += res.usage.inputTokens;
    acc.outputTokens += res.usage.outputTokens;
  }
  if (res.conflicts) acc.conflicts.push(...res.conflicts);
  for (const [file, value] of Object.entries(res.files)) {
    if (!scaffolded.includes(file)) continue;
    const spec = schema.fileSpecs[file];
    if (!spec) continue;
    const clean = sanitizeFileValue(value, spec);
    tools.write(`${file}.yaml`, stringifyYaml(clean));
    if (isCore) acc.core[file] = clean;
  }
}

// ─── 报告组装（确定性）─────────────────────────────────────────────────────

function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

interface ReportState {
  stagingId: string;
  stagingDir: string;
  schema: BlueprintSchema;
  facts: Fact[];
  scaffolded: string[];
  core: Record<string, unknown>;
}

function buildReport(state: ReportState, validation: ValidationReport, cost: BlueprintReport["cost"], retriesExhausted: boolean): BlueprintReport {
  const allocation: BlueprintReport["allocation"] = [];
  const unallocated: BlueprintReport["unallocated"] = [];
  for (const fact of state.facts) {
    if (fact.file !== null) allocation.push({ factId: fact.factId, text: fact.text, file: fact.file, field: fact.field });
    else unallocated.push({ factId: fact.factId, text: fact.text, reason: fact.reason ?? "no allocation" });
  }

  const gaps: BlueprintReport["gaps"] = [];
  const seeds: BlueprintReport["seeds"] = [];
  for (const file of state.scaffolded) {
    if (file === "manifest") continue;
    const spec = state.schema.fileSpecs[file];
    if (!spec) continue;
    let parsed: unknown;
    try {
      parsed = readYamlFile(join(state.stagingDir, `${file}.yaml`), { optional: true });
    } catch {
      parsed = undefined;
    }
    if (isEmptyValue(parsed)) {
      if (spec.required) gaps.push({ file, field: file, reason: "schema 需要但描述未覆盖，模型亦未填充，留空" });
    } else {
      const basedOnFacts = state.facts.filter((f) => f.file === file).map((f) => f.factId);
      seeds.push({ field: file, value: parsed, basedOnFacts });
    }
  }

  const files = readdirSync(state.stagingDir)
    .filter((n) => /\.(yaml|yml)$/.test(n))
    .sort()
    .map((n) => ({ path: n, bytes: statSync(join(state.stagingDir, n)).size, required: state.schema.requiredFiles.includes(n.replace(/\.(yaml|yml)$/, "")) }));

  const niFiles = neverInferFiles(state.schema);
  const reasons: string[] = [];
  if (state.facts.length === 0) reasons.push("无法切分描述");
  if (gaps.length > 0) reasons.push("必需文件存在留空字段");
  if (unallocated.length > 0) reasons.push("存在未分配事实");
  if (validation.conflicts.length > 0) reasons.push("核心与周边矛盾");
  if (state.facts.some((f) => f.file !== null && niFiles.has(f.file))) reasons.push("描述提及 neverInfer 内容，需人工抄录确认");
  if (retriesExhausted) reasons.push("重试 2 次仍未通过校验");

  return { stagingId: state.stagingId, stagingDir: state.stagingDir, core: state.core, files, allocation, gaps, unallocated, seeds, validation, needsHumanReview: reasons.length > 0, needsHumanReviewReasons: reasons, cost };
}

// ─── generate / promote ────────────────────────────────────────────────────

function defaultTargetId(kind: "identity" | "facility", suggestedId: string | undefined, stagingId: string): string {
  if (suggestedId && suggestedId.trim() !== "") return suggestedId.trim();
  return `${kind}-${stagingId.slice(0, 8)}`;
}

export function createBlueprintAuthor(deps: { root: string }): BlueprintAuthor {
  const { root } = deps;

  return {
    async generate(input: GenerateInput): Promise<BlueprintReport> {
      const schema = schemaFor(input.kind);
      const description = input.description ?? "";
      const stagingId = randomUUID();
      const stagingDir = join(root, "staging", stagingId);
      const tools = makeBlueprintTools({ stagingDir, schema });
      const cost: BlueprintReport["cost"] = { model: input.model.name, inputTokens: 0, outputTokens: 0, turns: 0 };
      const acc: ModelAcc = { inputTokens: 0, outputTokens: 0, turns: 0, conflicts: [], core: {} };

      // 第 1 步：normalize。切不出事实 ⇒ needsHumanReview，不进第 2 步（§24.3）。
      const facts = normalizeDescription(description.trim(), schema);
      if (facts.length === 0) {
        return {
          stagingId, stagingDir, core: {}, files: [], allocation: [], gaps: [], unallocated: [], seeds: [],
          validation: { ok: false, errors: [], conflicts: [] },
          needsHumanReview: true, needsHumanReviewReasons: ["无法切分描述"], cost,
        };
      }

      // 第 2 步：scaffold（第 1 步的产物是第 5 步 allocation 核对的唯一依据）。
      const targetId = defaultTargetId(input.kind, input.suggestedId, stagingId);
      const scaffolded = await scaffold(tools, schema, targetId, facts);
      const state = { description, facts, core: acc.core, scaffolded };

      // 第 3 步：seed core（模型）。
      await applyModelResponse(tools, schema, scaffolded, await input.model.generate(buildRequest(schema, "seed", state)), acc, true);

      // 第 4 步：expand（模型，neverInfer 已在 targets 里屏蔽）。
      await applyModelResponse(tools, schema, scaffolded, await input.model.generate(buildRequest(schema, "expand", state)), acc, false);

      // 第 5 步：validate + 分配核对；失败回到第 4 步最多重试 2 次（§24.3）。
      let validation = { ...(await tools.validate()), conflicts: acc.conflicts };
      let retries = 0;
      while (!validation.ok && retries < 2) {
        retries++;
        const feedback = validation.errors;
        await applyModelResponse(tools, schema, scaffolded, await input.model.generate(buildRequest(schema, "expand", state, feedback)), acc, false);
        validation = { ...(await tools.validate()), conflicts: [...acc.conflicts] };
      }

      cost.inputTokens = acc.inputTokens;
      cost.outputTokens = acc.outputTokens;
      cost.turns = acc.turns;

      const report = buildReport({ stagingId, stagingDir, schema, facts, scaffolded, core: acc.core }, validation, cost, retries >= 2 && !validation.ok);

      // 谱系元数据落盘（hidden .json，不进蓝本文件集；promote 读回固化）。
      const meta: ProvenanceMeta = {
        description,
        kind: input.kind,
        model: input.model.name,
        cost,
        suggestedId: targetId,
        needsHumanReview: report.needsHumanReview,
        needsHumanReviewReasons: report.needsHumanReviewReasons,
      };
      writeFileSync(join(stagingDir, META_FILE), JSON.stringify(meta, null, 2), "utf8");

      return report;
    },

    async promote(stagingId: string, opts?: PromoteInput): Promise<PromoteResult> {
      const stagingDir = join(root, "staging", stagingId);
      if (!existsSync(stagingDir)) throw new ValidationError(`staging not found: ${stagingId}`);
      const metaPath = join(stagingDir, META_FILE);
      if (!existsSync(metaPath)) throw new ValidationError(`staging has no provenance meta: ${stagingId}`);
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ProvenanceMeta;
      const schema = schemaFor(meta.kind);
      const tools = makeBlueprintTools({ stagingDir, schema });

      const targetId = (opts?.targetId && opts.targetId.trim() !== "" ? opts.targetId.trim() : meta.suggestedId) || `${meta.kind}-${stagingId.slice(0, 8)}`;
      const templateRoot = join(root, "templates", meta.kind === "identity" ? "identities" : "facilities");
      const targetDir = join(templateRoot, targetId);

      // 第 2 步：目标 id 冲突检查，不合并/不覆盖/不加后缀（§24.6）。
      if (existsSync(targetDir)) throw new ValidationError(`target blueprint already exists: ${targetId}`);

      // 第 3–4 步：写 provenance.yaml 并登记进 manifest.files（§24.6）。
      const provenance = {
        description: meta.description,
        kind: meta.kind,
        model: meta.model,
        cost: meta.cost,
        stagingId,
        suggestedId: meta.suggestedId,
        needsHumanReview: meta.needsHumanReview,
        needsHumanReviewReasons: meta.needsHumanReviewReasons,
        promotedAt: new Date().toISOString(),
      };
      tools.write(PROVENANCE_FILE, stringifyYaml(provenance));
      const manifest = readYamlFile<{ files?: Array<{ path?: string; priority?: string }> }>(join(stagingDir, "manifest.yaml"), { optional: true }) ?? {};
      const files = [...(manifest.files ?? []), { path: PROVENANCE_FILE, priority: "lazy" }];
      tools.write("manifest.yaml", stringifyYaml({ ...manifest, files }));

      // 第 1 步（在加上 provenance 之后的文件集上校验，§24.6 注）：不过则留在 staging，不 rename。
      const report = await tools.validate();
      if (!report.ok) throw new ValidationError(`blueprint validation failed on promote: ${report.errors.join("; ")}`);

      // 卸掉隐藏元数据（不随 rename 进入蓝本目录），再原子 rename（§24.6 第 5 步）。
      rmSync(metaPath, { force: true });
      await mkdir(templateRoot, { recursive: true });
      await rename(stagingDir, targetDir);

      return { targetId, blueprintDir: targetDir, provenancePath: join(targetDir, PROVENANCE_FILE), provenance };
    },
  };
}

export { META_FILE, PROVENANCE_FILE };