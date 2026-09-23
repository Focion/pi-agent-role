// ═══════════════════════════════════════════════════════════════════════════
// close 前排残（§12.1 「全有全无」的运行时形态）
//
// mesh.close() 会等所有端点的在途投递（queued+delivered）收敛，上限
// handoffTimeoutMs（默认 30s）。角色运行时有一类**结构性残余**：observer
// （read-only，A1 恒不唤醒）与 silent/P2/P3 投递永远等不到 turn_end，状态停在
// delivered——它们本就是「进历史不进上下文」的只读记账（§7.6），但会让每次
// close() 白等整个 handoff 超时。
//
// 本模块在 runtime close 前把这些 delivered 残余经**宿主公开 API**
// `mesh.markConsumed(id)` 逐条结清（宿主簿记：关闭即视为已阅），让 close 毫秒级
// 返回。queued 行不动——那是「未交付」语义，交给 mesh 自身的截止等待。
//
// 按表名引用 mesh_deliveries，落位 src/mesh/**（CI R2 闸门）；列出 id 走只读
// 连接，写状态一律经 MeshHost 公开 API，不直接写库。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";

import type { MeshHost } from "./public-types.js";

/** 结清残余 delivered 投递，返回结清条数。 */
export async function consumeUndrainedDeliveries(
  mesh: MeshHost,
  meshDbPath: string,
): Promise<number> {
  const db = new Database(meshDbPath, { readonly: true, fileMustExist: true });
  let ids: string[];
  try {
    const rows = db
      .prepare<[], { id: string }>(
        "SELECT id FROM mesh_deliveries WHERE state = 'delivered'",
      )
      .all() as Array<{ id: string }>;
    ids = rows.map((r) => r.id);
  } finally {
    db.close();
  }
  for (const id of ids) await mesh.markConsumed(id);
  return ids.length;
}
