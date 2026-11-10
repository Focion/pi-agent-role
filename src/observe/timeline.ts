// ═══════════════════════════════════════════════════════════════════════════
// 记忆时间线 builder（§20.3.1）
//
// 两阶段：① DB-A 查 episodes + subjects + scenes（过滤 owner/时间窗）
// ② 按 sourceMsgId 批量回查 mesh（经 src/mesh/timeline-lookup.ts）。
// 回查结果决定 evidenceLevel：有原文→L0，有 quote→L1，皆无→L2。
//
// 分层纪律（§22.4 R1/R2）：本文件不 import @pi/agent-mesh，mesh SQL 经 lookup 触达。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import { meshTimelineEvidence } from "../mesh/timeline-lookup.js";
import type { MemoryTimeline, TimelineItem, TimelineScene, EvidenceLevel } from "./types.js";

interface EpisodeRow {
  episode_id: string;
  kind: string;
  scene_id: string | null;
  gist: string;
  detail: string | null;
  quote: string | null;
  emotion: string | null;
  valence: number | null;
  salience: number;
  confidence: number;
  retention: number;
  rehearsal_count: number;
  virtual_ts: string | null;
  real_ts: string;
  source_msg_id: string | null;
  source_entry_id: string | null;
  scene_name: string | null;
  scene_conversation_id: string | null;
  scene_virtual_start: string | null;
  scene_turn_count: number | null;
  scene_status: string | null;
}

interface SubjectRow {
  episode_id: string;
  subject: string;
  weight: number;
}

interface AccountRow {
  mesh_account_id: string | null;
}

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_SINCE = "1970-01-01T00:00:00.000Z";
const DEFAULT_UNTIL = "9999-12-31T23:59:59.000Z";

/**
 * 构建角色记忆时间线。
 *
 * @param db DB-A 连接句柄
 * @param meshDbPath mesh 库路径
 * @param ownerAgent 角色 agentId
 * @param opts 时间窗与条数上限
 */
export function buildMemoryTimeline(
  db: Database.Database,
  meshDbPath: string,
  ownerAgent: string,
  opts: { since?: string; until?: string; maxItems?: number } = {},
): MemoryTimeline {
  const since = opts.since ?? DEFAULT_SINCE;
  const until = opts.until ?? DEFAULT_UNTIL;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;

  // ── 取 Agent 的 mesh accountId ──
  const agentRow = db
    .prepare<[string], AccountRow>(`SELECT mesh_account_id FROM agents WHERE agent_id = ?`)
    .get(ownerAgent);
  const accountId = agentRow?.mesh_account_id ?? null;

  // ── 第一阶段：DB-A 一次查询 episodes + scenes（§20.3.1 取数顺序）──
  const rows = db
    .prepare<[string, string, string, number], EpisodeRow>(
      `SELECT e.episode_id, e.kind, e.scene_id,
              e.gist, e.detail, e.quote,
              e.emotion, e.valence, e.salience, e.confidence, e.retention,
              e.rehearsal_count, e.virtual_ts, e.real_ts,
              e.source_msg_id, e.source_entry_id,
              s.name        AS scene_name,
              s.conversation_id AS scene_conversation_id,
              s.virtual_start   AS scene_virtual_start,
              s.turn_count      AS scene_turn_count,
              s.status          AS scene_status
         FROM episodes e
         LEFT JOIN scenes s ON s.scene_id = e.scene_id
        WHERE e.owner_agent = ?
          AND e.status = 'active'
          AND e.real_ts >= ?
          AND e.real_ts <= ?
        ORDER BY e.real_ts DESC
        LIMIT ?`,
    )
    .all(ownerAgent, since, until, maxItems + 1);

  const truncated = rows.length > maxItems;
  const items = rows.slice(0, maxItems);

  // ── 批量取 subjects ──
  const episodeIds = items.map((r) => r.episode_id);
  let subjectsByEpisode = new Map<string, Array<{ subject: string; weight: number }>>();
  if (episodeIds.length > 0) {
    const placeholders = episodeIds.map(() => "?").join(",");
    const subjectRows = db
      .prepare<unknown[], SubjectRow>(
        `SELECT episode_id,
                subject_type || ':' || subject_id AS subject,
                weight
           FROM episode_subjects
          WHERE episode_id IN (${placeholders})
          ORDER BY weight DESC`,
      )
      .all(...episodeIds);
    for (const s of subjectRows) {
      const list = subjectsByEpisode.get(s.episode_id) ?? [];
      list.push({ subject: s.subject, weight: s.weight });
      subjectsByEpisode.set(s.episode_id, list);
    }
  }

  // ── 第二阶段：批量回查 mesh 证据 ──
  const sourceMsgIds = items
    .map((r) => r.source_msg_id)
    .filter((id): id is string => id !== null);
  const evidenceMap = accountId
    ? meshTimelineEvidence(meshDbPath, sourceMsgIds, accountId)
    : new Map();

  // ── 组装 items ──
  function evidenceLevel(item: typeof items[number]): EvidenceLevel {
    if (item.source_msg_id && evidenceMap.has(item.source_msg_id)) return "L0";
    // A30：L1 = 有消息锚点但原文已裁剪 + 有 quote。证据等级依「来源」而非「是否填了 quote」——
    // 无锚点（source_msg_id 为空）的 quote 只是主观摘录，不能冒充引文证据。
    if (item.source_msg_id && item.quote) return "L1";
    return "L2";
  }

  const timelineItems: TimelineItem[] = items.map((r) => ({
    episodeId: r.episode_id,
    kind: r.kind as TimelineItem["kind"],
    gist: r.gist,
    detail: r.detail,
    quote: r.quote,
    emotion: r.emotion,
    valence: r.valence,
    salience: r.salience,
    confidence: r.confidence,
    retention: r.retention,
    rehearsalCount: r.rehearsal_count,
    virtualTs: r.virtual_ts,
    realTs: r.real_ts,
    subjects: subjectsByEpisode.get(r.episode_id) ?? [],
    sourceMsgId: r.source_msg_id,
    sourceEntryId: r.source_entry_id,
    evidenceLevel: evidenceLevel(r),
    evidence: r.source_msg_id ? evidenceMap.get(r.source_msg_id) ?? null : null,
  }));

  // ── 按 scene 分组 ──
  const sceneMap = new Map<string, { items: TimelineItem[]; meta: Omit<TimelineScene, "items" | "degradedPolicies"> }>();
  const unscenedItems: TimelineItem[] = [];

  for (const ti of timelineItems) {
    const sceneId = items.find((r) => r.episode_id === ti.episodeId)?.scene_id;
    if (sceneId) {
      const existing = sceneMap.get(sceneId);
      if (existing) {
        existing.items.push(ti);
      } else {
        const meta = items.find((r) => r.scene_id === sceneId)!;
        sceneMap.set(sceneId, {
          items: [ti],
          meta: {
            sceneId,
            name: meta.scene_name,
            conversationId: meta.scene_conversation_id,
            virtualStart: meta.scene_virtual_start,
            turnCount: meta.scene_turn_count ?? 0,
            status: meta.scene_status ?? "unknown",
          },
        });
      }
    } else {
      unscenedItems.push(ti);
    }
  }

  const scenes: TimelineScene[] = [...sceneMap.values()].map((s) => ({
    ...s.meta,
    degradedPolicies: [], // 事件流订阅由宿主负责，此处无法回溯历史
    items: s.items,
  }));

  if (unscenedItems.length > 0) {
    scenes.push({
      sceneId: "_unscened",
      name: null,
      conversationId: null,
      virtualStart: null,
      turnCount: 0,
      status: "n/a",
      degradedPolicies: [],
      items: unscenedItems,
    });
  }

  return {
    ownerAgent,
    window: { since, until },
    scenes,
    truncated,
  };
}