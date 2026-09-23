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
import { newId } from "../runtime/id.js";
import type { MemoryPolicy } from "../compile/types.js";

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

/** 一条检索候选：episodes 行 + FTS 的 bm25（负值，越负越相关）。 */
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

export class MemoryDao {
  private readonly db: Database.Database;
  private readonly nowReal: () => string;

  constructor(db: Database.Database, opts: { nowReal: () => string }) {
    this.db = db;
    this.nowReal = opts.nowReal;
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
        modelConfigHash: w.modelConfigHash ?? null,
      });
      for (const s of w.subjects) {
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
  searchCandidates(owner: string, query: string, includeFaded: boolean, limit = RETRIEVAL.candidateLimit): EpisodeCandidate[] {
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
    return out.map((r) => ({
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
      bm25: r.bm25 as number,
    }));
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
           tokens_l2, tokens_l1, tokens_transient, tokens_total, clamped,
           rendered_card, card_sha256, real_ts, model_config_hash)
        VALUES (@rid, @ownerAgent, @sceneId, @turn, @triggerMsgId,
                @queryJson, @candidates, @selectedJson,
                @tokensL2, @tokensL1, @tokensTransient, @tokensTotal, @clamped,
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
        tokensTotal: row.tokensTotal,
        clamped: row.clamped,
        renderedCard: row.renderedCard,
        cardSha256: row.cardSha256,
        realTs: this.nowReal(),
        modelConfigHash: row.modelConfigHash ?? null,
      });
  }
}