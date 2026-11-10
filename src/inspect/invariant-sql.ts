// ═══════════════════════════════════════════════════════════════════════════
// 分区不变量 A1–A11 SQL 断言（§18.7.2）
//
// 11 条只读 SQL 断言，全部针对 DB-A（本环领域库），无跨库依赖。每条断言返回
// `{ id, assertion, count }` 三元组，count=0 即通过。断言之间独立执行——任一条
// 失败不中断其余断言。
//
// 分层纪律（§22.4 R1/R2）：本文件不 import `@pi/agent-mesh`，也不含 mesh_ 表名 SQL。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import type { RoleInvariantReport } from "../runtime/types.js";

interface Assertion {
  id: string;
  assertion: string;
  sql: string;
}

/**
 * A1–A11 的 11 条断言定义。每条都带 id、人类可读描述、以及只含 DB-A 表的 SQL。
 * SQL 必须返回单一标量 `bad`（越界行数），count=0 即通过。
 *
 * 注意：A1 的 9 路 UNION ALL 是刻意设计——每个子句独立计数，任一张表有问题都能定位。
 */
const ASSERTIONS: Assertion[] = [
  {
    id: "A1",
    assertion: "no cross-owner rows: all owner_agent columns reference existing agents",
    sql: `SELECT 'episodes' AS tbl, COUNT(*) AS bad FROM episodes WHERE owner_agent NOT IN (SELECT agent_id FROM agents)
UNION ALL SELECT 'subject_profiles', COUNT(*) FROM subject_profiles WHERE owner_agent NOT IN (SELECT agent_id FROM agents)
UNION ALL SELECT 'knowledge_items', COUNT(*) FROM knowledge_items WHERE owner_agent NOT IN (SELECT agent_id FROM agents)
UNION ALL SELECT 'reflections', COUNT(*) FROM reflections WHERE owner_agent NOT IN (SELECT agent_id FROM agents)
UNION ALL SELECT 'retrieval_log', COUNT(*) FROM retrieval_log WHERE owner_agent NOT IN (SELECT agent_id FROM agents)
UNION ALL SELECT 'state_writes', COUNT(*) FROM state_writes WHERE owner_agent NOT IN (SELECT agent_id FROM agents)
UNION ALL SELECT 'knowledge_events', COUNT(*) FROM knowledge_events WHERE owner_agent NOT IN (SELECT agent_id FROM agents)
UNION ALL SELECT 'memory_decisions', COUNT(*) FROM memory_decisions WHERE owner_agent NOT IN (SELECT agent_id FROM agents)
UNION ALL SELECT 'boundary_events', COUNT(*) FROM boundary_events WHERE owner_agent NOT IN (SELECT agent_id FROM agents)
UNION ALL SELECT 'facility_records', COUNT(*) FROM facility_records WHERE owner_agent NOT IN (SELECT agent_id FROM agents)`,
  },
  {
    id: "A2",
    assertion: "subject_profiles evidence never crosses owners",
    sql: `SELECT COUNT(*) AS bad
FROM subject_profiles p
JOIN json_each(COALESCE(p.evidence_json, '[]')) j
JOIN episodes e ON e.episode_id = json_extract(j.value, '$.episode_id')
WHERE e.owner_agent <> p.owner_agent`,
  },
  {
    id: "A2'",
    assertion: "episode_subjects must reference existing episodes",
    sql: `SELECT COUNT(*) AS bad FROM episode_subjects s
WHERE s.episode_id NOT IN (SELECT episode_id FROM episodes)`,
  },
  {
    id: "A3",
    assertion: "knowledge_events owner matches item owner",
    sql: `SELECT COUNT(*) AS bad
FROM knowledge_events ev
JOIN knowledge_items it ON it.kn_id = ev.kn_id
WHERE ev.owner_agent <> it.owner_agent`,
  },
  {
    id: "A4",
    assertion: "scenes have 1:1 conversation binding",
    sql: `SELECT COUNT(*) AS bad FROM (
  SELECT conversation_id FROM scenes
  WHERE conversation_id IS NOT NULL
  GROUP BY conversation_id HAVING COUNT(*) > 1
)`,
  },
  {
    id: "A5",
    assertion: "primary account ≠ reflect account",
    sql: `SELECT COUNT(*) AS bad FROM agents
WHERE mesh_reflect_account_id IS NOT NULL
  AND mesh_reflect_account_id = mesh_account_id`,
  },
  {
    id: "A6",
    assertion: "reflect account must not be any agent's primary account",
    sql: `SELECT COUNT(*) AS bad FROM agents a
WHERE a.mesh_reflect_account_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM agents b WHERE b.mesh_account_id = a.mesh_reflect_account_id)`,
  },
  {
    id: "A7",
    assertion: "no mesh_ tables in DB-A connection",
    sql: `SELECT COUNT(*) AS bad FROM sqlite_master WHERE name LIKE 'mesh_%'`,
  },
  {
    id: "A8",
    assertion: "deleted tables (scene_messages, sessions, session_entries) must not exist",
    sql: `SELECT COUNT(*) AS bad FROM sqlite_master
WHERE name IN ('scene_messages', 'sessions', 'session_entries')`,
  },
  {
    id: "A9",
    assertion: "bare-reference columns must not appear in UNIQUE indexes (except ux_scenes_conversation, idx_retrieval_once)",
    sql: `SELECT COUNT(*) AS bad FROM sqlite_master
WHERE type = 'index' AND sql LIKE '%UNIQUE%'
  AND (   sql LIKE '%source_msg_id%'
       OR sql LIKE '%source_session_id%'
       OR sql LIKE '%source_entry_id%'
       OR sql LIKE '%reflect_msg_id%'
       OR sql LIKE '%result_msg_id%'
       OR sql LIKE '%actor_account_id%'
       OR sql LIKE '%conversation_id%' )
  AND name NOT IN ('ux_scenes_conversation', 'idx_retrieval_once')`,
  },
  {
    id: "A10",
    assertion: "episode scene anchors must resolve to known scenes",
    sql: `SELECT COUNT(*) AS bad FROM episodes
WHERE scene_id IS NOT NULL
  AND scene_id NOT IN (SELECT scene_id FROM scenes)`,
  },
  {
    id: "A11",
    assertion: "retrieval_log with tokens>0 must carry card snapshot",
    sql: `SELECT COUNT(*) AS bad FROM retrieval_log
WHERE tokens_total > 0 AND (rendered_card IS NULL OR card_sha256 IS NULL)`,
  },
];

/**
 * 执行全部 A1–A11 断言（含 A2'），返回 RoleInvariantReport。
 * 每条断言独立执行——任一条失败不中断其余。
 *
 * @param db DB-A（本环领域库）连接句柄
 */
export function checkRoleInvariants(db: Database.Database): RoleInvariantReport {
  const violations: RoleInvariantReport["violations"] = [];

  for (const a of ASSERTIONS) {
    const rows = db.prepare<[], { bad?: number; tbl?: string }>(a.sql).all();
    for (const row of rows) {
      const count = row.bad ?? 0;
      if (count > 0) {
        const label = row.tbl ? `${a.id} [${row.tbl}]` : a.id;
        violations.push({ id: label, assertion: a.assertion, count });
      }
    }
  }

  return {
    ok: violations.length === 0,
    checked: ASSERTIONS.length,
    violations,
  };
}