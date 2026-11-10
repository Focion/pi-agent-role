// ═══════════════════════════════════════════════════════════════════════════
// 成本视图 builder（§20.3.3）
//
// 组合三部分：
//   1. meshCounters — 从 mesh 计数器快照原样展示（供数方：mesh/counters-lookup，
//      经 Observer.counters 只读触达；快照缺失时退零且不视为「未发生」）
//   2. roleOnly — 复用 costMetricsExcludingReflect（§20.2.4 排除自省重算）
//   3. roleNormalized + localOverhead — 本环侧 retrieval_log / reflections / scenes 查询
//
// 分层纪律（§22.4 R1/R2）：本文件不 import @pi/agent-mesh；mesh 计数器的读取
// 与派生分离——本文件只做派生（纯函数），读取在 runtime.ts / mesh 侧完成。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import { costMetricsExcludingReflect } from "../inspect/cost.js";
import type { MeshCounterSnapshot } from "../mesh/counters-lookup.js";
import type { CostView } from "./types.js";

const DEFAULT_SINCE = "1970-01-01T00:00:00.000Z";
const DEFAULT_UNTIL = "9999-12-31T23:59:59.000Z";

const div = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/**
 * 由 9 计数器的快照派生 meshCounters 段（§20.3.3 派生口径）。
 * 纯函数、无 IO：快照缺失（`undefined`，observer 不可用）时退为零值骨架——
 * 零值仅表示「未接线」，不代表「没有发生」（由 roleOnly 段补足真实口径）。
 */
export function deriveMeshCounters(
  c: MeshCounterSnapshot | undefined,
): CostView["meshCounters"] {
  const messages = c?.messagesTotal ?? 0;
  const deliveries = c?.deliveriesTotal ?? 0;
  const wakeIdle = c?.wakePerMessageIdle ?? 0;
  const wakeBusy = c?.wakePerMessageBusy ?? 0;
  const verbatimCopies = c?.verbatimCopies ?? 0;
  const silentGrade = c?.silentGrade ?? 0;
  const coldHit = c?.coldHit ?? 0;
  return {
    bucketGranularity: "hour",
    messagesTotal: messages,
    deliveriesTotal: deliveries,
    wakeIdle,
    wakeBusy,
    verbatimCopies,
    silentGrade,
    coldHit,
    derived: {
      wakePerMessage: div(wakeIdle + wakeBusy, messages),
      wakePerMessageIdle: div(wakeIdle, messages),
      wakePerMessageBusy: div(wakeBusy, messages),
      verbatimPerMessage: div(verbatimCopies, messages),
      silentRate: div(silentGrade, deliveries),
      verbatimRate: div(verbatimCopies, deliveries),
      coldHitRate: div(coldHit, deliveries),
    },
  };
}

export function buildCostView(
  roleDb: Database.Database,
  meshDbPath: string,
  opts: {
    since?: string;
    until?: string;
    sceneIds?: string[];
    agentIds?: string[];
    /** mesh 计数器快照（runtime 层经 Observer.counters 读好后注入；缺省退零）。 */
    meshCounters?: MeshCounterSnapshot;
  } = {},
): CostView {
  const since = opts.since ?? DEFAULT_SINCE;
  const until = opts.until ?? DEFAULT_UNTIL;
  const scopeSceneIds = opts.sceneIds?.length ? opts.sceneIds : "all";
  const scopeAgentIds = opts.agentIds?.length ? opts.agentIds : "all";
  // R35：是否真的在按时间窗收窄（默认全域不算「窗口查询」）。
  const timeWindowed = since !== DEFAULT_SINCE || until !== DEFAULT_UNTIL;

  // A36/R35：三段各自能支持的过滤范围不同，准确声明（不是把同一 scope 包装到不同数据段上）。
  const caveats: string[] = [
    timeWindowed
      ? `role 侧 retrieval/reflection 与 mesh 投递统一按半开时间窗 [${since}, ${until}) 过滤`
      : "未指定时间窗：mesh 投递 / role 侧检索与自省按默认全域 [1970-01-01, 9999-12-31) 取数",
    "roleOnly（mesh 投递层）无 sceneId，只按 agentIds ∩ 时间窗；sceneIds 不作用于该段",
    "retrieval / reflection 按 agentIds ∩ sceneIds ∩ 时间窗过滤",
    "scene 累计量（turn_count / token_spent / token_budget / overBudget）为场景生命周期累计，只按 sceneIds，不按 created_at 进时间窗",
    "roleNormalized.utteranceMessages/verbatim* 与 reflection.mesh* 需 mesh 事件流归因，当前不可得 → null（不以 0 占位）",
    "meshCounters 段来自 Observer 计数器快照：按小时分桶、只按 since 作下界，且只在 mesh 保留期内有效",
  ];

  // A36/R35：三段各自带自己所能支持的 scope 交集。
  // · roleOnly（mesh 投递层）无 sceneId，只能按 agentIds ∩ 时间窗。
  // · 本环 retrieval_log / reflections 有 owner_agent + scene_id，可做完整交集。
  // · scenes 层只有 scene_id，且 turn/token 是生命周期累计 → 只按 sceneIds，不进时间窗。
  const roleOnly = costMetricsExcludingReflect(roleDb, meshDbPath, {
    since,
    until,
    agentIds: opts.agentIds,
  });

  const meshCounters = deriveMeshCounters(opts.meshCounters);

  // ── 本环侧检索开销（retrieval_log）──
  const retClause = scopeSceneIds === "all" ? "" : `AND scene_id IN (${scopeSceneIds.map(() => "?").join(",")})`;
  const retAgentClause = scopeAgentIds === "all" ? "" : `AND owner_agent IN (${scopeAgentIds.map(() => "?").join(",")})`;
  const retBind = [...(scopeSceneIds === "all" ? [] : scopeSceneIds), ...(scopeAgentIds === "all" ? [] : scopeAgentIds)];
  const retRow = roleDb
    .prepare<unknown[], { calls: number; tL2: number; tL1: number; tTransient: number; tTotal: number; clamped: number }>(
      `SELECT COUNT(*)              AS calls,
              COALESCE(SUM(tokens_l2), 0)       AS tL2,
              COALESCE(SUM(tokens_l1), 0)       AS tL1,
              COALESCE(SUM(tokens_transient), 0) AS tTransient,
              COALESCE(SUM(tokens_total), 0)    AS tTotal,
              COALESCE(SUM(clamped), 0)         AS clamped
         FROM retrieval_log
        WHERE real_ts >= ? AND real_ts < ? ${retClause} ${retAgentClause}`,
    )
    .get(since, until, ...retBind) ?? { calls: 0, tL2: 0, tL1: 0, tTransient: 0, tTotal: 0, clamped: 0 };

  // p50 / p95 分位数（本环有明细，可算分布，§20.3.3）
  let p50 = 0;
  let p95 = 0;
  if (retRow.calls > 0) {
    const totals = roleDb
      .prepare<unknown[], { tokens_total: number }>(
        `SELECT tokens_total FROM retrieval_log
          WHERE real_ts >= ? AND real_ts < ? ${retClause} ${retAgentClause} AND tokens_total > 0
          ORDER BY tokens_total`,
      )
      .all(since, until, ...retBind)
      .map((r) => r.tokens_total);
    if (totals.length > 0) {
      totals.sort((a, b) => a - b);
      const idx50 = Math.floor(totals.length * 0.5);
      const idx95 = Math.floor(totals.length * 0.95);
      p50 = totals[Math.min(idx50, totals.length - 1)]!;
      p95 = totals[Math.min(idx95, totals.length - 1)]!;
    }
  }

  // ── 本环侧自省开销（reflections）──
  const reflAgentClause = scopeAgentIds === "all" ? "" : `AND owner_agent IN (${scopeAgentIds.map(() => "?").join(",")})`;
  const reflSceneClause = scopeSceneIds === "all" ? "" : `AND scene_id IN (${scopeSceneIds.map(() => "?").join(",")})`;
  const reflBind = [...(scopeAgentIds === "all" ? [] : scopeAgentIds), ...(scopeSceneIds === "all" ? [] : scopeSceneIds)];
  const reflRow = roleDb
    .prepare<unknown[], {
      runs: number;
      failed: number;
      episodesWritten: number;
      profilesTouched: number;
      wallMsTotal: number;
    }>(
      `SELECT COUNT(*)                                             AS runs,
              COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed,
              COALESCE(SUM(episodes_written), 0)                   AS episodesWritten,
              COALESCE(SUM(profiles_touched), 0)                   AS profilesTouched,
              COALESCE(SUM(
                CASE WHEN finished_at IS NOT NULL
                THEN (unixepoch(finished_at) - unixepoch(started_at)) * 1000
                ELSE 0 END
              ), 0)                                                AS wallMsTotal
         FROM reflections
        WHERE started_at >= ? AND started_at < ? ${reflAgentClause} ${reflSceneClause}`,
    )
    .get(since, until, ...reflBind) ?? { runs: 0, failed: 0, episodesWritten: 0, profilesTouched: 0, wallMsTotal: 0 };

  // ── 本环归一读数（§20.2.3）。R35：scene 的 turn_count 是生命周期累计，只按 sceneIds
  //    选场景，不按 created_at 进时间窗——否则会把「累计值」按创建时间筛成「窗口值」。──
  const scnClause = scopeSceneIds === "all" ? "" : `AND scene_id IN (${scopeSceneIds.map(() => "?").join(",")})`;
  const scnBind = scopeSceneIds === "all" ? [] : scopeSceneIds;
  const scnRow = roleDb
    .prepare<unknown[], { turns: number }>(
      `SELECT COALESCE(SUM(turn_count), 0) AS turns FROM scenes
        WHERE 1=1 ${scnClause}`,
    )
    .get(...scnBind) ?? { turns: 0 };

  // 发言消息数需 mesh 事件流精确区分 cue/发言，当前不可得（R35：不以 0 占位，标 null）。
  const utteranceMessages: number | null = null;
  const audiencePerUtterance =
    utteranceMessages !== null && utteranceMessages > 0 && roleOnly.deliveriesTotal > 0
      ? roleOnly.deliveriesTotal / utteranceMessages
      : null;

  // 场景预算
  const overBudgetScenes = (
    roleDb
      .prepare<unknown[], { scene_id: string }>(
        `SELECT scene_id FROM scenes
          WHERE token_budget IS NOT NULL AND token_spent > token_budget ${scnClause}`,
      )
      .all(...scnBind)
  ).map((r) => r.scene_id);

  const budgetRow = roleDb
    .prepare<unknown[], { tokenBudget: number | null; tokenSpent: number }>(
      `SELECT COALESCE(SUM(token_budget), NULL) AS tokenBudget,
              COALESCE(SUM(token_spent), 0)     AS tokenSpent
         FROM scenes
        WHERE 1=1 ${scnClause}`,
    )
    .get(...scnBind) ?? { tokenBudget: null, tokenSpent: 0 };

  return {
    window: { since, until },
    windowClampedTo: { since, until },
    scope: { sceneIds: scopeSceneIds, agentIds: scopeAgentIds },
    caveats,
    meshCounters,
    roleOnly: {
      messagesTotal: roleOnly.messagesTotal,
      deliveriesTotal: roleOnly.deliveriesTotal,
      wakesTotal: roleOnly.wakePerMessage !== null ? Math.round(roleOnly.wakePerMessage * roleOnly.messagesTotal) : 0,
      silentRate: roleOnly.silentRate,
      p1RatePerDelivery: roleOnly.p1RatePerDelivery,
      unattributedAccounts: roleOnly.unattributedAccounts,
      caveats: roleOnly.caveats,
    },
    roleNormalized: {
      turns: scnRow.turns,
      utteranceMessages,
      verbatimPerTurn: null, // 需 mesh 事件流的 verbatimCopies，当前不可得（R35：不以 0 占位）
      verbatimPerUtterance: null,
      audiencePerUtterance,
    },
    localOverhead: {
      retrieval: {
        calls: retRow.calls,
        tokensL2: retRow.tL2,
        tokensL1: retRow.tL1,
        tokensTransient: retRow.tTransient,
        tokensTotal: retRow.tTotal,
        clampedCalls: retRow.clamped,
        p50Total: p50,
        p95Total: p95,
      },
      reflection: {
        runs: reflRow.runs,
        failed: reflRow.failed,
        episodesWritten: reflRow.episodesWritten,
        profilesTouched: reflRow.profilesTouched,
        wallMsTotal: reflRow.wallMsTotal,
        meshMessages: null, // 需 mesh 事件流归因，当前不可得（R35：不以 0 占位）
        meshDeliveries: null,
        meshWakes: null,
      },
      sceneBudget: {
        tokenBudget: budgetRow.tokenBudget,
        tokenSpent: budgetRow.tokenSpent,
        overBudgetScenes,
      },
    },
    health: {
      // A 组两个健康计数器：来自 mesh 计数器快照（缺省退零，§20.3.3）。
      policyDegradedEvents: opts.meshCounters?.policyDegraded ?? 0,
      invariantViolatedEvents: opts.meshCounters?.invariantViolated ?? 0,
      danglingEvidence: 0,
      evidenceLevelMix: { L0: 0, L1: 0, L2: 0 },
    },
  };
}