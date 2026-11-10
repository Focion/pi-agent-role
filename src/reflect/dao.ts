// ═══════════════════════════════════════════════════════════════════════════
// 自省 DAO（§13 / §15.2 / §18.4.3）—— reflections / subject_profiles / state_writes
//
// 只碰 DB-A（reflections / subject_profiles / episodes / agent_state / state_writes），
// 绝不 JOIN、绝不写 mesh_ 表（R2）。分区纪律与 MemoryDao 一致：每个写方法首参或闭包
// 都是 owner_agent，SQL 恒带 `WHERE owner_agent = @owner`。
//
// 新情节（巩固 percentile/自我洞察）经 MemoryDao.insertEpisode 写（复用情节日志 +
// 主体挂载语义）；本 DAO 只负责「读啥该 reflect / 折旧立新 / 画像回写 / 审计」。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import type { SubjectRef } from "../memory/subject.js";
import { newId } from "../runtime/id.js";
import type { ProfileRow, ReflectionTrigger } from "./types.js";
import { triggerColumn } from "./types.js";
import { modelConfigHashFromJson } from "../compile/fingerprint.js";

/** 供组装 ReflectionInput 的情节简报（§13.4.1）。 */
export interface EpisodeBrief {
  episodeId: string;
  kind: string;
  gist: string;
  detail: string | null;
  quote: string | null;
  emotion: string | null;
  valence: number | null;
  arousal: number | null;
  salience: number;
  retention: number;
  status: string;
  virtualTs: string | null;
  sceneId: string | null;
}

/** 画像快照（组装输入用；subject 为序列化 SubjectRef）。 */
export interface ProfileSnapshot {
  subject: string;
  impression: string | null;
  valence: number | null;
  closeness: number | null;
  trust: number | null;
  episodeCount: number;
}

export interface ReflectionRow {
  reflectionId: string;
  ownerAgent: string;
  trigger: ReflectionTrigger;
  sceneId: string | null;
  reflectMsgId: string | null;
  inputJson: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  /** R06 E09：缺省按写时刻该 agent 的定稿模型配置哈希；显式传入可覆盖（测试）。 */
  modelConfigHash?: string | null;
}

export interface ReflectionDaoDeps {
  db: Database.Database;
  nowReal: () => string;
}

export class ReflectionDao {
  readonly db: Database.Database;
  private readonly nowReal: () => string;

  constructor(deps: ReflectionDaoDeps) {
    this.db = deps.db;
    this.nowReal = deps.nowReal;
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

  /** episode 是否属于该 owner（优于「存在性」，反射证据只认 owner 分区，§13.4.3）。 */
  ownsEpisode(owner: string, episodeId: string): boolean {
    return (
      this.db
        .prepare<[string, string], { n: number }>(
          `SELECT 1 AS n FROM episodes WHERE episode_id = ? AND owner_agent = ?`,
        )
        .get(episodeId, owner) !== undefined
    );
  }

  // ─── 读取端（组装输入）────────────────────────────────────────────────────

  /**
   * 最近一次**成功完成**自省的 finished_at（real ts）；从未成功 reflect 返回 null。
   * A21：成功游标独立于最新尝试——失败的 / 仍在 running 的反射不推进 since，
   * 否则其 started_at 会把尚未成功处理的旧 episodes 排出下一批证据窗。
   * 用 finished_at（而非 started_at）：自省自己写的巩固/自我洞察情节 real_ts 落在
   * [started_at, finished_at] 内，以 finished_at 为游标不会把它们卷进下一轮重复处理。
   */
  lastReflectionAt(owner: string): string | null {
    const row = this.db
      .prepare<[string], { finished_at: string | null }>(
        `SELECT finished_at FROM reflections
          WHERE owner_agent = ? AND status = 'done' AND finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1`,
      )
      .get(owner);
    return row?.finished_at ?? null;
  }

  /**
   * 最近一次自省留下的未澄清问题（§13.4.1 旧问题连续，R17；存在 reflections.output_json）。
   * 只认 status='done' 的反射，按 started_at 从新到旧扫描，取第一条含合法 openQuestions 数组
   * 的记录；失败的反射或未带 openQuestions 的更早反射不误当最新。缺数据一律回空数组。
   */
  lastOpenQuestions(owner: string): string[] {
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
        const parsed = JSON.parse(row.output_json) as { openQuestions?: unknown };
        if (!Array.isArray(parsed.openQuestions)) continue;
        return (parsed.openQuestions as unknown[])
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim().slice(0, 200));
      } catch {
        continue;
      }
    }
    return [];
  }

  /** 自上次 reflect 以来（real_ts > since）的 active 情节：计数 + 简报 + 最高 arousal。 */
  episodesSince(
    owner: string,
    sinceRealTs: string | null,
    limit = 40,
  ): { count: number; entries: EpisodeBrief[]; maxArousal: number } {
    const rows = this.db
      .prepare<[string, string, number], {
        episode_id: string;
        kind: string;
        gist: string;
        detail: string | null;
        quote: string | null;
        emotion: string | null;
        valence: number | null;
        arousal: number | null;
        salience: number;
        retention: number;
        status: string;
        virtual_ts: string | null;
        scene_id: string | null;
      }>(
        `SELECT episode_id, kind, gist, detail, quote, emotion, valence, arousal,
                salience, retention, status, virtual_ts, scene_id
           FROM episodes
          WHERE owner_agent = ? AND status = 'active' AND real_ts > ?
          ORDER BY salience DESC, real_ts DESC
          LIMIT ?`,
      )
      .all(owner, sinceRealTs ?? "", limit);
    const countRow = this.db
      .prepare<[string, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM episodes WHERE owner_agent = ? AND status = 'active' AND real_ts > ?`,
      )
      .get(owner, sinceRealTs ?? "");
    let maxArousal = 0;
    for (const r of rows) {
      if ((r.arousal ?? 0) > maxArousal) maxArousal = r.arousal ?? 0;
    }
    const entries = rows.map((r) => ({
      episodeId: r.episode_id,
      kind: r.kind,
      gist: r.gist,
      detail: r.detail,
      quote: r.quote,
      emotion: r.emotion,
      valence: r.valence,
      arousal: r.arousal,
      salience: r.salience,
      retention: r.retention,
      status: r.status,
      virtualTs: r.virtual_ts,
      sceneId: r.scene_id,
    }));
    return { count: countRow?.n ?? 0, entries, maxArousal };
  }

  /** owner 全量主体画像（组装输入；subject 用序列化字面量）。 */
  profiles(owner: string): ProfileSnapshot[] {
    const rows = this.db
      .prepare<[string], { subject_type: string; subject_id: string; impression: string | null; valence: number | null; closeness: number | null; trust: number | null; episode_count: number }>(
        `SELECT subject_type, subject_id, impression, valence, closeness, trust, episode_count
           FROM subject_profiles WHERE owner_agent = ? ORDER BY episode_count DESC`,
      )
      .all(owner);
    return rows.map((r) => ({
      subject: r.subject_type === "self" ? "self" : `${r.subject_type}:${r.subject_id}`,
      impression: r.impression,
      valence: r.valence,
      closeness: r.closeness,
      trust: r.trust,
      episodeCount: r.episode_count,
    }));
  }

  /** 当前情绪/能量（agent_state）。缺失值回默认，保证输入对象完整。 */
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

  /** 知识摘要（§17 完整落地在 P5；P4 恒空串）。 */
  knowledgeSummary(_owner: string): string {
    return "";
  }

  // ─── 读取端（反查快照）────────────────────────────────────────────────────

  profileRow(owner: string, ref: SubjectRef): ProfileRow | undefined {
    return this.db
      .prepare<[string, string, string], ProfileRow>(
        `SELECT impression, valence, closeness, trust FROM subject_profiles
         WHERE owner_agent = ? AND subject_type = ? AND subject_id = ?`,
      )
      .get(owner, ref.type, ref.id);
  }

  // ─── reflections 行 ────────────────────────────────────────────────────────

  insertReflection(row: ReflectionRow): void {
    this.db
      .prepare(`
        INSERT INTO reflections
          (reflection_id, owner_agent, trigger, scene_id, reflect_msg_id,
           result_msg_id, reflect_session_id, input_json, output_json,
           episodes_written, profiles_touched, status, started_at, finished_at, model_config_hash)
        VALUES (@id, @owner, @trigger, @sceneId, @reflectMsgId,
                NULL, NULL, @inputJson, NULL,
                0, 0, @status, @startedAt, NULL, @modelConfigHash)
      `)
      .run({
        id: row.reflectionId,
        owner: row.ownerAgent,
        trigger: triggerColumn(row.trigger),
        sceneId: row.sceneId,
        reflectMsgId: row.reflectMsgId,
        inputJson: row.inputJson,
        status: row.status,
        startedAt: row.startedAt,
        modelConfigHash: row.modelConfigHash ?? this.configHashFor(row.ownerAgent),
      });
  }

  finishReflection(
    reflectionId: string,
    opts: { outputJson: string; episodesWritten: number; profilesTouched: number; resultMsgId?: string | null },
  ): void {
    this.db
      .prepare(`
        UPDATE reflections
           SET output_json = ?, result_msg_id = ?, episodes_written = ?,
               profiles_touched = ?, status = 'done', finished_at = ?
         WHERE reflection_id = ?
      `)
      .run(opts.outputJson, opts.resultMsgId ?? null, opts.episodesWritten, opts.profilesTouched, this.nowReal(), reflectionId);
  }

  failReflection(reflectionId: string, message: string): void {
    this.db
      .prepare(`UPDATE reflections SET status = 'failed', output_json = ?, finished_at = ? WHERE reflection_id = ?`)
      .run(JSON.stringify({ error: message }), this.nowReal(), reflectionId);
  }

  /**
   * R19 重启恢复：把上次进程遗留的 `running` 批整体标记 failed（interrupted）并落 finished_at，
   * 使其「正确终结」而非永久悬挂。A21 成功游标只认 done 行，这些未完成输入的 evidence 窗
   * 不会被跳过，下次 `maybe()` 会按同一证据窗重新成批。返回终结的批数。
   */
  failOrphanedRunning(): number {
    const res = this.db
      .prepare(
        `UPDATE reflections
            SET status = 'failed', output_json = ?, finished_at = ?
          WHERE status = 'running'`,
      )
      .run(JSON.stringify({ error: "interrupted" }), this.nowReal());
    return res.changes;
  }

  /** 发送成功后回填 reflect_msg_id（A12：发送前先落行，msgId 后补，不因此延后批次关联）。 */
  recordReflectMsg(reflectionId: string, reflectMsgId: string): void {
    this.db
      .prepare(`UPDATE reflections SET reflect_msg_id = ? WHERE reflection_id = ?`)
      .run(reflectMsgId, reflectionId);
  }

  reflectionStatus(reflectionId: string): { owner: string; status: string } | undefined {
    const row = this.db
      .prepare<[string], { owner_agent: string; status: string }>(
        `SELECT owner_agent, status FROM reflections WHERE reflection_id = ?`,
      )
      .get(reflectionId);
    return row ? { owner: row.owner_agent, status: row.status } : undefined;
  }

  latestReflections(owner: string, limit: number): Array<{
    reflectionId: string;
    trigger: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    episodesWritten: number;
    profilesTouched: number;
  }> {
    const rows = this.db
      .prepare<[string, number], { reflection_id: string; trigger: string; status: string; started_at: string; finished_at: string | null; episodes_written: number; profiles_touched: number }>(
        `SELECT reflection_id, trigger, status, started_at, finished_at, episodes_written, profiles_touched
           FROM reflections WHERE owner_agent = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(owner, limit);
    return rows.map((r) => ({
      reflectionId: r.reflection_id,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      episodesWritten: r.episodes_written,
      profilesTouched: r.profiles_touched,
    }));
  }

  // ─── 画像回写（delta 已在 service 层合并限幅，这里只做原子读写 + 审计）────────

  /**
   * 写主体画像：impression/valence/traits 覆盖，closeness/trust 用传入的绝对终值。
   * 返回 before/after（JSON 化后的审计载），并落一条 state_writes（actor=ReflectionService）。
   */
  applyProfile(
    owner: string,
    ref: SubjectRef,
    patch: {
      impression?: string;
      valence?: number;
      closeness?: number;
      trust?: number;
      traits?: unknown;
    },
    opts: { reflectionId?: string; reason?: string },
  ): { before: ProfileRow | undefined; after: ProfileRow } {
    const before = this.profileRow(owner, ref) ?? {
      impression: null,
      valence: null,
      closeness: null,
      trust: null,
    };
    const after: ProfileRow = {
      impression: patch.impression !== undefined ? patch.impression : before.impression,
      valence: patch.valence !== undefined ? patch.valence : before.valence,
      closeness: patch.closeness !== undefined ? patch.closeness : before.closeness,
      trust: patch.trust !== undefined ? patch.trust : before.trust,
    };
    const traitsJson = patch.traits !== undefined ? JSON.stringify(patch.traits) : undefined;

    this.db
      .prepare(`
        INSERT INTO subject_profiles
          (owner_agent, subject_type, subject_id, impression, valence, closeness, trust, traits_json,
           episode_count, evidence_json, updated_at)
        VALUES (@owner, @type, @id, @impression, @valence, @closeness, @trust, @traits,
                0, '[]', @now)
        ON CONFLICT (owner_agent, subject_type, subject_id) DO UPDATE SET
          impression = CASE WHEN @impressionSet THEN excluded.impression ELSE subject_profiles.impression END,
          valence    = CASE WHEN @valenceSet THEN excluded.valence ELSE subject_profiles.valence END,
          closeness  = CASE WHEN @closenessSet THEN excluded.closeness ELSE subject_profiles.closeness END,
          trust      = CASE WHEN @trustSet THEN excluded.trust ELSE subject_profiles.trust END,
          traits_json = CASE WHEN @traitsSet THEN excluded.traits_json ELSE subject_profiles.traits_json END,
          updated_at = excluded.updated_at
      `)
      .run({
        owner,
        type: ref.type,
        id: ref.id,
        impression: patch.impression ?? null,
        valence: patch.valence ?? null,
        closeness: patch.closeness ?? null,
        trust: patch.trust ?? null,
        traits: traitsJson ?? null,
        now: this.nowReal(),
        impressionSet: patch.impression !== undefined ? 1 : 0,
        valenceSet: patch.valence !== undefined ? 1 : 0,
        closenessSet: patch.closeness !== undefined ? 1 : 0,
        trustSet: patch.trust !== undefined ? 1 : 0,
        traitsSet: patch.traits !== undefined ? 1 : 0,
      });

    this.stateWrite({
      ownerAgent: owner,
      target: "subject_profile",
      targetId: ref.type === "self" ? "self" : `${ref.type}:${ref.id}`,
      op: "reflect",
      reason: opts.reason ?? null,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
      actor: "ReflectionService",
      reflectionId: opts.reflectionId ?? null,
    });

    return { before, after };
  }

  /** 把一组 L1 情节标记 consolidated（§15.2 折旧）。 */
  markConsolidated(owner: string, episodeIds: string[]): void {
    if (episodeIds.length === 0) return;
    const placeholders = episodeIds.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE episodes SET status = 'consolidated' WHERE owner_agent = ? AND episode_id IN (${placeholders})`,
      )
      .run(owner, ...episodeIds);
  }

  /** agent_state 回写（mood 覆盖 + mood_intensity/energy 绝对终值）+ 审计。 */
  applyState(
    owner: string,
    next: { mood?: string; moodIntensity?: number; energy?: number },
    opts: { reflectionId?: string; reason?: string; before: ReturnType<ReflectionDao["currentState"]> },
  ): void {
    const set = (key: string, value: unknown): void => {
      this.db
        .prepare(`
          INSERT INTO agent_state (agent_id, key, value_json, updated_at)
          VALUES (@agent, @key, @value, @now)
          ON CONFLICT (agent_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `)
        .run({ agent: owner, key, value: JSON.stringify(value), now: this.nowReal() });
    };
    if (next.mood !== undefined) set("mood", next.mood);
    if (next.moodIntensity !== undefined) set("mood_intensity", next.moodIntensity);
    if (next.energy !== undefined) set("energy", next.energy);

    this.stateWrite({
      ownerAgent: owner,
      target: "agent_state",
      targetId: owner,
      op: "reflect",
      reason: opts.reason ?? null,
      beforeJson: JSON.stringify(opts.before),
      afterJson: JSON.stringify(next),
      actor: "ReflectionService",
      reflectionId: opts.reflectionId ?? null,
    });
  }

  stateWrite(row: {
    ownerAgent: string;
    target: string;
    targetId: string;
    op: string;
    reason: string | null;
    beforeJson: string;
    afterJson: string;
    actor: "ReflectionService" | "MemoryService" | "Projector" | "host";
    reflectionId: string | null;
  }): void {
    this.db
      .prepare(`
        INSERT INTO state_writes (write_id, owner_agent, target, target_id, op, reason,
          before_json, after_json, actor, reflection_id, real_ts)
        VALUES (@id, @owner, @target, @targetId, @op, @reason,
                @before, @after, @actor, @reflectionId, @now)
      `)
      .run({
        id: newId("sw"),
        owner: row.ownerAgent,
        target: row.target,
        targetId: row.targetId,
        op: row.op,
        reason: row.reason,
        before: row.beforeJson,
        after: row.afterJson,
        actor: row.actor,
        reflectionId: row.reflectionId,
        now: this.nowReal(),
      });
  }
}