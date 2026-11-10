// ═══════════════════════════════════════════════════════════════════════════
// Runtime.memory 宿主只读检索 / 统计（R08 / §14 / §20）
//
// 与面向 Agent 的 remember/recall 工具不同：这里是**宿主**侧只读门面，绝不动记忆状态
// （不 reinforce、不 reviveStrongCue、不落 retrieval_log 账、不 bump rehearsal），履行
// R08「不隐式强化或修复」。区分两种视图：
//   · owner 视图 `recall(owner)`：检索单个角色记得什么（分区键 owner 锁死）。
//   · 管理视图 `stats()`：跨 role agent 的记忆计数汇总（只读）。
//
// 分层纪律：本文件属 src/memory/**，不 import @pi/agent-mesh（R1）、不出现 mesh_ 表名（R2）。
// ═════════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import type { MemoryApi, MemoryRecallItem, MemoryRecallResult, MemoryStats, MemoryStatsAgent } from "../runtime/types.js";
import type { EpisodeCandidate, MemoryDao } from "./dao.js";

function clampLimit(v: unknown, fallback = 10): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(1, Math.min(50, n));
}

function toItem(c: EpisodeCandidate): MemoryRecallItem {
  return {
    episodeId: c.episodeId,
    kind: c.kind,
    gist: c.gist,
    detail: c.detail ?? null,
    salience: c.salience,
    retention: c.retention,
    confidence: c.confidence,
    status: c.status,
    virtualTs: c.virtualTs ?? null,
  };
}

/** 组装宿主只读 memory 门面（R08）。 */
export function makeMemoryApi(db: Database.Database, dao: MemoryDao): MemoryApi {
  return {
    async recall(ownerAgent, query, opts): Promise<MemoryRecallResult> {
      const q = query.trim();
      const items = dao.searchCandidates(ownerAgent, q, true, clampLimit(opts?.limit)).map(toItem);
      return { ownerAgent, query: q, items };
    },

    async stats(): Promise<MemoryStats> {
      const agents = db
        .prepare<[], { agent_id: string }>(`SELECT agent_id FROM agents WHERE agent_type = 'role' ORDER BY agent_id`)
        .all();
      const counts = new Map<string, MemoryStatsAgent>();
      for (const a of agents) {
        counts.set(a.agent_id, {
          agentId: a.agent_id,
          episodes: 0,
          subjects: 0,
          knowledgeItems: 0,
          reflections: 0,
        });
      }

      const sum = (table: string, field: keyof Pick<MemoryStatsAgent, "episodes" | "subjects" | "knowledgeItems" | "reflections">): void => {
        const rows = db.prepare<[], { owner_agent: string; n: number }>(
          `SELECT owner_agent, COUNT(*) AS n FROM ${table} GROUP BY owner_agent`,
        ).all();
        for (const r of rows) {
          const entry = counts.get(r.owner_agent);
          if (entry) entry[field] = r.n;
        }
      };
      // 表名是封闭常量（DB-A 领域表），非外部输入。
      sum("episodes", "episodes");
      sum("subject_profiles", "subjects");
      sum("knowledge_items", "knowledgeItems");
      sum("reflections", "reflections");

      return { agents: [...counts.values()] };
    },
  };
}