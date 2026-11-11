// ═══════════════════════════════════════════════════════════════════════════
// 蓝本导出（O01 / §6.4）：把已运行 Agent 的可信成长状态固化成一份「新蓝本」
//
// 谱系是纯本环概念，mesh 完全不参与（§6.4.2）：导出不产生任何 mesh 调用，新蓝本在 mesh
// 里不存在（蓝本没有账号）。产物写进 <root>/templates/identities/<blueprintId>/，绝不覆写
// 来源蓝本（来源目录只读）。
//
// 内容组成（§6.4.1 分级）：
//   · 静态蓝本文件（personal/constraints/narrative_voice/…）→ 复制自来源蓝本；
//   · skills / specialties → 缺省导出（knowledge_items 领域能力，可迁移）；
//   · social → 仅显式 include，且**必须走脱敏**（subject_id/mesh 同伴 id → 角色泛称）；
//   · shadow → 仅显式 include，不脱敏（它是最不可迁移的一份，含同伴指称时由断言拒绝）；
//   · evolution.yaml → 一律丢弃（它是 agent_state 的运行投影，带上等于让新 Agent 天生
//     一份别人的运行计数）；
//   · provenance.yaml → 谱系元数据（blueprintId/blueprintHash/derivedFrom/generation），
//     不参与 mesh 状态断言（lineage 自身合法持有 promptVersion 与来源 agentId）。
//
// 断言净化（§6.4.1 v2 缝）：导出的**内容文件**（不含 provenance.yaml 元数据）不得携带任何
// mesh 身份平面字段（account/endpoint/conversation/seq/seal/correlationId/promptVersion）
// 或出现别的 agentId。命中任一即抛 BlueprintExportError，不产出蓝本。
//
// 分层纪律：本文件属 src/runtime/**，不 import @pi/agent-mesh；只读 DB-A + compile/ 叶子。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

import type Database from "better-sqlite3";

import { fingerprintOf, hashDirectoryContents, listFiles } from "../compile/fingerprint.js";
import { assertContained, assertSafeSegment } from "../compile/path-guard.js";
import { COMPILER_VERSION } from "../compile/version.js";
import { parseYamlText, readYamlFile, stringifyYaml } from "../compile/yaml.js";
import { BlueprintExportError, BlueprintNotFound, ValidationError } from "./errors.js";
import type { BlueprintExportViolation } from "./errors.js";
import { computeGrowthProjection } from "./projector.js";
import type { ExportAsBlueprintInput, ExportAsBlueprintResult } from "./types.js";

/** 谱系元数据文件（§6.4：「谱系元数据…写进新蓝本的 blueprint.yaml」；实现沿用 provenance.yaml）。 */
const LINEAGE_FILE = "provenance.yaml";

/** 蓝本层模型默认文件（§5.4 第 2 层）。设计 §6.4 称 model.yaml，实现为 model_defaults.yaml。 */
const MODEL_DEFAULTS_FILE = "model_defaults.yaml";

// ─── 行形状 ─────────────────────────────────────────────────────────────────

interface AgentRow {
  agent_id: string;
  blueprint_dir: string;
  blueprint_hash: string;
  identity_dir: string | null;
  model_config_json: string | null;
}

// ─── 静态内容拼装 ───────────────────────────────────────────────────────────

/** 把来源蓝本目录解析为绝对路径（与 create() 的 resolveBlueprintDir 同款语义）。 */
function resolveSourceDir(root: string, blueprint: string): string {
  return isAbsolute(blueprint) ? blueprint : join(root, blueprint);
}

/** 复制来源蓝本目录下除 provenance.yaml 外的全部文件到新目录。 */
async function copyStaticFiles(sourceDir: string, targetDir: string): Promise<string[]> {
  const files = await listFiles(sourceDir);
  const copied: string[] = [];
  for (const rel of files) {
    if (rel === LINEAGE_FILE) continue;
    const content = await readFile(join(sourceDir, rel));
    await writeFile(join(targetDir, rel), content);
    copied.push(rel);
  }
  return copied;
}

/** 把来源 identity 蓝本 manifest.yaml 的 identity.id 改写为新蓝本 id（新蓝本是独立身份）。 */
async function rewriteManifestId(targetDir: string, blueprintId: string): Promise<void> {
  const p = join(targetDir, "manifest.yaml");
  const manifest = readYamlFile<Record<string, unknown>>(p, { optional: true }) ?? {};
  const identity = (manifest["identity"] as Record<string, unknown> | undefined) ?? {};
  identity["id"] = blueprintId;
  manifest["identity"] = identity;
  await writeFile(p, stringifyYaml(manifest), "utf8");
}

/** 来源蓝本 knowledge_boundaries.yaml 的 knowledge 数组（可能缺省）。 */
function sourceKnowledge(targetDir: string): Array<{ topic: string; claim: string }> {
  const kb = readYamlFile<{ knowledge?: Array<{ topic?: unknown; claim?: unknown }> }>(
    join(targetDir, "knowledge_boundaries.yaml"),
    { optional: true },
  );
  const out: Array<{ topic: string; claim: string }> = [];
  for (const it of kb?.knowledge ?? []) {
    if (it && typeof it.topic === "string" && it.topic.trim() !== "") {
      out.push({ topic: it.topic.trim(), claim: typeof it.claim === "string" ? it.claim : it.topic.trim() });
    }
  }
  return out;
}

/** 把导出的 skills/specialties（topic+claim）并入 knowledge_boundaries 种子（§17.4 来源 1，
 *  从而新 Agent 用这份蓝本创建时即「起跑」）。last-wins 去重，mastered（specialties 在 skills 之后）优先。 */
async function mergeKnowledgeSeed(targetDir: string, entries: Array<{ topic: string; claim: string }>): Promise<void> {
  const existing = sourceKnowledge(targetDir);
  const merged = new Map<string, string>();
  for (const e of [...existing, ...entries]) merged.set(e.topic, e.claim);
  const knowledge = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([topic, claim]) => ({ topic, claim }));
  const kb = readYamlFile<Record<string, unknown>>(join(targetDir, "knowledge_boundaries.yaml"), { optional: true }) ?? {};
  await writeFile(join(targetDir, "knowledge_boundaries.yaml"), stringifyYaml({ ...kb, knowledge }), "utf8");
}

// ─── social 脱敏（§6.4.1：每一行都是一个具体同伴，导出时必须泛称化）──────────

/** 把 social.yaml 里的同伴 agent id 替换为角色泛称（`认真同学 1..N`），保留同伴间区分度。 */
function sanitizeSocial(social: Record<string, unknown>, peerIds: ReadonlySet<string>): Record<string, unknown> {
  const list = social["acquaintances"];
  if (!Array.isArray(list)) return social;

  const sortedIds = [...peerIds].sort();
  const idToGeneric = new Map<string, string>();
  sortedIds.forEach((id, i) => idToGeneric.set(id, `一位同学·${i + 1}`));

  const replaceText = (text: string): string => {
    let out = text;
    for (const [id, generic] of idToGeneric) out = out.split(id).join(generic);
    return out;
  };

  const acquaintances = list.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (k === "subject_id" && typeof v === "string" && idToGeneric.has(v)) {
        next[k] = idToGeneric.get(v)!;
      } else if (typeof v === "string") {
        next[k] = replaceText(v);
      } else {
        next[k] = v;
      }
    }
    return next;
  });

  return { ...social, acquaintances };
}

// ─── mesh 状态断言（§6.4.1 v2 缝）───────────────────────────────────────────

/** 归一化字段名：小写并剥离非字母数字。用于把 accountId / mesh_account_id / account_id 归一。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** mesh 身份平面禁止字段（键名，归一化后精确匹配，避免子串误伤如 sequence）。 */
const BANNED_KEYS = new Map<string, BlueprintExportViolation>([
  ["accountid", "MESH_ACCOUNT_ID_PRESENT"],
  ["meshaccountid", "MESH_ACCOUNT_ID_PRESENT"],
  ["endpointid", "ENDPOINT_ID_PRESENT"],
  ["reflectendpointid", "ENDPOINT_ID_PRESENT"],
  ["conversationid", "CONVERSATION_ID_PRESENT"],
  ["reflectconversationid", "CONVERSATION_ID_PRESENT"],
  ["seq", "SEQ_OR_SEAL_PRESENT"],
  ["seal", "SEQ_OR_SEAL_PRESENT"],
  ["correlationid", "SEQ_OR_SEAL_PRESENT"],
  ["promptversion", "PROMPT_VERSION_PRESENT"],
]);

interface Violation {
  code: BlueprintExportViolation;
  where: string;
}

/** 递归扫描一棵解析后的 YAML 值，收集 mesh 身份字段与同伴 agent id 指称。 */
function scanValue(value: unknown, peerIds: ReadonlySet<string>, path: string, out: Violation[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(v, peerIds, `${path}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path === "" ? k : `${path}.${k}`;
      const banned = BANNED_KEYS.get(normalizeKey(k));
      if (banned) {
        out.push({ code: banned, where: p });
        continue;
      }
      scanValue(v, peerIds, p, out);
    }
    return;
  }
  if (typeof value === "string") {
    for (const id of peerIds) {
      if (value.includes(id)) {
        out.push({ code: "PEER_AGENT_ID_PRESENT", where: path });
        return;
      }
    }
  }
}

/** 扫描新蓝本全部**内容**文件（排除 provenance.yaml 元数据）的 mesh 状态污染。 */
async function scanExportable(dir: string, peerIds: ReadonlySet<string>): Promise<Violation[]> {
  const files = (await listFiles(dir)).filter((rel) => rel !== LINEAGE_FILE);
  const out: Violation[] = [];
  for (const rel of files) {
    const text = await readFile(join(dir, rel), "utf8");
    let parsed: unknown;
    try {
      parsed = parseYamlText<unknown>(text, rel);
    } catch {
      // 静态蓝本文件可能不是 YAML（未来扩展）；跳过不可解析文件——它们不会被编译为含 mesh 字段的内容。
      continue;
    }
    scanValue(parsed, peerIds, rel, out);
  }
  return out;
}

// ─── 谱系 generation ────────────────────────────────────────────────────────

function sourceGeneration(sourceDir: string): number {
  const lineage = readYamlFile<{ lineage?: { generation?: unknown } }>(join(sourceDir, LINEAGE_FILE), {
    optional: true,
  });
  const g = lineage?.lineage?.generation;
  return typeof g === "number" && Number.isFinite(g) ? g : 0;
}

// ─── 公开入口 ───────────────────────────────────────────────────────────────

/** §6.4 exportAsBlueprint：从可信成长状态导出谱系与隐私受控的新蓝本，不覆盖来源蓝本。 */
export async function exportAsBlueprint(
  db: Database.Database,
  root: string,
  input: ExportAsBlueprintInput,
): Promise<ExportAsBlueprintResult> {
  const now = new Date().toISOString();

  // 来源 Agent 必须存在且已物化实例模板。
  const row = db.prepare<[string], AgentRow>(
    `SELECT agent_id, blueprint_dir, blueprint_hash, identity_dir, model_config_json FROM agents WHERE agent_id = ?`,
  ).get(input.agentId);
  if (!row) throw new ValidationError(`agent not found: ${input.agentId}`);
  if (!row.identity_dir) throw new ValidationError(`agent has no instance template: ${input.agentId}`);

  // 新蓝本 id：必须为单段、不得等于来源蓝本 id（create 语义，绝不改写来源）。
  assertSafeSegment(input.blueprintId, "blueprintId");
  const sourceDir = resolveSourceDir(root, row.blueprint_dir);
  if (!existsSync(sourceDir)) throw new BlueprintNotFound(row.blueprint_dir);
  const derivedFrom = basename(sourceDir);
  if (input.blueprintId === derivedFrom) {
    throw new ValidationError(`blueprintId must differ from source blueprint id: ${derivedFrom}`);
  }

  const identityRoot = join(root, "templates", "identities");
  const targetDir = assertContained(identityRoot, join(identityRoot, input.blueprintId), "exported blueprint directory");
  if (existsSync(targetDir)) {
    throw new ValidationError(`target blueprint already exists: ${input.blueprintId}`);
  }

  // 同伴 roster：同库内除来源外的所有 agent_id。social 脱敏与 PEER_AGENT_ID_PRESENT 断言共用。
  const peerRows = db.prepare<[string], { agent_id: string }>("SELECT agent_id FROM agents WHERE agent_id <> ?").all(input.agentId);
  const peerIds = new Set(peerRows.map((r) => r.agent_id));

  const include = input.include ?? ["skills", "specialties"];
  const includeSet = new Set(include);
  const growth = computeGrowthProjection(db, input.agentId);

  await mkdir(targetDir, { recursive: true });
  try {
    await copyStaticFiles(sourceDir, targetDir);
    await rewriteManifestId(targetDir, input.blueprintId);

    // growth 可写文件写入（evolution 一律丢弃）。
    const seedEntries: Array<{ topic: string; claim: string }> = [];
    if (includeSet.has("skills")) {
      const list = ((growth.skills["skills"] as Array<{ topic: string; claim: string; mastery?: string }> | undefined) ?? []).map((s) => ({ topic: s.topic, claim: s.claim }));
      await writeFile(join(targetDir, "skills.yaml"), stringifyYaml(growth.skills), "utf8");
      seedEntries.push(...list);
    }
    if (includeSet.has("specialties")) {
      const list = ((growth.specialties["specialties"] as Array<{ topic: string; claim: string; mastery?: string }> | undefined) ?? []).map((s) => ({ topic: s.topic, claim: s.claim }));
      await writeFile(join(targetDir, "specialties.yaml"), stringifyYaml(growth.specialties), "utf8");
      seedEntries.push(...list);
    }
    if (includeSet.has("social")) {
      await writeFile(join(targetDir, "social.yaml"), stringifyYaml(sanitizeSocial(growth.social, peerIds)), "utf8");
      // social 不并入知识种子——印象不是知识。
    }
    if (includeSet.has("shadow")) {
      // shadow 不脱敏：它是最不可迁移的一份，含同伴指称时由下方断言拒绝。
      await writeFile(join(targetDir, "shadow.yaml"), stringifyYaml(growth.shadow), "utf8");
    }
    if (seedEntries.length > 0) {
      await mergeKnowledgeSeed(targetDir, seedEntries);
    }

    // freezeModelConfig：把当前模型配置写成蓝本层 model_defaults.yaml（§5.4 第 2 层）。
    if (input.freezeModelConfig && row.model_config_json) {
      const cfg = JSON.parse(row.model_config_json) as unknown;
      await writeFile(join(targetDir, MODEL_DEFAULTS_FILE), stringifyYaml(cfg), "utf8");
    }

    // 谱系哈希 = provenance.yaml 写入之前的目录内容哈希（内容文件，不含元数据自身，避免自指）。
    const blueprintHash = await hashDirectoryContents(targetDir);

    const promptVersion = fingerprintOf([
      await hashDirectoryContents(join(root, row.identity_dir)),
      COMPILER_VERSION,
    ]);

    const provenance = {
      kind: "identity",
      description: input.note ?? "",
      exportedAt: now,
      lineage: {
        blueprintId: input.blueprintId,
        blueprintHash,
        derivedFrom,
        derivedFromAgent: { agentId: input.agentId, promptVersion, exportedAt: now },
        generation: sourceGeneration(sourceDir) + 1,
      },
    };
    await writeFile(join(targetDir, LINEAGE_FILE), stringifyYaml(provenance), "utf8");

    // 净化断言：内容文件不得携带任何 mesh 身份字段或同伴 id。命中即整体失败，不产出蓝本。
    const violations = await scanExportable(targetDir, peerIds);
    if (violations.length > 0) {
      throw new BlueprintExportError(violations, "blueprint carries mesh identity or peer agent ids");
    }

    return {
      blueprintId: input.blueprintId,
      blueprintDir: relative(root, targetDir),
      blueprintHash,
      lineage: provenance.lineage,
    };
  } catch (err) {
    // A16 同款：本目录由本调用创建并完全拥有，失败只清理自己刚创建的目录，绝不触碰既有文件。
    const { rmSync } = await import("node:fs");
    rmSync(targetDir, { recursive: true, force: true });
    throw err;
  }
}