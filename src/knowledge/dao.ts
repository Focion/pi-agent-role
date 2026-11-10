// ═══════════════════════════════════════════════════════════════════════════
// 知识 DAO（§17 / §18.4.2）—— knowledge_items / knowledge_events 的唯一写读入口
//
// 与 mesh 边界：**mesh 完全不参与**。本文件只碰 DB-A 的 knowledge_items /
// knowledge_events（+ episodes 的归属反查 + state_writes 审计）。分区纪律与
// MemoryDao/ReflectionDao 一致：每个方法首参 owner_agent，SQL 恒带
// `WHERE owner_agent = @owner`.
//
// 分层纪律：不 import @pi/agent-mesh（R1）、不出现 mesh_ 表名（R2）、不出现环境字段
// `ext` 的点访问（R3）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import { newId } from "../runtime/id.js";
import { KNOWLEDGE_DECAY, MASTERY_FACTOR, type EvidenceKind, type LearningQueueItem, type Mastery } from "./types.js";
import { modelConfigHashFromJson } from "../compile/fingerprint.js";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** knowledge_items 一行（反查快照 + 测试观察）。 */
export interface KnowledgeItemRow {
  knId: string;
  ownerAgent: string;
  topic: string;
  claim: string;
  mastery: Mastery;
  confidence: number;
  retention: number;
  practiceCount: number;
  lastPracticedAt: string | null;
  lastPracticedVhours: number;
  isMisconception: 0 | 1;
  wrongBelief: string | null;
  taughtBy: string | null;
  sourceKind: string | null;
  sourceMsgId: string | null;
  firstSeenAt: string;
  /** fading 由哪个掌握度降来（A14 恢复晋级上限；非 fading 时为 null）。 */
  decayFrom: Mastery | null;
  /** 上一轮衰减节拍的虚拟小时（A32 幂等基线）；从未衰减为 null。 */
  lastDecayVhours: number | null;
}

/** 一条知识事件的写入载荷。 */
export interface KnowledgeEventWrite {
  evId: string;
  knId: string;
  owner: string;
  from: Mastery | null;
  to: Mastery;
  kind: EvidenceKind;
  evidence: string | null;
  episodeId: string | null;
  virtualTs: string | null;
  virtualHours: number;
}

/** 一次迁移的原子写入载荷（item 的 insert/update + 0–2 条事件）。 */
export interface KnowledgeChange {
  owner: string;
  knId: string;
  topic: string;
  claim: string;
  isNew: boolean;
  mastery: Mastery;
  confidence: number;
  practiceCount: number;
  lastPracticedVhours: number;
  lastPracticedAt: string | null;
  retention: number;
  isMisconception: 0 | 1;
  wrongBelief: string | null;
  taughtBy: string;
  sourceKind: string;
  firstSeenAt: string;
  events: KnowledgeEventWrite[];
}

export interface KnowledgeDecayResult {
  owner: string;
  nowVirtualHours: number;
  scanned: number;
  newlyFading: string[];
  newlyForgotten: string[];
}

export class KnowledgeDao {
  readonly db: Database.Database;
  private readonly nowReal: () => string;

  constructor(db: Database.Database, opts: { nowReal: () => string }) {
    this.db = db;
    this.nowReal = opts.nowReal;
  }

  /** 写时刻该 agent 的定稿模型配置哈希（R06 E09）；无 model_config_json 返回 null。 */
  private configHashFor(owner: string): string | null {
    const row = this.db
      .prepare<[string], { model_config_json: string | null }>(
        `SELECT model_config_json FROM agents WHERE agent_id = ?`,
      )
      .get(owner);
    return modelConfigHashFromJson(row?.model_config_json ?? null);
  }

  // ─── 读 ────────────────────────────────────────────────────────────────────

  item(owner: string, topic: string): KnowledgeItemRow | undefined {
    const r = this.db
      .prepare<[string, string], Record<string, unknown>>(
        `SELECT kn_id, owner_agent, topic, claim, mastery, confidence, retention,
                practice_count, last_practiced_at, last_practiced_vhours,
                is_misconception, wrong_belief, taught_by, source_kind, source_msg_id,
                first_seen_at, decay_from, last_decay_vhours
           FROM knowledge_items WHERE owner_agent = ? AND topic = ?`,
      )
      .get(owner, topic);
    if (!r) return undefined;
    return {
      knId: r.kn_id as string,
      ownerAgent: r.owner_agent as string,
      topic: r.topic as string,
      claim: r.claim as string,
      mastery: r.mastery as Mastery,
      confidence: r.confidence as number,
      retention: r.retention as number,
      practiceCount: r.practice_count as number,
      lastPracticedAt: (r.last_practiced_at as string | null) ?? null,
      lastPracticedVhours: r.last_practiced_vhours as number,
      isMisconception: (r.is_misconception as number) === 1 ? 1 : 0,
      wrongBelief: (r.wrong_belief as string | null) ?? null,
      taughtBy: (r.taught_by as string | null) ?? null,
      sourceKind: (r.source_kind as string | null) ?? null,
      sourceMsgId: (r.source_msg_id as string | null) ?? null,
      firstSeenAt: r.first_seen_at as string,
      decayFrom: (r.decay_from as Mastery | null) ?? null,
      lastDecayVhours: (r.last_decay_vhours as number | null) ?? null,
    };
  }

  /** owner 全量知识点（供 knowledgeSummary + 测试观察）。 */
  listItems(owner: string): KnowledgeItemRow[] {
    const rows = this.db
      .prepare<[string], Record<string, unknown>>(
        `SELECT kn_id, owner_agent, topic, claim, mastery, confidence, retention,
                practice_count, last_practiced_at, last_practiced_vhours,
                is_misconception, wrong_belief, taught_by, source_kind, source_msg_id,
                first_seen_at, decay_from, last_decay_vhours
           FROM knowledge_items WHERE owner_agent = ? ORDER BY last_practiced_vhours DESC`,
      )
      .all(owner);
    return rows.map((r) => ({
      knId: r.kn_id as string,
      ownerAgent: r.owner_agent as string,
      topic: r.topic as string,
      claim: r.claim as string,
      mastery: r.mastery as Mastery,
      confidence: r.confidence as number,
      retention: r.retention as number,
      practiceCount: r.practice_count as number,
      lastPracticedAt: (r.last_practiced_at as string | null) ?? null,
      lastPracticedVhours: r.last_practiced_vhours as number,
      isMisconception: (r.is_misconception as number) === 1 ? 1 : 0,
      wrongBelief: (r.wrong_belief as string | null) ?? null,
      taughtBy: (r.taught_by as string | null) ?? null,
      sourceKind: (r.source_kind as string | null) ?? null,
      sourceMsgId: (r.source_msg_id as string | null) ?? null,
      firstSeenAt: r.first_seen_at as string,
      decayFrom: (r.decay_from as Mastery | null) ?? null,
      lastDecayVhours: (r.last_decay_vhours as number | null) ?? null,
    }));
  }

  /** episode 是否存在（区分 EVIDENCE_NOT_FOUND 与 EVIDENCE_NOT_OWNED，§17.2）。 */
  episodeExists(episodeId: string): boolean {
    if (!episodeId) return false;
    return this.db.prepare<[string], { n: number }>(`SELECT 1 AS n FROM episodes WHERE episode_id = ?`).get(episodeId) !== undefined;
  }

  /** episode 是否属于 owner（§17.2 EVIDENCE_NOT_OWNED 判定）。 */
  episodeOwnedBy(owner: string, episodeId: string): boolean {
    if (!episodeId) return false;
    return (
      this.db
        .prepare<[string, string], { n: number }>(
          `SELECT 1 AS n FROM episodes WHERE episode_id = ? AND owner_agent = ?`,
        )
        .get(episodeId, owner) !== undefined
    );
  }

  /**
   * T4 mastered 门槛：现存 solved 事件的条数 + 出现的虚拟日集合（§17.2）。
   * 虚拟日键取 `virtual_hours / 24` 整数除法；service 在此之上叠加「本提议这条」再判 ≥2 / ≥2。
   */
  solvedEvidence(owner: string, knId: string): { count: number; days: number[] } {
    const count = this.db
      .prepare<[string, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM knowledge_events
          WHERE owner_agent = ? AND kn_id = ? AND evidence_kind = 'solved'`,
      )
      .get(owner, knId)?.n ?? 0;
    const days = (
      this.db
        .prepare<[string, string], { d: number }>(
          `SELECT DISTINCT (virtual_hours / 24) AS d FROM knowledge_events
            WHERE owner_agent = ? AND kn_id = ? AND evidence_kind = 'solved'`,
        )
        .all(owner, knId) as Array<{ d: number }>
    ).map((r) => r.d);
    return { count, days };
  }

  // ─── 写 ────────────────────────────────────────────────────────────────────

  /** 原子写一次迁移：item 的 insert/update + 事件，单事务（§13.4.3 ⑥）。 */
  applyChange(c: KnowledgeChange): void {
    const modelConfigHash = c.isNew ? this.configHashFor(c.owner) : null;
    const tx = this.db.transaction(() => {
      if (c.isNew) {
        this.db
          .prepare(`
            INSERT INTO knowledge_items
              (kn_id, owner_agent, topic, claim, mastery, confidence, retention,
               practice_count, last_practiced_at, last_practiced_vhours,
               is_misconception, wrong_belief, taught_by, source_kind, source_msg_id,
               first_seen_at, updated_at, model_config_hash)
            VALUES (@knId, @owner, @topic, @claim, @mastery, @confidence, @retention,
                    @practiceCount, @lastPracticedAt, @lastPracticedVhours,
                    @isMisconception, @wrongBelief, @taughtBy, @sourceKind, NULL,
                    @firstSeenAt, @updatedAt, @modelConfigHash)
          `)
          .run({
            knId: c.knId,
            owner: c.owner,
            topic: c.topic,
            claim: c.claim,
            mastery: c.mastery,
            confidence: c.confidence,
            retention: c.retention,
            practiceCount: c.practiceCount,
            lastPracticedAt: c.lastPracticedAt,
            lastPracticedVhours: c.lastPracticedVhours,
            isMisconception: c.isMisconception,
            wrongBelief: c.wrongBelief,
            taughtBy: c.taughtBy,
            sourceKind: c.sourceKind,
            firstSeenAt: c.firstSeenAt,
            updatedAt: this.nowReal(),
            modelConfigHash,
          });
      } else {
        this.db
          .prepare(`
            UPDATE knowledge_items
               SET claim = @claim, mastery = @mastery, confidence = @confidence,
                   retention = @retention, practice_count = @practiceCount,
                   last_practiced_at = @lastPracticedAt, last_practiced_vhours = @lastPracticedVhours,
                   is_misconception = @isMisconception, wrong_belief = @wrongBelief,
                   taught_by = @taughtBy, updated_at = @updatedAt,
                   decay_from = NULL
             WHERE kn_id = @knId AND owner_agent = @owner
          `)
          .run({
            knId: c.knId,
            owner: c.owner,
            claim: c.claim,
            mastery: c.mastery,
            confidence: c.confidence,
            retention: c.retention,
            practiceCount: c.practiceCount,
            lastPracticedAt: c.lastPracticedAt,
            lastPracticedVhours: c.lastPracticedVhours,
            isMisconception: c.isMisconception,
            wrongBelief: c.wrongBelief,
            taughtBy: c.taughtBy,
            updatedAt: this.nowReal(),
          });
      }

      const insEvent = this.db.prepare(`
        INSERT INTO knowledge_events
          (ev_id, kn_id, owner_agent, from_mastery, to_mastery, evidence_kind,
           evidence, episode_id, virtual_ts, virtual_hours, created_at)
        VALUES (@evId, @knId, @owner, @from, @to, @kind, @evidence, @episodeId,
                @virtualTs, @virtualHours, @createdAt)
      `);
      for (const e of c.events) {
        insEvent.run({
          evId: e.evId,
          knId: e.knId,
          owner: e.owner,
          from: e.from,
          to: e.to,
          kind: e.kind,
          evidence: e.evidence,
          episodeId: e.episodeId,
          virtualTs: e.virtualTs,
          virtualHours: e.virtualHours,
          createdAt: this.nowReal(),
        });
      }
    });
    tx();
  }

  /** 模板种入（§17.4 来源 1）：source_kind='template_seed'，幂等跳过已存在。 */
  seedItem(row: {
    owner: string;
    topic: string;
    claim: string;
    mastery: Mastery;
    wrongBelief?: string | null;
    isMisconception?: boolean;
    sourceMsgId?: string | null;
    firstSeenAt: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO knowledge_items
          (kn_id, owner_agent, topic, claim, mastery, confidence, retention,
           practice_count, last_practiced_at, last_practiced_vhours,
           is_misconception, wrong_belief, taught_by, source_kind, source_msg_id,
           first_seen_at, updated_at, model_config_hash)
        VALUES (@knId, @owner, @topic, @claim, @mastery, 0.5, 1.0,
                0, NULL, 0,
                @isMisconception, @wrongBelief, 'self', 'template_seed', @sourceMsgId,
                @firstSeenAt, @updatedAt, @modelConfigHash)
        ON CONFLICT (owner_agent, topic) DO NOTHING
      `)
      .run({
        knId: newId("kn"),
        owner: row.owner,
        topic: row.topic,
        claim: row.claim,
        mastery: row.mastery,
        modelConfigHash: this.configHashFor(row.owner),
        isMisconception: row.isMisconception ? 1 : 0,
        wrongBelief: row.wrongBelief ?? null,
        sourceMsgId: row.sourceMsgId ?? null,
        firstSeenAt: row.firstSeenAt,
        updatedAt: this.nowReal(),
      });
  }

  // ─── 衰减（§17.5.1，三段式）───────────────────────────────────────────────

  /**
   * 知识衰减：T7（retention<0.35 → fading）+ T8（fading 且 <0.10 → forgotten）。
   * 与 §17.5 的三段 SQL 语义一致，用 JS 环路保持对「旧→新阈值」的可观测；每条降级
   * 各写一条 evidence_kind='decay' 事件。mastery=forgotten 的行不再参与。
   *
   * A32 幂等：`last_decay_vhours` 已到当前虚拟小时的行跳过，不重算——否则同一 now 连扫两次
   * 会用「当前(fading)」的较小 factor 把刚 fading 的行再压低到 forgotten，遗忘结果取决于
   * 扫描次数。A14：T7 转 fading 时把衰减前状态记进 `decay_from`，供自省恢复时封顶晋级。
   */
  decay(owner: string, nowVirtualHours: number, tau0Hours: number): KnowledgeDecayResult {
    const rows = this.db
      .prepare<[string], { kn_id: string; mastery: Mastery; retention: number; practice_count: number; last_practiced_vhours: number; decay_from: Mastery | null; last_decay_vhours: number | null }>(
        `SELECT kn_id, mastery, retention, practice_count, last_practiced_vhours, decay_from, last_decay_vhours
           FROM knowledge_items WHERE owner_agent = ? AND mastery <> 'forgotten'`,
      )
      .all(owner);

    const upd = this.db.prepare(
      `UPDATE knowledge_items
          SET mastery = @m, retention = @r, decay_from = @df, last_decay_vhours = @dvh, updated_at = @now
        WHERE owner_agent = @o AND kn_id = @id`,
    );
    const insEvent = this.db.prepare(`
      INSERT INTO knowledge_events
        (ev_id, kn_id, owner_agent, from_mastery, to_mastery, evidence_kind, evidence,
         episode_id, virtual_ts, virtual_hours, created_at)
      VALUES (@evId, @knId, @owner, @from, @to, 'decay', NULL, NULL, NULL, @vh, @now)
    `);

    const result: KnowledgeDecayResult = {
      owner,
      nowVirtualHours,
      scanned: rows.length,
      newlyFading: [],
      newlyForgotten: [],
    };

    const tx = this.db.transaction(() => {
      for (const row of rows) {
        // A32：此节拍已扫过（含更晚节拍）→ 幂等跳过，不再换小 factor 重算。
        if (row.last_decay_vhours !== null && row.last_decay_vhours >= nowVirtualHours) continue;

        const dt = Math.max(0, nowVirtualHours - row.last_practiced_vhours);
        const tau =
          tau0Hours *
          (1 + KNOWLEDGE_DECAY.useCountFactor * row.practice_count) *
          MASTERY_FACTOR[row.mastery];
        const retention = clamp01(Math.exp(-dt / tau));

        let mastery = row.mastery;
        let decayFrom = row.decay_from ?? null;
        // T7：understood/applied/mastered 跌破 fade 阈值 → fading；记录衰减前状态（A14）。
        if ((mastery === "understood" || mastery === "applied" || mastery === "mastered") && retention < KNOWLEDGE_DECAY.fade) {
          insEvent.run({
            evId: newId("ke"),
            knId: row.kn_id,
            owner,
            from: mastery,
            to: "fading",
            vh: nowVirtualHours,
            now: this.nowReal(),
          });
          result.newlyFading.push(row.kn_id);
          decayFrom = mastery;
          mastery = "fading";
        }
        // T8：fading（含本轮刚转的）跌破 forget 阈值 → forgotten（decay_from 不再需要）。
        if (mastery === "fading" && retention < KNOWLEDGE_DECAY.forget) {
          insEvent.run({
            evId: newId("ke"),
            knId: row.kn_id,
            owner,
            from: "fading",
            to: "forgotten",
            vh: nowVirtualHours,
            now: this.nowReal(),
          });
          result.newlyForgotten.push(row.kn_id);
          decayFrom = null;
          mastery = "forgotten";
        }

        upd.run({
          m: mastery,
          r: retention,
          df: decayFrom,
          dvh: nowVirtualHours,
          o: owner,
          id: row.kn_id,
          now: this.nowReal(),
        });
      }
    });
    tx();
    return result;
  }

  // ─── 摘要（§13.4.1 输入用）────────────────────────────────────────────────

  /** owner 现有知识点的紧凑摘要（反射输入用，避免 Agent 每次重写一遍掌握度）。 */
  knowledgeSummary(owner: string): string {
    const rows = this.listItems(owner);
    if (rows.length === 0) return "";
    const lines = rows.slice(0, 20).map((r) => {
      const mis = r.isMisconception === 1 ? "（我可能有误会）" : "";
      return `${r.topic}: ${r.mastery}${mis} · conf ${r.confidence.toFixed(2)} · 保持 ${r.retention.toFixed(2)}`;
    });
    return lines.join("\n");
  }

  // ─── 审计 ─────────────────────────────────────────────────────────────────

  /**
   * 最近一次自省留下的学习队列（§17.5.2：存在 reflections.output_json）。供场景 open 时
   * 注入瞬时上下文读取。无 / 非法（缺 output_json 或 learningQueue 非数组）一律回空队列，
   * 读取端不把缺数据当错误。
   *
   * A35：只看 status='done' 的反射，按 started_at 从新到旧扫描，取第一条含合法
   * learningQueue 的记录——失败的反射（status='failed'，output_json={error}）与「已 done 但
   * 没带 learningQueue」的更早反射都不会被误当成最新队列。
   */
  lastLearningQueue(owner: string): LearningQueueItem[] {
    const rows = this.db
      .prepare<[string], { output_json: string | null }>(
        `SELECT output_json FROM reflections
          WHERE owner_agent = ? AND status = 'done' AND output_json IS NOT NULL
          ORDER BY started_at DESC`,
      )
      .all(owner);
    for (const row of rows) {
      if (!row.output_json) continue;
      try {
        const parsed = JSON.parse(row.output_json) as { learningQueue?: unknown };
        if (!Array.isArray(parsed.learningQueue)) continue;
        return (parsed.learningQueue as Array<Record<string, unknown>>)
          .filter((x) => x && typeof x === "object" && typeof x.topic === "string")
          .map((x) => ({
            topic: String(x.topic),
            priority: x.priority === "high" || x.priority === "medium" || x.priority === "low" ? x.priority : "medium",
            motivation: typeof x.motivation === "string" ? x.motivation.slice(0, 200) : "",
          }));
      } catch {
        continue;
      }
    }
    return [];
  }

  stateWrite(row: {
    ownerAgent: string;
    targetId: string;
    reason: string | null;
    beforeJson: string;
    afterJson: string;
    source?: string | null;
  }): void {
    this.db
      .prepare(`
        INSERT INTO state_writes
          (write_id, owner_agent, target, target_id, op, reason, before_json, after_json,
           actor, reflection_id, real_ts)
        VALUES (@id, @owner, 'knowledge', @targetId, 'knowledge_update', @reason,
                @before, @after, 'KnowledgeService', @source, @now)
      `)
      .run({
        id: newId("sw"),
        owner: row.ownerAgent,
        targetId: row.targetId,
        reason: row.reason,
        before: row.beforeJson,
        after: row.afterJson,
        source: row.source ?? null,
        now: this.nowReal(),
      });
  }
}