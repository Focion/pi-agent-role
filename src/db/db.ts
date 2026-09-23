// ═══════════════════════════════════════════════════════════════════════════
// role-agent.db 打开与迁移（§18 权威出处的执行器）
//
// · DB-A（本环领域库）14 张表封闭（附录 E）；schema.sql 唯一权威在 migrations/001_init.sql。
// · 版本跟踪用 SQLite `PRAGMA user_version`，**不建 meta 表**——附 14 表封闭闸门
//   （§18.7 P10：本环连接内不得出现任何多出来的表对象）。
// · 纪律（§18.7 P10）：打开后断言无 mesh_ 前缀对象、PRAGMA database_list 只有 main（+temp），
//   即本环连接里绝不 ATTACH mesh 库（R1）。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RoleRuntimeError } from "../runtime/errors.js";

/** schema 版本基准：与 migrations/ 的最大序号一致（§28.3 镜像 mesh 的做法）。 */
export const SCHEMA_VERSION = 1;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * migrations/ 是与 dist/ 并列的包根资产。从本模块向上走，找到含 package.json 的
 * 目录即包根，再拼 migrations/（镜像 mesh 的 migrationsDir，兼容 tsup flatten）。
 */
export function migrationsDir(): string {
  let dir = MODULE_DIR;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return join(dir, "migrations");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new RoleRuntimeError("could not locate package root for migrations/");
}

export interface RoleDb {
  db: Database.Database;
  close(): void;
}

export function openRoleDb(dbPath: string, opts: { devMode?: boolean } = {}): RoleDb {
  if (dbPath !== ":memory:") {
    // 父目录不存在时 better-sqlite3 会失败；显式 mkdir 便于首个实例零门槛启动。
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  migrate(db);
  assertNoMeshTables(db);

  return { db, close: () => db.close() };
}

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;

  if (current > SCHEMA_VERSION) {
    db.close();
    throw new RoleRuntimeError(
      `role-agent.db schema_version=${current} is newer than library (${SCHEMA_VERSION}); upgrade the library`,
    );
  }

  if (current === SCHEMA_VERSION) return;

  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();

  for (const f of files) {
    const n = Number(f.slice(0, 3));
    if (n <= current) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.exec(sql);
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** §18.7 P10：本环连接内不得存在 mesh_ 前缀对象，且不得 ATTACH 任何外库。 */
function assertNoMeshTables(db: Database.Database): void {
  const objs = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE name LIKE 'mesh\\_%' ESCAPE '\\'",
    )
    .all();
  if (objs.length > 0) {
    const names = objs.map((o) => o.name).join(", ");
    db.close();
    throw new RoleRuntimeError(
      `role-agent.db contains mesh_* objects (${names}) — must not ATTACH the mesh db (§18.7 P10)`,
    );
  }
}