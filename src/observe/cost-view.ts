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

  // ── roleOnly：复用现有成本排除算法（§20.2.4）──
  const roleOnly = costMetricsExcludingReflect(roleDb, meshDbPath, { since, until });

  const meshCounters = deriveMeshCounters(opts.meshCounters);

  // ── 本环侧检索开销（retrieval_log）──
  const retClause = scopeSceneIds === "all" ? "" : `AND scene_id IN (${scopeSceneIds.map(() => "?").join(",")})`;
  const retBind = scopeSceneIds === "all" ? [] : scopeSceneIds;
  const retRow = roleDb
    .prepare<unknown[], { calls: number; tL2: number; tL1: number; tTransient: number; tTotal: number; clamped: number }>(
      `SELECT COUNT(*)              AS calls,
              COALESCE(SUM(tokens_l2), 0)       AS tL2,
              COALESCE(SUM(tokens_l1), 0)       AS tL1,
              COALESCE(SUM(tokens_transient), 0) AS tTransient,
              COALESCE(SUM(tokens_total), 0)    AS tTotal,
              COALESCE(SUM(clamped), 0)         AS clamped
         FROM retrieval_log
        WHERE real_ts >= ? AND real_ts <= ? ${retClause}`,
    )
    .get(since, until, ...retBind) ?? { calls: 0, tL2: 0, tL1: 0, tTransient: 0, tTotal: 0, clamped: 0 };

  // p50 / p95 分位数（本环有明细，可算分布，§20.3.3）
  let p50 = 0;
  let p95 = 0;
  if (retRow.calls > 0) {
    const totals = roleDb
      .prepare<unknown[], { tokens_total: number }>(
        `SELECT tokens_total FROM retrieval_log
          WHERE real_ts >= ? AND real_ts <= ? ${retClause} AND tokens_total > 0
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
  const reflClause = scopeAgentIds === "all" ? "" : `AND owner_agent IN (${scopeAgentIds.map(() => "?").join(",")})`;
  const reflBind = scopeAgentIds === "all" ? [] : scopeAgentIds;
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
        WHERE started_at >= ? AND started_at <= ? ${reflClause}`,
    )
    .get(since, until, ...reflBind) ?? { runs: 0, failed: 0, episodesWritten: 0, profilesTouched: 0, wallMsTotal: 0 };

  // ── 本环归一读数（§20.2.3）──
  const scnClause = scopeSceneIds === "all" ? "" : `AND scene_id IN (${scopeSceneIds.map(() => "?").join(",")})`;
  const scnBind = scopeSceneIds === "all" ? [] : scopeSceneIds;
  const scnRow = roleDb
    .prepare<unknown[], { turns: number }>(
      `SELECT COALESCE(SUM(turn_count), 0) AS turns FROM scenes
        WHERE created_at >= ? AND created_at <= ? ${scnClause}`,
    )
    .get(since, until, ...scnBind) ?? { turns: 0 };

  // 发言消息数：当前不含 msgClass 列，视为 0（需 mesh 事件流才能精确区分 cue/发言）。
  const utteranceMessages = 0;
  const audiencePerUtterance =
    utteranceMessages > 0 && roleOnly.deliveriesTotal > 0
      ? roleOnly.deliveriesTotal / utteranceMessages
      : null;

  // 场景预算
  const overBudgetScenes = (
    roleDb
      .prepare<unknown[], { scene_id: string }>(
        `SELECT scene_id FROM scenes
          WHERE token_budget IS NOT NULL AND token_spent > token_budget
            AND created_at >= ? AND created_at <= ? ${scnClause}`,
      )
      .all(since, until, ...scnBind)
  ).map((r) => r.scene_id);

  const budgetRow = roleDb
    .prepare<unknown[], { tokenBudget: number | null; tokenSpent: number }>(
      `SELECT COALESCE(SUM(token_budget), NULL) AS tokenBudget,
              COALESCE(SUM(token_spent), 0)     AS tokenSpent
         FROM scenes
        WHERE created_at >= ? AND created_at <= ? ${scnClause}`,
    )
    .get(since, until, ...scnBind) ?? { tokenBudget: null, tokenSpent: 0 };

  return {
    window: { since, until },
    windowClampedTo: { since, until },
    scope: { sceneIds: scopeSceneIds, agentIds: scopeAgentIds },
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
      verbatimPerTurn: scnRow.turns > 0 ? 0 : null, // 需 mesh 事件流的 verbatimCopies，当前不可得
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
        meshMessages: 0, // 需 mesh 事件流
        meshDeliveries: 0,
        meshWakes: 0,
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