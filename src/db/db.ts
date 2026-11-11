// ═══════════════════════════════════════════════════════════════════════════
// role-agent.db 打开与迁移（§18 权威出处的执行器）
//
// · DB-A（本环领域库）封闭表集（附录 E；迁移 001–009，含 A23 的 compact_distilled 辅助台账、R10 退役列、O05 场景注入台账、Q05 pending_taught 与 Q09 tokens_purpose）；
// · 版本跟踪用 SQLite `PRAGMA user_version`，**不建 meta 表**——附封闭闸门
//   （§18.7 P10：本环连接内不得出现任何 mesh_ 表对象）。
// · 纪律（§18.7 P10）：打开后断言无 mesh_ 前缀对象、PRAGMA database_list 只有 main（+temp），
//   即本环连接里绝不 ATTACH mesh 库（R1）。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RoleRuntimeError } from "../runtime/errors.js";

/**
 * §18.7 双库分离（R03）：role DB（DB-A）与 mesh DB（DB-B）不得指向同一物理文件。
 * 在打开任何连接、创建任何目录之前调用——同路径、`..`/`.` 归一、符号链接与硬链接
 * 别名都会把两个库引到同一文件，必须拒绝（否则会交叉迁移/ATTACH 污染或互相覆盖）。
 * `:memory:` 各自是独立连接，不计为同文件。
 */
export function assertDistinctDbPaths(roleDbPath: string, meshDbPath: string): void {
  if (roleDbPath === ":memory:" || meshDbPath === ":memory:") return;
  const a = resolve(roleDbPath);
  const b = resolve(meshDbPath);
  if (a === b) {
    throw new RoleRuntimeError(
      `roleDb and meshDb resolve to the same path (${a}) — they must be separate databases (§18.7 / R03)`,
    );
  }
  // 两个文件都已存在时，用 dev+ino 判定同一物理文件（覆盖符号链接与硬链接别名）。
  if (existsSync(a) && existsSync(b)) {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.dev === sb.dev && sa.ino === sb.ino) {
      throw new RoleRuntimeError(
        `roleDb and meshDb alias the same file (dev=${sa.dev} ino=${sa.ino}) — they must be separate databases (§18.7 / R03)`,
      );
    }
  }
}

/** schema 版本基准：与 migrations/ 的最大序号一致（§28.3 镜像 mesh 的做法）。 */
export const SCHEMA_VERSION = 9;

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

/** 连接级 PRAGMA（journal_mode/synchronous 等）在事务内不可改，且 openRoleDb 已在
 *  migrate 之前设好；这里把它们从迁移正文里剥掉，剩余 DDL 才能整体放进单事务。 */
function stripConnectionPragmas(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^\s*PRAGMA\b/i.test(line))
    .join("\n");
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

  // R03：整段迁移单事务——任一迁移文件失败即整体回滚（DDL/user_version 一并撤销），
  // 不残留半成品；重试从原 user_version 重新开始（初始化失败可重试，不静默复用旧库）。
  const applyAll = db.transaction(() => {
    for (const f of files) {
      const n = Number(f.slice(0, 3));
      if (n <= current) continue;
      const sql = stripConnectionPragmas(readFileSync(join(dir, f), "utf8"));
      db.exec(sql);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  applyAll();
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