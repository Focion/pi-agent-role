// ═══════════════════════════════════════════════════════════════════════════
// mesh 侧只读成本分组（§20.2.4 两段拼接的第一段）
//
// 自省成本要排除，唯一正确做法是放弃计数器（23 个计数器无标签，按小时分桶），改从
// `mesh_deliveries` / `mesh_messages` 重算分子分母。这里按 account_id 分组出原始量，
// **不做任何过滤**——「哪些是自省流」这个知识只在本环 agents 表里，两段拼接在
// src/inspect/cost.ts 完成。
//
// 打开 mesh.db 的只读连接（readonly + fileMustExist，与 dangling-lookup 同手法）。
// 本文件因按表名引用 mesh_deliveries / mesh_messages，落位 src/mesh/**（CI R2 闸门
// 只允许 mesh_ 表名 SQL 出现在本目录）。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";

/** 段一之 A：以投递为单位的分组量（静默率/原文率的分母 + 唤醒归属方）。 */
export interface MeshDeliveryGroup {
  accountId: string;
  deliveriesTotal: number;
  silentGrade: number;
  wakesTotal: number;
  p1Deliveries: number;
}

/** 段一之 B：以消息为单位的分组量（messages_total 的可归因版本）。 */
export interface MeshMessageGroup {
  accountId: string;
  messagesTotal: number;
}

export interface MeshCostGroups {
  deliveries: MeshDeliveryGroup[];
  messages: MeshMessageGroup[];
}

/**
 * mesh 侧原始分组量（§20.2.4 段一）。`since`/`until` 是 ISO 时间戳字面量，
 * 落在 mesh_messages.routed_at 上（字符串比较即可，ISO 同格式下字典序 = 时间序）。
 */
export function meshCostGroups(meshDbPath: string, since: string, until: string): MeshCostGroups {
  const db = new Database(meshDbPath, { readonly: true, fileMustExist: true });
  try {
    const deliveries = db
      .prepare<{ since: string; until: string }, MeshDeliveryGroup>(
        `SELECT d.account_id                                        AS accountId,
                COUNT(*)                                            AS deliveriesTotal,
                SUM(CASE WHEN d.grade = 'silent' THEN 1 ELSE 0 END) AS silentGrade,
                SUM(CASE WHEN d.woke  = 1        THEN 1 ELSE 0 END) AS wakesTotal,
                SUM(CASE WHEN d.path  = 'P1'     THEN 1 ELSE 0 END) AS p1Deliveries
           FROM mesh_deliveries d
           JOIN mesh_messages   m ON m.id = d.message_id
          WHERE m.routed_at >= :since AND m.routed_at < :until
          GROUP BY d.account_id`,
      )
      .all({ since, until });

    const messages = db
      .prepare<{ since: string; until: string }, MeshMessageGroup>(
        `SELECT m.from_account AS accountId,
                COUNT(*)       AS messagesTotal
           FROM mesh_messages m
          WHERE m.routed_at >= :since AND m.routed_at < :until
          GROUP BY m.from_account`,
      )
      .all({ since, until });

    return { deliveries, messages };
  } finally {
    db.close();
  }
}