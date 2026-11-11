// ═══════════════════════════════════════════════════════════════════════════
// Projector（R09 / §6.2）：DB → 实例文件的纯、单向、幂等渲染器
//
// 输入是 role-agent.db 的当前状态，输出是 <root>/agents/<id>/identity/（模板回写）
// 与 <root>/agents/<id>/memory/（记忆投影，纯文本快照，不进 identity_read 范围）。
// 无锁、无顺序假设、可任意次全量重跑（§6.2.1）；投影不是运行期记忆权威，DB 才是唯一写入源。
//
// 职责边界（§6.2.1 / C5）：会话镜像与投递状态归 mesh，本模块绝不落库会话/收投递事件；
// 手工编辑实例模板由 reconcile() 作为「外部输入」审计后导入（state_writes 来源 manual）。
//
// 分层纪律：本文件属 src/runtime/**，不 import @pi/agent-mesh；只读 DB-A 各领域表。
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type Database from "better-sqlite3";

import { assertSafeSegment } from "../compile/path-guard.js";
import { parseYamlText, stringifyYaml } from "../compile/yaml.js";
import { projectEpisode, renderRelativeTime } from "../memory/render.js";
import { ValidationError } from "./errors.js";

/** 短期记忆投影的最近条数上限（§6.2 short_term.md ≈ 近 N 条 + 高 retention）。 */
const SHORT_TERM_LIMIT = 20;

// ─── 行形状 ─────────────────────────────────────────────────────────────────

interface StateRow {
  key: string;
  value_json: string;
}

interface KnowledgeRow {
  topic: string;
  claim: string;
  mastery: string;
}

interface PersonRow {
  subject_id: string;
  impression: string | null;
  valence: number | null;
  closeness: number | null;
  trust: number | null;
}

interface ReflectionRow {
  output_json: string | null;
  started_at: string;
}

interface EpisodeRow {
  gist: string;
  detail: string | null;
  quote: string | null;
  emotion: string | null;
  valence: number | null;
  arousal: number | null;
  retention: number;
  virtual_ts: string | null;
  virtual_hours: number;
  status: string;
}

interface SubjectRow {
  subject_type: string;
  subject_id: string;
  impression: string | null;
  valence: number | null;
  closeness: number | null;
  trust: number | null;
  episode_count: number;
}

// ─── 实例目录（§6.2）────────────────────────────────────────────────────────

function agentDirs(root: string, agentId: string): { identityDir: string; memoryDir: string } {
  // A01 同款段校验：agentId 是外部输入，拼入 <root>/agents/<id> 前先拒绝穿越。
  assertSafeSegment(agentId, "agentId");
  const base = join(root, "agents", agentId);
  return { identityDir: join(base, "identity"), memoryDir: join(base, "memory") };
}

/** subject_id 未必是安全文件名（person 允许 'npc:*' 等），落盘前收敛为安全 slug，
 *  不含 `.`（含 `..`）/分隔符/Windows 保留名——单一段落盘，无从穿越。 */
function subjectSlug(subjectType: string, subjectId: string): string {
  if (subjectType === "self") return "self";
  const slug = (s: string): string => {
    const base = s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    const core = base.length === 0 ? "_" : base;
    return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(core) ? `_${core}_` : core;
  };
  return `${slug(subjectType)}-${slug(subjectId)}`;
}

function readState(db: Database.Database, agentId: string): Map<string, unknown> {
  const rows = db
    .prepare<[string], StateRow>("SELECT key, value_json FROM agent_state WHERE agent_id = ?")
    .all(agentId);
  const out = new Map<string, unknown>();
  for (const r of rows) {
    try {
      out.set(r.key, JSON.parse(r.value_json));
    } catch {
      out.set(r.key, null);
    }
  }
  return out;
}

// ─── 渲染（纯函数：DB → 对象 / Markdown）────────────────────────────────────

/** evolution.yaml：agent_state 的情绪/精力写回。它是冷启动文件之一，可能夹带静态字段
 * （如 memory-policy 编译器会读的 growth_rules），因此回写是「浅合并」——只覆盖运行期持有的
 * mood/moodIntensity/energy，其余模板键原样保留（§6.2 投影不做记忆权威，也不删模板配置）。 */
function renderEvolution(state: Map<string, unknown>, existing: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const mood = state.get("mood");
  out.mood = typeof mood === "string" ? mood : "中性";
  const moodIntensity = state.get("mood_intensity");
  out.moodIntensity = typeof moodIntensity === "number" ? moodIntensity : 0.5;
  const energy = state.get("energy");
  out.energy = typeof energy === "number" ? energy : 0.8;
  return out;
}

function knowledgeRows(db: Database.Database, agentId: string): KnowledgeRow[] {
  return db
    .prepare<[string], KnowledgeRow>(
      `SELECT topic, claim, mastery FROM knowledge_items
        WHERE owner_agent = ? AND is_misconception = 0
        ORDER BY topic`,
    )
    .all(agentId);
}

/** skills.yaml：全部非误区知识项。 */
function renderSkills(rows: KnowledgeRow[]): Record<string, unknown> {
  return {
    skills: rows.map((r) => ({ topic: r.topic, claim: r.claim, mastery: r.mastery })),
  };
}

/** specialties.yaml：mastered 的知识项（§6.4.1 谱系迁移的价值所在）。 */
function renderSpecialties(rows: KnowledgeRow[]): Record<string, unknown> {
  return {
    specialties: rows
      .filter((r) => r.mastery === "mastered")
      .map((r) => ({ topic: r.topic, claim: r.claim, mastery: r.mastery })),
  };
}

/** social.yaml：subject_profiles(person) 的印象（§6.4.1 每行一个具体同伴）。 */
function renderSocial(rows: PersonRow[]): Record<string, unknown> {
  const acquaintances = rows.flatMap((r) => {
    const entry: Record<string, unknown> = { subject_id: r.subject_id, impression: r.impression ?? "" };
    if (r.valence != null) entry.valence = r.valence;
    if (r.closeness != null) entry.closeness = r.closeness;
    if (r.trust != null) entry.trust = r.trust;
    return [entry];
  });
  return { acquaintances };
}

/** shadow.yaml：reflections.selfInsights（§6.4.1 最不可迁移的一份）。 */
function renderShadow(rows: ReflectionRow[]): Record<string, unknown> {
  const insights: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (!r.output_json) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.output_json);
    } catch {
      continue;
    }
    const selfInsights = (parsed as { selfInsights?: unknown }).selfInsights;
    if (!Array.isArray(selfInsights)) continue;
    for (const s of selfInsights as Array<{ gist?: unknown; detail?: unknown; salience?: unknown }>) {
      if (typeof s?.gist !== "string" || s.gist.trim().length === 0) continue;
      const entry: Record<string, unknown> = { gist: s.gist, at: r.started_at };
      if (typeof s.detail === "string" && s.detail.length > 0) entry.detail = s.detail;
      if (typeof s.salience === "number") entry.salience = s.salience;
      insights.push(entry);
    }
  }
  return { self_insights: insights };
}

function loadEpisodes(db: Database.Database, agentId: string): EpisodeRow[] {
  return db
    .prepare<[string], EpisodeRow>(
      `SELECT gist, detail, quote, emotion, valence, arousal, retention, virtual_ts, virtual_hours, status
         FROM episodes WHERE owner_agent = ?
        ORDER BY virtual_hours DESC, real_ts DESC`,
    )
    .all(agentId);
}

function loadPersons(db: Database.Database, agentId: string): PersonRow[] {
  return db
    .prepare<[string], PersonRow>(
      `SELECT subject_id, impression, valence, closeness, trust FROM subject_profiles
        WHERE owner_agent = ? AND subject_type = 'person' ORDER BY subject_id`,
    )
    .all(agentId);
}

function loadSubjects(db: Database.Database, agentId: string): SubjectRow[] {
  return db
    .prepare<[string], SubjectRow>(
      `SELECT subject_type, subject_id, impression, valence, closeness, trust, episode_count
         FROM subject_profiles WHERE owner_agent = ? ORDER BY subject_type, subject_id`,
    )
    .all(agentId);
}

function loadReflections(db: Database.Database, agentId: string): ReflectionRow[] {
  return db
    .prepare<[string], ReflectionRow>(
      `SELECT output_json, started_at FROM reflections
        WHERE owner_agent = ? AND status = 'done' ORDER BY started_at`,
    )
    .all(agentId);
}

/** short_term.md：最近 N 条活跃情节，相对时间按最新一条虚拟时刻。 */
function renderShortTerm(rows: EpisodeRow[]): string {
  const recent = rows.filter((r) => r.status === "active").slice(0, SHORT_TERM_LIMIT);
  if (recent.length === 0) return "# 短期记忆\n\n（暂无活跃情节。）\n";
  const now = recent[0]!.virtual_hours;
  const lines = ["# 短期记忆", ""];
  for (const ep of recent) {
    const projected = projectEpisode(ep);
    const when = ep.virtual_ts ?? renderRelativeTime(now, ep.virtual_hours);
    lines.push(`- ${when}　${projected.gist}`);
    if (projected.detail) lines.push(`  - 细节：${projected.detail}`);
    if (projected.quote) lines.push(`  - 原话：「${projected.quote}」`);
    if (projected.emotion) {
      const attrs = [
        projected.valence != null ? `valence=${projected.valence.toFixed(2)}` : null,
        projected.arousal != null ? `arousal=${projected.arousal.toFixed(2)}` : null,
      ].filter(Boolean);
      lines.push(`  - 情绪：${projected.emotion}${attrs.length ? `（${attrs.join("，")}）` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** long_term.md：巩固后的情节（status='consolidated'）。 */
function renderLongTerm(rows: EpisodeRow[]): string {
  const consolidated = rows.filter((r) => r.status === "consolidated");
  if (consolidated.length === 0) return "# 长期记忆\n\n（暂无巩固情节。）\n";
  const lines = ["# 长期记忆", ""];
  for (const ep of consolidated) {
    lines.push(`- ${projectEpisode(ep).gist}`);
  }
  return lines.join("\n") + "\n";
}

/** subjects/<slug>.md：「我对 <subject> 的记忆」纯文本快照。 */
function renderSubjectFile(r: SubjectRow): string {
  const header = r.subject_type === "self" ? "关于我自己的记忆" : `关于 ${r.subject_type}:${r.subject_id} 的记忆`;
  const lines = [`# ${header}`, ""];
  if (r.impression) lines.push(`印象：${r.impression}`, "");
  const attrs: string[] = [];
  if (r.valence != null) attrs.push(`valence=${r.valence.toFixed(2)}`);
  if (r.closeness != null) attrs.push(`closeness=${r.closeness.toFixed(2)}`);
  if (r.trust != null) attrs.push(`trust=${r.trust.toFixed(2)}`);
  attrs.push(`经历 ${r.episode_count} 条`);
  lines.push(attrs.join("，"));
  return lines.join("\n") + "\n";
}

// ─── 聚合投影（供 reproject / reconcile 共用）───────────────────────────────

interface Projection {
  /** 相对 identityDir 的文件名 → 文件内容（YAML 文本）。 */
  templates: Map<string, string>;
  /** 相对 memoryDir 的文件名 → 文件内容（Markdown 文本）。 */
  memories: Map<string, string>;
}

function computeProjection(db: Database.Database, agentId: string, identityDir: string): Projection {
  const state = readState(db, agentId);
  const growth = computeGrowthProjection(db, agentId);
  const subjects = loadSubjects(db, agentId);
  const episodes = loadEpisodes(db, agentId);

  // evolution.yaml 是冷启动文件：保留模板静态键，只回写运行期持有的状态键。
  const existingEvolution = readExistingEvolution(identityDir);

  const templates = new Map<string, string>();
  templates.set("evolution.yaml", stringifyYaml(renderEvolution(state, existingEvolution)));
  templates.set("skills.yaml", stringifyYaml(growth.skills));
  templates.set("specialties.yaml", stringifyYaml(growth.specialties));
  templates.set("social.yaml", stringifyYaml(growth.social));
  templates.set("shadow.yaml", stringifyYaml(growth.shadow));

  const memories = new Map<string, string>();
  memories.set("short_term.md", renderShortTerm(episodes));
  memories.set("long_term.md", renderLongTerm(episodes));
  for (const s of subjects) {
    memories.set(join("subjects", `${subjectSlug(s.subject_type, s.subject_id)}.md`), renderSubjectFile(s));
  }

  return { templates, memories };
}

/** §6.4：四个 growth 可写文件的对象形式（不落盘），供 exportAsBlueprint 复用与脱敏。 */
export interface GrowthProjection {
  skills: Record<string, unknown>;
  specialties: Record<string, unknown>;
  social: Record<string, unknown>;
  shadow: Record<string, unknown>;
}

/** 渲染 §6.2 的四个 growth 投影为对象（不触碰 evolution，它在导出时被丢弃）。 */
export function computeGrowthProjection(db: Database.Database, agentId: string): GrowthProjection {
  const knowledge = knowledgeRows(db, agentId);
  return {
    skills: renderSkills(knowledge),
    specialties: renderSpecialties(knowledge),
    social: renderSocial(loadPersons(db, agentId)),
    shadow: renderShadow(loadReflections(db, agentId)),
  };
}

/** 读取既有 evolution.yaml（可能含蓝图静态键）；不存在或坏文件返回 {}。 */
function readExistingEvolution(identityDir: string): Record<string, unknown> {
  const p = join(identityDir, "evolution.yaml");
  if (!existsSync(p)) return {};
  try {
    const parsed = parseYamlText<unknown>(readFileSync(p, "utf8"), p);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ─── 公开入口 ───────────────────────────────────────────────────────────────

export interface ReprojectResult {
  /** 相对 root 的已写文件路径（自足可 grep/diff 的当前快照，§6.3 理由 d）。 */
  files: string[];
}

export interface ReconcileImport {
  file: string;
  field: string;
  from: unknown;
  to: unknown;
}

export interface ReconcileResult {
  /** 从手工改动的模板文件导入 DB 的差异（均已记 state_writes 审计）。 */
  imported: ReconcileImport[];
  /** 检测到但不可回导（只读/受状态机管控）的字段，重投影会覆盖回去。 */
  ignored: Array<{ file: string; field: string; reason: string }>;
  /** 重新投影写出的文件路径。 */
  reprojected: string[];
}

function assertAgentExists(db: Database.Database, agentId: string): void {
  const row = db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM agents WHERE agent_id = ?").get(agentId);
  if (!row || row.n === 0) throw new ValidationError(`agent not found: ${agentId}`);
  const fields = db.prepare<[string], { identity_dir: string | null }>(
    "SELECT identity_dir FROM agents WHERE agent_id = ?",
  ).get(agentId);
  if (!fields?.identity_dir) throw new ValidationError(`agent has no instance template: ${agentId}`);
}

/**
 * 重投影：把 DB 当前状态渲染成全部实例文件并落盘（幂等，可任意次重跑，损坏即重建）。
 * 蓝本不变；投影不作为运行期记忆权威。
 */
export function reproject(db: Database.Database, root: string, agentId: string): ReprojectResult {
  assertAgentExists(db, agentId);
  const { identityDir, memoryDir } = agentDirs(root, agentId);
  const projection = computeProjection(db, agentId, identityDir);

  const written: string[] = [];
  for (const [name, content] of projection.templates) {
    const p = join(identityDir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
    written.push(relative(root, p));
  }
  for (const [name, content] of projection.memories) {
    const p = join(memoryDir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
    written.push(relative(root, p));
  }
  return { files: written.sort() };
}

function auditWrite(
  db: Database.Database,
  agentId: string,
  target: "subject_profile" | "knowledge" | "agent_state",
  targetId: string,
  op: string,
  before: unknown,
  after: unknown,
  now: string,
): void {
  db.prepare(
    `INSERT INTO state_writes
       (write_id, owner_agent, target, target_id, op, reason, before_json, after_json, actor, real_ts)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, 'Projector', ?)`,
  ).run(
    randomUUID(),
    agentId,
    target,
    targetId,
    op,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    now,
  );
}

/** 把 evolution.yaml 的情绪/精力手工改动导入 agent_state（绝对值，非 Δ）。 */
function reconcileEvolution(
  db: Database.Database,
  agentId: string,
  disk: unknown,
  expected: Record<string, unknown>,
  now: string,
): ReconcileImport[] {
  const d = (disk ?? {}) as Record<string, unknown>;
  const imported: ReconcileImport[] = [];
  const set = (dbKey: string, yamlKey: string, value: unknown): void => {
    const prev = expected[yamlKey];
    db.prepare(
      `INSERT INTO agent_state (agent_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(agentId, dbKey, JSON.stringify(value), now);
    auditWrite(db, agentId, "agent_state", dbKey, "update", prev, value, now);
    imported.push({ file: "evolution.yaml", field: yamlKey, from: prev, to: value });
  };
  if (typeof d.mood === "string" && d.mood !== expected.mood) set("mood", "mood", d.mood);
  for (const [dbKey, yamlKey] of [["mood_intensity", "moodIntensity"], ["energy", "energy"]] as const) {
    const value = d[yamlKey];
    if (typeof value === "number" && Number.isFinite(value) && value !== expected[yamlKey]) {
      set(dbKey, yamlKey, value);
    }
  }
  return imported;
}

/** 把 skills/specialties 的 claim 手工改动导入 knowledge_items（mastery 受状态机管控，不回导）。 */
function reconcileClaimsFile(
  db: Database.Database,
  agentId: string,
  fileName: string,
  listKey: "skills" | "specialties",
  disk: unknown,
  ignored: Array<{ file: string; field: string; reason: string }>,
  now: string,
): ReconcileImport[] {
  const list = (disk as { [k: string]: unknown } | undefined)?.[listKey];
  if (!Array.isArray(list)) return [];
  const imported: ReconcileImport[] = [];
  for (const item of list as Array<{ topic?: unknown; claim?: unknown; mastery?: unknown }>) {
    if (!item || typeof item.topic !== "string" || item.topic.length === 0) continue;
    if (typeof item.claim !== "string") continue;
    const cur = db
      .prepare<[string, string], { claim: string }>(
        "SELECT claim FROM knowledge_items WHERE owner_agent = ? AND topic = ?",
      )
      .get(agentId, item.topic);
    if (!cur || cur.claim === item.claim) continue;
    db.prepare("UPDATE knowledge_items SET claim = ?, updated_at = ? WHERE owner_agent = ? AND topic = ?")
      .run(item.claim, now, agentId, item.topic);
    auditWrite(db, agentId, "knowledge", item.topic, "update", cur.claim, item.claim, now);
    imported.push({ file: fileName, field: `${listKey}[${item.topic}].claim`, from: cur.claim, to: item.claim });
  }
  return imported;
}

/** 把 social.yaml 的 impression 手工改动导入 subject_profiles（数值字段受自省限幅，不回导）。 */
function reconcileSocial(
  db: Database.Database,
  agentId: string,
  disk: unknown,
  now: string,
): ReconcileImport[] {
  const list = (disk as { acquaintances?: unknown } | undefined)?.acquaintances;
  if (!Array.isArray(list)) return [];
  const imported: ReconcileImport[] = [];
  for (const item of list as Array<{ subject_id?: unknown; impression?: unknown }>) {
    if (!item || typeof item.subject_id !== "string" || item.subject_id.length === 0) continue;
    if (typeof item.impression !== "string") continue;
    const cur = db
      .prepare<[string, string], { impression: string | null }>(
        `SELECT impression FROM subject_profiles WHERE owner_agent = ? AND subject_type = 'person' AND subject_id = ?`,
      )
      .get(agentId, item.subject_id);
    if (!cur || (cur.impression ?? "") === item.impression) continue;
    db.prepare(
      `UPDATE subject_profiles SET impression = ?, updated_at = ? WHERE owner_agent = ? AND subject_type = 'person' AND subject_id = ?`,
    ).run(item.impression, now, agentId, item.subject_id);
    auditWrite(db, agentId, "subject_profile", `person:${item.subject_id}`, "update", cur.impression ?? "", item.impression, now);
    imported.push({
      file: "social.yaml",
      field: `acquaintances[${item.subject_id}].impression`,
      from: cur.impression ?? "",
      to: item.impression,
    });
  }
  return imported;
}

/**
 * reconcile（§6.2）：检测实例模板文件与 DB 投影的差异，把可回导的数据字段（mood/energy、
 * knowledge claim、person impression）审计后导入 DB，再重新投影。shadow.yaml 与 memory/**
 * 是单向投影，手工改动在重投影时被覆盖（不落审计，也不冒充导入了）。不做静默覆盖——
 * 只在审计后把手工值转为 DB 值并回写一致快照。
 */
export function reconcile(db: Database.Database, root: string, agentId: string): ReconcileResult {
  assertAgentExists(db, agentId);
  const { identityDir } = agentDirs(root, agentId);
  const projection = computeProjection(db, agentId, identityDir);
  const now = new Date().toISOString();

  const readObject = (name: string): unknown => {
    const p = join(identityDir, name);
    if (!existsSync(p)) return undefined;
    return parseYamlText<unknown>(readFileSync(p, "utf8"), p);
  };

  const expectedTemplates = new Map<string, Record<string, unknown>>();
  for (const [name, text] of projection.templates) {
    expectedTemplates.set(name, parseYamlText<Record<string, unknown>>(text, `projection:${name}`));
  }

  const imported: ReconcileImport[] = [];
  const ignored: Array<{ file: string; field: string; reason: string }> = [];

  imported.push(...reconcileEvolution(db, agentId, readObject("evolution.yaml"), expectedTemplates.get("evolution.yaml") ?? {}, now));
  imported.push(
    ...reconcileClaimsFile(db, agentId, "skills.yaml", "skills", readObject("skills.yaml"), ignored, now),
  );
  imported.push(
    ...reconcileClaimsFile(db, agentId, "specialties.yaml", "specialties", readObject("specialties.yaml"), ignored, now),
  );
  imported.push(...reconcileSocial(db, agentId, readObject("social.yaml"), now));

  // shadow.yaml 是自省流水，单向不可回导：手工改动在重投影时覆盖，仅当确实有差异才报告 ignored。
  const diskShadow = readObject("shadow.yaml");
  if (diskShadow !== undefined && JSON.stringify(diskShadow) !== JSON.stringify(expectedTemplates.get("shadow.yaml"))) {
    ignored.push({ file: "shadow.yaml", field: "self_insights", reason: "reflections are append-only; manual edits are not imported" });
  }

  const reprojected = reproject(db, root, agentId).files;
  return { imported, ignored, reprojected };
}