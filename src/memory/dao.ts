// ═══════════════════════════════════════════════════════════════════════════
// 记忆 DAO（§12.1.4 / §14 / §15）—— 领域库（DB-A）记忆组 + 审计组的唯一写读入口
//
// 分区纪律（§19.4）：每个方法的第一参数或闭包都是 `owner_agent`，SQL 恒带
// `WHERE owner_agent = @owner`。cross-owner 写入在这里被结构性地挡在门外。
//
// 双库规约（§18.6）：本文件只碰 DB-A 的表（episodes / episode_subjects / subject_profiles /
// memory_decisions / retrieval_log），绝不 JOIN、绝不写任何 mesh_ 表（R2 门禁）。衰减只读
// `virtual_hours` 整数列、永不读 `real_ts`（§15.1.3 / J1）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import type { SubjectRef } from "./subject.js";
import { DISTORTION_THRESHOLDS, RETRIEVAL } from "./constants.js";
import { PURPOSE_RETRIEVAL_LIMIT } from "./purpose.js";
import { newId } from "../runtime/id.js";
import type { MemoryPolicy } from "../compile/types.js";
import { modelConfigHashFromJson } from "../compile/fingerprint.js";

/** 一条待写入的情节记忆（与 episodes 列一一对应；subjects 走 episode_subjects）。 */
export interface EpisodeWrite {
  episodeId: string;
  ownerAgent: string;
  kind: string; // 'event' | 'impression' | 'fact' | 'self'
  sceneId?: string | null;
  purposeKind?: string | null;
  sourceMsgId?: string | null;
  sourceSessionId?: string | null;
  sourceEntryId?: string | null;
  gist: string;
  detail?: string | null;
  quote?: string | null;
  emotion?: string | null;
  valence?: number | null;
  arousal?: number | null;
  salience: number;
  confidence: number;
  accuracy?: number | null;
  virtualTs: string;
  virtualHours: number;
  retention: number;
  status?: "active" | "faded" | "consolidated";
  modelConfigHash?: string | null;
  subjects: Array<{ ref: SubjectRef; roleInEpisode?: string; weight?: number }>;
}

/** memory_decisions 的一行（§12.1.4）。 */
export interface MemoryDecision {
  ownerAgent: string;
  sourceMsgId: string;
  path: "P1" | "P2" | "P3";
  score: number;
  writeDecided: boolean;
  written: boolean;
  nudged: boolean;
  componentsJson: string;
  virtualTs: string;
}

/** 一条检索候选：episodes 行 + 后端导出的相关性。`bm25` 是 FTS 原始分（负值，非 FTS 后端为 0）；
 *  `relevance` 是统一相关性（越高越相关），FTS 后端 = -bm25，交给 retrieve 归一。 */
export interface EpisodeCandidate {
  episodeId: string;
  ownerAgent: string;
  kind: string;
  sceneId: string | null;
  purposeKind: string | null;
  gist: string;
  detail: string | null;
  quote: string | null;
  emotion: string | null;
  valence: number | null;
  arousal: number | null;
  salience: number;
  confidence: number;
  virtualTs: string | null;
  virtualHours: number;
  rehearsalCount: number;
  retention: number;
  status: "active" | "faded" | "consolidated";
  bm25: number;
  relevance: number;
}

export interface DecaySweepResult {
  ownerAgent: string;
  nowVirtualHours: number;
  scanned: number;
  newlyFaded: string[];
  quoteDropped: string[];
  detailDropped: string[];
  regressed: string[];
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** episodes 行 + 显式 bm25 → EpisodeCandidate（searchCandidates 与主体候选共用）。
 *  relevance = -bm25（越高越相关）；主体候选/用途候选 bm25=0 → relevance=0。 */
function rowToCandidate(r: Record<string, unknown>, bm25: number): EpisodeCandidate {
  return {
    episodeId: r.episode_id as string,
    ownerAgent: r.owner_agent as string,
    kind: r.kind as string,
    sceneId: (r.scene_id as string | null) ?? null,
    purposeKind: (r.purpose_kind as string | null) ?? null,
    gist: r.gist as string,
    detail: (r.detail as string | null) ?? null,
    quote: (r.quote as string | null) ?? null,
    emotion: (r.emotion as string | null) ?? null,
    valence: (r.valence as number | null) ?? null,
    arousal: (r.arousal as number | null) ?? null,
    salience: r.salience as number,
    confidence: r.confidence as number,
    virtualTs: (r.virtual_ts as string | null) ?? null,
    virtualHours: r.virtual_hours as number,
    rehearsalCount: r.rehearsal_count as number,
    retention: r.retention as number,
    status: r.status as "active" | "faded" | "consolidated",
    bm25,
    relevance: -bm25,
  };
}

export class MemoryDao {
  private readonly db: Database.Database;
  private readonly nowReal: () => string;

  constructor(db: Database.Database, opts: { nowReal: () => string }) {
    this.db = db;
    this.nowReal = opts.nowReal;
  }

  /** 写时刻该 agent 的定稿模型配置哈希（R06 E09）；agent 无 model_config_json 时返回 null。 */
  private configHashFor(owner: string): string | null {
    const row = this.db
      .prepare<[string], { model_config_json: string | null }>(
        `SELECT model_config_json FROM agents WHERE agent_id = ?`,
      )
      .get(owner);
    return modelConfigHashFromJson(row?.model_config_json ?? null);
  }

  /** agent 的实际角色名（agents.role，进打分 authorityWeights 键）；无角色返回 null。 */
  roleOfAgent(agentId: string): string | null {
    const row = this.db
      .prepare<[string], { role: string | null }>(`SELECT role FROM agents WHERE agent_id = ?`)
      .get(agentId);
    return row?.role ?? null;
  }

  // ─── episodes + episode_subjects ──────────────────────────────────────────

  /** 全量写入一条情节（含主体挂载 + 主体画像 episode_count/evidence 累加），单事务。 */
  insertEpisode(w: EpisodeWrite): void {
    const insertEp = this.db.prepare(`
      INSERT INTO episodes (episode_id, owner_agent, kind, scene_id, purpose_kind,
        source_msg_id, source_session_id, source_entry_id, gist, detail, quote,
        emotion, valence, arousal, salience, confidence, accuracy,
        virtual_ts, virtual_hours, real_ts, rehearsal_count, last_recalled_at,
        retention, status, model_config_hash)
      VALUES (@episodeId, @ownerAgent, @kind, @sceneId, @purposeKind,
        @sourceMsgId, @sourceSessionId, @sourceEntryId, @gist, @detail, @quote,
        @emotion, @valence, @arousal, @salience, @confidence, @accuracy,
        @virtualTs, @virtualHours, @realTs, 0, NULL,
        @retention, @status, @modelConfigHash)
    `);
    const insertSubject = this.db.prepare(`
      INSERT OR IGNORE INTO episode_subjects
        (episode_id, subject_type, subject_id, role_in_episode, weight)
      VALUES (@episodeId, @type, @id, @role, @weight)
    `);

    const tx = this.db.transaction(() => {
      insertEp.run({
        episodeId: w.episodeId,
        ownerAgent: w.ownerAgent,
        kind: w.kind,
        sceneId: w.sceneId ?? null,
        purposeKind: w.purposeKind ?? null,
        sourceMsgId: w.sourceMsgId ?? null,
        sourceSessionId: w.sourceSessionId ?? null,
        sourceEntryId: w.sourceEntryId ?? null,
        gist: w.gist,
        detail: w.detail ?? null,
        quote: w.quote ?? null,
        emotion: w.emotion ?? null,
        valence: w.valence ?? null,
        arousal: w.arousal ?? null,
        salience: w.salience,
        confidence: w.confidence,
        accuracy: w.accuracy ?? null,
        virtualTs: w.virtualTs,
        virtualHours: w.virtualHours,
        realTs: this.nowReal(),
        retention: w.retention,
        status: w.status ?? "active",
        modelConfigHash: w.modelConfigHash ?? this.configHashFor(w.ownerAgent),
      });
      // A31：episode_subjects 用 INSERT OR IGNORE，重复 subjectRef 只落一条关系；
      // 画像 episode_count/evidence 必须按 (type,id) 去重后只 bump 一次，
      // 否则同一情节被同一主体重复计入。保留首次出现的 role/weight（与 OR IGNORE 语义一致）。
      const seen = new Set<string>();
      for (const s of w.subjects) {
        const key = `${s.ref.type}:${s.ref.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        insertSubject.run({
          episodeId: w.episodeId,
          type: s.ref.type,
          id: s.ref.id,
          role: s.roleInEpisode ?? null,
          weight: s.weight ?? 1.0,
        });
        this.bumpSubjectProfile(w.ownerAgent, s.ref, s.weight ?? 1.0, w.episodeId);
      }
    });
    tx();
  }

  private getEvidenceJson(owner: string, type: string, id: string): Array<{ episode_id: string; weight: number }> {
    const row = this.db
      .prepare<[string, string, string], { evidence_json: string | null }>(
        `SELECT evidence_json FROM subject_profiles WHERE owner_agent = ? AND subject_type = ? AND subject_id = ?`,
      )
      .get(owner, type, id);
    if (!row?.evidence_json) return [];
    try {
      const parsed = JSON.parse(row.evidence_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private bumpSubjectProfile(owner: string, ref: SubjectRef, weight: number, episodeId: string): void {
    const evidence = this.getEvidenceJson(owner, ref.type, ref.id);
    evidence.push({ episode_id: episodeId, weight });
    this.db
      .prepare(`
        INSERT INTO subject_profiles
          (owner_agent, subject_type, subject_id, episode_count, evidence_json, updated_at)
        VALUES (@owner, @type, @id, 1, @evidence, @now)
        ON CONFLICT (owner_agent, subject_type, subject_id) DO UPDATE SET
          episode_count = episode_count + 1,
          evidence_json = excluded.evidence_json,
          updated_at = excluded.updated_at
      `)
      .run({
        owner,
        type: ref.type,
        id: ref.id,
        evidence: JSON.stringify(evidence),
        now: this.nowReal(),
      });
  }

  /** 最近 N 条 gist（novelty/repetition 比对集；发送方用 ownRecentGists 语义同源）。 */
  recentGists(owner: string, limit: number): string[] {
    return (
      this.db
        .prepare<[string, number], { gist: string }>(
          `SELECT gist FROM episodes WHERE owner_agent = ? ORDER BY real_ts DESC, rowid DESC LIMIT ?`,
        )
        .all(owner, limit) as Array<{ gist: string }>
    ).map((r) => r.gist);
  }

  /** 某主体的画像快照（供 trustOf / closeness / impression）。 */
  profileOf(
    owner: string,
    ref: SubjectRef,
  ): { impression: string | null; valence: number | null; closeness: number | null; trust: number | null } | undefined {
    return this.db
      .prepare<[string, string, string], { impression: string | null; valence: number | null; closeness: number | null; trust: number | null }>(
        `SELECT impression, valence, closeness, trust FROM subject_profiles
         WHERE owner_agent = ? AND subject_type = ? AND subject_id = ?`,
      )
      .get(owner, ref.type, ref.id);
  }

  /** 当前情绪/精力（agent_state，§14.1 瞬时上下文 R23）。缺失回默认，保证字段完整。 */
  currentState(owner: string): { mood: string; moodIntensity: number; energy: number } {
    const get = (key: string): unknown => {
      const row = this.db
        .prepare<[string, string], { value_json: string }>(
          `SELECT value_json FROM agent_state WHERE agent_id = ? AND key = ?`,
        )
        .get(owner, key);
      if (!row) return undefined;
      try {
        return JSON.parse(row.value_json);
      } catch {
        return undefined;
      }
    };
    return {
      mood: typeof get("mood") === "string" ? (get("mood") as string) : "中性",
      moodIntensity: typeof get("mood_intensity") === "number" ? (get("mood_intensity") as number) : 0.5,
      energy: typeof get("energy") === "number" ? (get("energy") as number) : 0.5,
    };
  }

  // ─── episodes 溯源反查 ──────────────────────────────────────────────────

  /**
   * owner 是否已对某条 source_msg_id 写过情节记忆（§12.4：判定 `written` 列时用——
   * `message_consumed` 在 turn_end 触发，`remember` 早于判定行已写 episode，故 written
   * 只能由 episodes 表反向确定，不能查 memory_decisions）。
   */
  hasEpisodeFor(owner: string, sourceMsgId: string): boolean {
    return (
      this.db
        .prepare<[string, string], { n: number }>(
          `SELECT 1 AS n FROM episodes WHERE owner_agent = ? AND source_msg_id = ?`,
        )
        .get(owner, sourceMsgId) !== undefined
    );
  }

  /**
   * 该 source_msg_id 是否已被某次 pre_compaction 提炼消化（§15.4 H2 / A23）。
   * 与 hasEpisodeFor 互补：压缩提炼常把多条原文合并成少量「自我洞察」情节，
   * episodes.source_msg_id 是单列、点不出完整范围，故来源消化单独记台账。harvest 去重
   * 用「两者皆无」才判未消化，否则一次成功提炼后重复 compaction 会再落一遍情节。
   */
  hasDistilledSource(owner: string, sourceMsgId: string): boolean {
    return (
      this.db
        .prepare<[string, string], { n: number }>(
          `SELECT 1 AS n FROM compact_distilled WHERE owner_agent = ? AND source_msg_id = ?`,
        )
        .get(owner, sourceMsgId) !== undefined
    );
  }

  /** 一次成功提炼后，把该批次的全部来源消息记为已消化（幂等 by (owner, source_msg_id)）。 */
  markDistilledSources(owner: string, sourceMsgIds: readonly string[], reflectionId: string): void {
    if (sourceMsgIds.length === 0) return;
    const upsert = this.db.prepare(`
      INSERT OR IGNORE INTO compact_distilled (owner_agent, source_msg_id, reflection_id, distilled_at)
      VALUES (?, ?, ?, ?)
    `);
    const at = this.nowReal();
    const tx = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) upsert.run(owner, id, reflectionId, at);
    });
    tx(sourceMsgIds);
  }

  // ─── memory_decisions（幂等键 + B 模式工作队列）──────────────────────────

  hasDecision(owner: string, sourceMsgId: string): boolean {
    return (
      this.db
        .prepare<[string, string], { n: number }>(
          `SELECT 1 AS n FROM memory_decisions WHERE owner_agent = ? AND source_msg_id = ?`,
        )
        .get(owner, sourceMsgId) !== undefined
    );
  }

  /** 写判定行。幂等：已存在则不动（§12.1.4 唯一索引）。`written` 由 remember 单独翻转。 */
  insertDecision(d: MemoryDecision): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO memory_decisions
          (owner_agent, source_msg_id, path, score, write_decided, written, nudged,
           components_json, virtual_ts, decided_at)
        VALUES (@ownerAgent, @sourceMsgId, @path, @score, @writeDecided, @written, @nudged,
                @componentsJson, @virtualTs, @decidedAt)
      `)
      .run({
        ownerAgent: d.ownerAgent,
        sourceMsgId: d.sourceMsgId,
        path: d.path,
        score: d.score,
        writeDecided: d.writeDecided ? 1 : 0,
        written: d.written ? 1 : 0,
        nudged: d.nudged ? 1 : 0,
        componentsJson: d.componentsJson,
        virtualTs: d.virtualTs,
        decidedAt: this.nowReal(),
      });
  }

  markWritten(owner: string, sourceMsgId: string): void {
    this.db
      .prepare(`UPDATE memory_decisions SET written = 1 WHERE owner_agent = ? AND source_msg_id = ?`)
      .run(owner, sourceMsgId);
  }

  markNudged(owner: string, sourceMsgId: string): void {
    this.db
      .prepare(`UPDATE memory_decisions SET nudged = 1 WHERE owner_agent = ? AND source_msg_id = ?`)
      .run(owner, sourceMsgId);
  }

  /** B 模式待补写队列（write_decided=1 AND written=0），供兜底 nudge 扫描。 */
  pendingNudges(owner: string): Array<{ sourceMsgId: string; nudged: boolean; score: number }> {
    const rows = this.db
      .prepare<[string], { source_msg_id: string; nudged: number; score: number }>(
        `SELECT source_msg_id, nudged, score FROM memory_decisions
         WHERE owner_agent = ? AND write_decided = 1 AND written = 0
         ORDER BY score DESC`,
      )
      .all(owner);
    return rows.map((r) => ({ sourceMsgId: r.source_msg_id, nudged: r.nudged !== 0, score: r.score }));
  }

  // ─── 检索候选 ─────────────────────────────────────────────────────────────

  /**
   * FTS5 + trigram 候选（§14.2.3）。MATCH 用双引号短语，内部引号转义；
   * bm25 为负值。默认只召回 `active`；`includeFaded` 打开时把 faded/consolidated
   * 一并纳入（强线索通路，§14.2.4），最终分数再乘 penalty。
   */
  searchCandidates(owner: string, query: string, includeFaded: boolean, limit: number = RETRIEVAL.candidateLimit): EpisodeCandidate[] {
    const phrase = `"${query.replace(/"/g, '""')}"`;
    // statusClause 只由布尔参数控制取值（字符串常量内联，不受查询文本影响），无注入面。
    const statusClause = includeFaded ? "(e.status = 'active' OR e.status = 'faded' OR e.status = 'consolidated')" : "e.status = 'active'";
    const stmt = this.db.prepare(
      `SELECT e.episode_id, e.owner_agent, e.kind, e.scene_id, e.purpose_kind,
              e.gist, e.detail, e.quote, e.emotion, e.valence, e.arousal,
              e.salience, e.confidence, e.virtual_ts, e.virtual_hours, e.rehearsal_count,
              e.retention, e.status, bm25(episodes_fts) AS bm25
         FROM episodes_fts f JOIN episodes e ON e.rowid = f.rowid
        WHERE episodes_fts MATCH ?
          AND e.owner_agent = ?
          AND ${statusClause}
        ORDER BY bm25
        LIMIT ?`,
    );
    const out = stmt.all(phrase, owner, limit) as unknown as Array<Record<string, unknown>>;
    return out.map((r) => rowToCandidate(r, r.bm25 as number));
  }

  /**
   * 主体候选（A29）：episode_subjects 命中任一在场主体的情节，作为 FTS 文本候选的补充。
   *
   * 整条自然语言消息被 FTS 当精确短语匹配时，同一人物/场所而措辞不同的旧 gist 不会命中，
   * 之后的主体排序「无可排序」——但主体标签在 episode_subjects 里可索引，据此把相关情节捞回候选。
   * 这不是换成向量检索：仍走关系表 + 二分键，只是把召回面从「文本逐字」扩到「主体相同」。
   * self 主体是 owner 自洞察的兜底标签、范围过宽，不参与本候选通道（会每轮捞回全部 self 情节）。
   * bm25 记 0（中性）、最终排序主要靠 subjectMatch（§14.2.1 权重 0.20）。
   */
  searchCandidatesBySubjects(
    owner: string,
    subjects: readonly SubjectRef[],
    includeFaded: boolean,
    limit = RETRIEVAL.candidateLimit,
  ): EpisodeCandidate[] {
    const parsed = subjects.filter((s) => s.type !== "self");
    if (parsed.length === 0) return [];
    const statusClause = includeFaded
      ? "(e.status = 'active' OR e.status = 'faded' OR e.status = 'consolidated')"
      : "e.status = 'active'";
    const matchClause = parsed.map(() => `(es.subject_type = ? AND es.subject_id = ?)`).join(" OR ");
    const args: string[] = [];
    for (const s of parsed) args.push(s.type, s.id);
    const stmt = this.db.prepare(
      `SELECT e.episode_id, e.owner_agent, e.kind, e.scene_id, e.purpose_kind,
              e.gist, e.detail, e.quote, e.emotion, e.valence, e.arousal,
              e.salience, e.confidence, e.virtual_ts, e.virtual_hours, e.rehearsal_count,
              e.retention, e.status
         FROM episodes e
        WHERE e.owner_agent = ?
          AND ${statusClause}
          AND EXISTS (SELECT 1 FROM episode_subjects es
                       WHERE es.episode_id = e.episode_id AND (${matchClause}))
        ORDER BY e.retention DESC, e.virtual_hours DESC
        LIMIT ?`,
    );
    const rows = stmt.all(owner, ...args, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => rowToCandidate(r, 0));
  }

  /** 一批 episode 的主体集合（subjectMatch 用）。 */
  subjectsOf(owner: string, episodeIds: string[]): Map<string, SubjectRef[]> {
    if (episodeIds.length === 0) return new Map();
    const placeholders = episodeIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT episode_id, subject_type, subject_id FROM episode_subjects
         WHERE episode_id IN (${placeholders}) AND EXISTS (SELECT 1 FROM episodes e
           WHERE e.episode_id = episode_subjects.episode_id AND e.owner_agent = ?)`,
      )
      .all(...episodeIds, owner) as Array<{ episode_id: string; subject_type: string; subject_id: string }>;
    const map = new Map<string, SubjectRef[]>();
    for (const r of rows) {
      const list = map.get(r.episode_id) ?? [];
      list.push({ type: r.subject_type as SubjectRef["type"], id: r.subject_id });
      map.set(r.episode_id, list);
    }
    return map;
  }

  // ─── 用途（purpose_kind）检索与重复检测（§17.6）────────────────────────────

  /**
   * 最近 N 条某用途情节的 knowledge 主体 id（按情节分组、时间倒序）。
   * 教学进度重复检测用：把本情节的 knowledge 主体与每条的 knowledge 主体求交，
   * 命中条数即「已重复 N 次」（不承诺模型绝不重复，只呈现事实）。
   */
  recentPurposeKnowledgeSubjects(
    owner: string,
    purposeKind: string,
    limit: number,
  ): Array<{ episodeId: string; knowledgeIds: string[] }> {
    const eps = this.db
      .prepare<[string, string, number], { episode_id: string }>(
        `SELECT episode_id FROM episodes
         WHERE owner_agent = ? AND purpose_kind = ?
         ORDER BY virtual_hours DESC, rowid DESC
         LIMIT ?`,
      )
      .all(owner, purposeKind, limit);
    const map = new Map<string, string[]>();
    for (const e of eps) map.set(e.episode_id, []);
    if (map.size === 0) return [];
    const episodeIds = [...map.keys()];
    const placeholders = episodeIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT es.episode_id, es.subject_id FROM episode_subjects es
         WHERE es.episode_id IN (${placeholders})
           AND es.subject_type = 'knowledge'
           AND EXISTS (SELECT 1 FROM episodes e
             WHERE e.episode_id = es.episode_id AND e.owner_agent = ?)`,
      )
      .all(...episodeIds, owner) as Array<{ episode_id: string; subject_id: string }>;
    for (const r of rows) map.get(r.episode_id)?.push(r.subject_id);
    // 保持时间倒序（episodes 子查询顺序），返回 knowledge 主体按 id 升序去重。
    return eps
      .map((e) => ({ episodeId: e.episode_id, knowledgeIds: [...(map.get(e.episode_id) ?? [])].sort() }))
      .filter((g) => g.knowledgeIds.length > 0);
  }

  /**
   * 某用途最近 N 条 active/consolidated 情节，可选按 curriculum 主体过滤（§17.6：
   * 场景开场注入教学进度用，status IN active/consolidated、curriculum 过滤、LIMIT 3）。
   * bm25 记 0（中性）；本题不走 FTS 全文、按虚拟时间倒序取最近的进度里程碑。
   */
  recentByPurpose(
    owner: string,
    purposeKind: string,
    opts: { curriculumId?: string; limit?: number } = {},
  ): EpisodeCandidate[] {
    const limit = opts.limit ?? PURPOSE_RETRIEVAL_LIMIT;
    const where = [
      "e.owner_agent = ?",
      "e.purpose_kind = ?",
      "(e.status = 'active' OR e.status = 'consolidated')",
    ];
    const args: unknown[] = [owner, purposeKind];
    if (opts.curriculumId !== undefined && opts.curriculumId !== "") {
      where.push(
        `EXISTS (SELECT 1 FROM episode_subjects cs
          WHERE cs.episode_id = e.episode_id AND cs.subject_type = 'curriculum' AND cs.subject_id = ?)`,
      );
      args.push(opts.curriculumId);
    }
    const stmt = this.db.prepare(
      `SELECT e.episode_id, e.owner_agent, e.kind, e.scene_id, e.purpose_kind,
              e.gist, e.detail, e.quote, e.emotion, e.valence, e.arousal,
              e.salience, e.confidence, e.virtual_ts, e.virtual_hours, e.rehearsal_count,
              e.retention, e.status
         FROM episodes e
        WHERE ${where.join(" AND ")}
        ORDER BY e.virtual_hours DESC, e.rowid DESC
        LIMIT ?`,
    );
    args.push(limit);
    const rows = stmt.all(...args) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => rowToCandidate(r, 0));
  }

  // ─── 衰减（§15.1）────────────────────────────────────────────────────────

  /**
   * 批量衰减。J1 整段算（从 virtual_hours 到 nowVirtualHours）；J2 retention 导出量；
   * J4 虚拟时间倒流时跳过并记 regressed。分两步（先重算，再按新值转 faded），
   * 与 §15.1.3 的 SQL 两段式语义一致，但用 JS 环路保持对（旧→新）阈值的可观测。
   */
  decaySweep(owner: string, nowVirtualHours: number, p: MemoryPolicy): DecaySweepResult {
    const rows = this.db
      .prepare<[string], { episode_id: string; salience: number; virtual_hours: number; rehearsal_count: number; arousal: number | null; valence: number | null; retention: number }>(
        `SELECT episode_id, salience, virtual_hours, rehearsal_count, arousal, valence, retention
         FROM episodes WHERE owner_agent = ? AND status = 'active'`,
      )
      .all(owner) as Array<{ episode_id: string; salience: number; virtual_hours: number; rehearsal_count: number; arousal: number | null; valence: number | null; retention: number }>;

    const updateRetention = this.db.prepare(`UPDATE episodes SET retention = @r WHERE owner_agent = @o AND episode_id = @id`);
    const fadeOne = this.db.prepare(`UPDATE episodes SET status = 'faded' WHERE owner_agent = @o AND episode_id = @id`);
    const result: DecaySweepResult = {
      ownerAgent: owner,
      nowVirtualHours,
      scanned: rows.length,
      newlyFaded: [],
      quoteDropped: [],
      detailDropped: [],
      regressed: [],
    };

    const tx = this.db.transaction(() => {
      for (const row of rows) {
        if (row.virtual_hours > nowVirtualHours) {
          result.regressed.push(row.episode_id);
          continue; // J4：虚拟时间倒流，本轮跳过
        }
        const dt = nowVirtualHours - row.virtual_hours;
        const negative = (row.valence ?? 0) < 0 ? 1 : 0;
        const tau =
          p.tau0Hours *
          (1 + 0.5 * row.rehearsal_count) *
          (1 + (row.arousal ?? 0)) *
          (1 + p.negativeBias * negative);
        const next = clamp01(row.salience * Math.exp(-dt / tau));
        const old = row.retention;
        if (Math.abs(next - old) > 1e-9) {
          updateRetention.run({ r: next, o: owner, id: row.episode_id });
        }
        if (next < DISTORTION_THRESHOLDS.fade) {
          if (old >= DISTORTION_THRESHOLDS.fade) result.newlyFaded.push(row.episode_id);
          fadeOne.run({ o: owner, id: row.episode_id });
        }
        if (old >= DISTORTION_THRESHOLDS.quote && next < DISTORTION_THRESHOLDS.quote) {
          result.quoteDropped.push(row.episode_id);
        }
        if (old >= DISTORTION_THRESHOLDS.detail && next < DISTORTION_THRESHOLDS.detail) {
          result.detailDropped.push(row.episode_id);
        }
      }
    });
    tx();
    return result;
  }

  // ─── 复述强化（§14.4 / §15.2）────────────────────────────────────────────

  /**
   * 常规复述强化：rehearsal_count+1、retention+boost（封顶 1.0）、last_recalled_at。
   * 然后独立的复活语句：`faded 且 retention >= fade` → `active`（§14.4.1 两条语句）。
   */
  reinforce(owner: string, episodeIds: string[], boost = RETRIEVAL.regularBoost): void {
    if (episodeIds.length === 0) return;
    const placeholders = episodeIds.map(() => "?").join(",");
    const args = [owner, ...episodeIds] as unknown[];
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`
          UPDATE episodes SET
            rehearsal_count = rehearsal_count + 1,
            retention = MIN(1.0, retention + ?),
            last_recalled_at = ?
          WHERE owner_agent = ? AND episode_id IN (${placeholders})
        `)
        .run(boost, this.nowReal(), ...args);
      this.db
        .prepare(`
          UPDATE episodes SET status = 'active'
          WHERE owner_agent = ? AND episode_id IN (${placeholders})
            AND status = 'faded' AND retention >= ?
        `)
        .run(owner, ...episodeIds, DISTORTION_THRESHOLDS.fade);
    });
    tx();
  }

  /** 强线索唤起 faded 记忆（§15.2）：+0.15、status 回 active、rehearsal+1。 */
  reviveStrongCue(owner: string, episodeIds: string[]): void {
    if (episodeIds.length === 0) return;
    const placeholders = episodeIds.map(() => "?").join(",");
    this.db
      .prepare(`
        UPDATE episodes SET
          retention = MIN(1.0, retention + ?),
          status = 'active',
          rehearsal_count = rehearsal_count + 1,
          last_recalled_at = ?
        WHERE owner_agent = ? AND episode_id IN (${placeholders}) AND status = 'faded'
      `)
      .run(RETRIEVAL.strongCueBoost, this.nowReal(), owner, ...episodeIds);
  }

  // ─── retrieval_log（审计 + 同轮幂等键）───────────────────────────────────

  hasRetrievalFor(owner: string, triggerMsgId: string): boolean {
    return (
      this.db
        .prepare<[string, string], { n: number }>(
          `SELECT 1 AS n FROM retrieval_log WHERE owner_agent = ? AND trigger_msg_id = ?`,
        )
        .get(owner, triggerMsgId) !== undefined
    );
  }

  insertRetrievalLog(row: {
    ownerAgent: string;
    sceneId?: string | null;
    turn?: number | null;
    triggerMsgId?: string | null;
    queryJson: string;
    candidates: number;
    selectedJson: string;
    tokensL2: number;
    tokensL1: number;
    tokensTransient: number;
    tokensPurpose: number;
    tokensTotal: number;
    clamped: number;
    renderedCard: string;
    cardSha256: string;
    modelConfigHash?: string | null;
  }): void {
    this.db
      .prepare(`
        INSERT INTO retrieval_log
          (retrieval_id, owner_agent, scene_id, turn, trigger_msg_id,
           query_json, candidates, selected_json,
           tokens_l2, tokens_l1, tokens_transient, tokens_purpose, tokens_total, clamped,
           rendered_card, card_sha256, real_ts, model_config_hash)
        VALUES (@rid, @ownerAgent, @sceneId, @turn, @triggerMsgId,
                @queryJson, @candidates, @selectedJson,
                @tokensL2, @tokensL1, @tokensTransient, @tokensPurpose, @tokensTotal, @clamped,
                @renderedCard, @cardSha256, @realTs, @modelConfigHash)
      `)
      .run({
        rid: newId("rl"),
        ownerAgent: row.ownerAgent,
        sceneId: row.sceneId ?? null,
        turn: row.turn ?? null,
        triggerMsgId: row.triggerMsgId ?? null,
        queryJson: row.queryJson,
        candidates: row.candidates,
        selectedJson: row.selectedJson,
        tokensL2: row.tokensL2,
        tokensL1: row.tokensL1,
        tokensTransient: row.tokensTransient,
        tokensPurpose: row.tokensPurpose,
        tokensTotal: row.tokensTotal,
        clamped: row.clamped,
        renderedCard: row.renderedCard,
        cardSha256: row.cardSha256,
        realTs: this.nowReal(),
        modelConfigHash: row.modelConfigHash ?? this.configHashFor(row.ownerAgent),
      });
  }
}