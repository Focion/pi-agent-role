// ═══════════════════════════════════════════════════════════════════════════
// P4 · 6.2 自省流成本两段拼接排除（§20.2.4）
//
// 双库各临建一份：DB-A 走 openRoleDb（真实 DDL，插 agents 映射行），DB-B 用最小
// mesh_messages / mesh_deliveries（两段拼接只用这三张表 + 三列口径）。断言：
//   E1 先过滤再求和（自省流被排除，不进对话口径）；
//   E2 只查 agents 表（不是 :reflect 后缀）；
//   E4 未归因 accountId 显式列出（@system）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openRoleDb } from "../src/db/db.js";
import { costMetricsExcludingReflect } from "../src/inspect/cost.js";

const cleanups: string[] = [];
function tmpdirTracked(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-role-cost-"));
  cleanups.push(d);
  return d;
}
afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

describe("P4 成本排除（§20.2.4）", () => {
  it("两段拼接：自省流不入对话口径，@system 显式未归因", () => {
    const dir = tmpdirTracked();
    const roleDb = openRoleDb(join(dir, "role-agent.db"));

    // DB-A：一个角色 + 它的自省流映射。
    roleDb.db
      .prepare(
        `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at,
                             mesh_account_id, mesh_reflect_account_id)
         VALUES (?, 'role', 'x', ?, 'active', ?, ?, ?)`,
      )
      .run("ag-stu", "0".repeat(64), "2026-01-01T00:00:00.000Z", "acct-stu", "acct-stu:reflect");

    // DB-B：最小两表 + 四条投递 + 两条消息（都在核对窗内）。
    const meshDbPath = join(dir, "mesh.db");
    const mesh = new Database(meshDbPath);
    mesh.exec(`CREATE TABLE mesh_messages (id TEXT PRIMARY KEY, from_account TEXT, routed_at TEXT)`);
    mesh.exec(
      `CREATE TABLE mesh_deliveries (
         id TEXT PRIMARY KEY, message_id TEXT, account_id TEXT, grade TEXT, woke INTEGER, path TEXT)`,
    );
    const routedAt = "2026-01-01T12:00:00.000Z";
    const insMsg = mesh.prepare("INSERT INTO mesh_messages (id, from_account, routed_at) VALUES (?, ?, ?)");
    insMsg.run("m-a", "acct-stu", routedAt); // 对话消息（角色发出）
    insMsg.run("m-b", "acct-stu:reflect", routedAt); // 自省 cue（自省流发出）

    const insDel = mesh.prepare(
      "INSERT INTO mesh_deliveries (id, message_id, account_id, grade, woke, path) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insDel.run("d1", "m-a", "acct-stu", "steer", 0, "P2"); // 角色内投递（计入对话）
    insDel.run("d2", "m-a", "acct-stu:reflect", "steer", 1, "P1"); // 自省流（排除）
    insDel.run("d3", "m-b", "acct-stu:reflect", "followUp", 1, "P1"); // 自省流（排除）
    insDel.run("d4", "m-a", "@system", "silent", 0, "P3"); // 系统账号（未归因，计入 + 列出）
    mesh.close();

    const m = costMetricsExcludingReflect(roleDb.db, meshDbPath, { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" });

    // 对话口径：deliveries = d1 + d4（d2/d3 排除）；messages = m-a（m-b 排除）。
    expect(m.deliveriesTotal).toBe(2);
    expect(m.messagesTotal).toBe(1);
    expect(m.silentRate).toBeCloseTo(0.5); // silent = d4 一条 / 2
    expect(m.wakePerMessage).toBe(0); // 对话口径下无唤醒
    expect(m.excludedReflectDeliveries).toBe(2);
    expect(m.excludedReflectMessages).toBe(1);
    expect(m.unattributedAccounts).toEqual(["@system"]);
    expect(m.caveats.length).toBeGreaterThan(0);

    roleDb.db.close();
  });

  it("mesh 库缺失 → 安全零值，不抛（B2 降级）", () => {
    const dir = tmpdirTracked();
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    const m = costMetricsExcludingReflect(roleDb.db, join(dir, "missing.db"));
    expect(m.deliveriesTotal).toBe(0);
    expect(m.messagesTotal).toBe(0);
    expect(m.unattributedAccounts).toEqual([]);
    roleDb.db.close();
  });
});