// ═══════════════════════════════════════════════════════════════════════════
// mesh 侧只读批量核对（§18.6.3 两阶段悬挂检测的第二阶段）
//
// 记忆行只存裸 msg_id（无外键），悬挂引用必须经离线两阶段核对发现：本模块按批
// 查 `mesh_messages` 里仍存在的 id。打开 mesh.db **只读**连接（readonly +
// fileMustExist），绝不经 observer.messages——那是「展示给某 Agent 看」的按 to
// 过滤，不是审计用（§18.6.3）。
//
// 本文件因按表名引用 mesh_messages，落位 src/mesh/**（CI R2 闸门只允许
// mesh_ 表名 SQL 出现在本目录；角色侧代码经 helper 触达，不直接写 mesh SQL）。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";

/** 每批放入 IN (...) 的 id 数：远低于 SQLite 老版 999 变量的上限（§18.6.3）。 */
const CHUNK_SIZE = 300;

/** 只读批量核对：这批 mesh 消息 id 里哪些仍在 mesh 库中。
 *  打开 mesh.db 的只读连接（better-sqlite3 { readonly: true }），
 *  分批查 `SELECT id FROM mesh_messages WHERE id IN (...)`,返回存在的 id 子集。
 *  绝不经 observer.messages —— 那是「展示给某 Agent 看」的按 to 过滤，不是审计用（§18.6.3）。 */
export function meshMessageIdsExist(meshDbPath: string, ids: string[]): string[] {
  if (ids.length === 0) return [];

  const db = new Database(meshDbPath, { readonly: true, fileMustExist: true });
  try {
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db
        .prepare<string[], { id: string }>(
          `SELECT id FROM mesh_messages WHERE id IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of rows) found.add(row.id);
    }
    return [...found];
  } finally {
    db.close();
  }
}