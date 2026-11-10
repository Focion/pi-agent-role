// ═══════════════════════════════════════════════════════════════════════════
// T6 组：观测与成本（§21.3.6）—— 静态 + 功能双层
//
// 覆盖：
//   T6.1   计数器能力边界：全 src 无 mesh_counters 直读，唯一入口是 observer.counters
//   T6.2   E1「全程不碰计数器」：cost 排除代码既不读也不写计数器，先过滤再求和
//   T6.3   E2：排除只依赖 agents.mesh_reflect_account_id，绝不解析 :reflect 后缀
//   T6.5   段序 §20.2.5：mesh 侧分组（段一）必须先于本环映射（段二）读取
//   T6.11  E5：caveats 携带三条必需口径边界（下界 / 闲忙 / 保留期）
//   T6.12  E6：mesh 只读连接 + 全 src 无 mesh_ 表写操作
//   接线    deriveMeshCounters / buildCostView 把计数器快照 + 健康计数接上
//
// 分层纪律：本文件不 import @pi/agent-mesh（R1）；静态扫描走「剥注释」同 R5 门禁。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { openRoleDb } from "../../src/db/db.js";
import { costMetricsExcludingReflect } from "../../src/inspect/cost.js";
import { buildCostView, deriveMeshCounters } from "../../src/observe/cost-view.js";
import type { MeshCounterSnapshot } from "../../src/mesh/counters-lookup.js";
import { addMeshAnchor, installRolePairing } from "../helpers/pairing.js";

const srcDir = fileURLToPath(new URL("../../src", import.meta.url));

/** 剥注释（与 R5 门禁同形）：字符串/模板字面量里的内容不在此列，逐词匹配仍可靠。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function codeOf(rel: string): string {
  return stripComments(readFileSync(join(srcDir, rel), "utf8"));
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const cleanups: string[] = [];
function trackedDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-role-t6-"));
  cleanups.push(d);
  return d;
}

describe("T6 observability / cost (§21.3.6)", () => {
  afterAll(() => {
    for (const d of cleanups.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });

  // ── 计数器能力边界 ──────────────────────────────────────────────────────

  it("T6.1: no src file reads the mesh_counters table — counters surface only via observer", () => {
    for (const f of listTsFiles(srcDir)) {
      const rel = f.slice(srcDir.length + 1);
      expect(codeOf(rel), `${rel} reads mesh_counters directly`).not.toContain("mesh_counters");
      expect(codeOf(rel), `${rel} references mesh_ DML`).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?mesh_/);
    }
    // 唯一的计数器入口：counters-lookup 经 Observer.counters 读，而非直连表。
    expect(codeOf("mesh/counters-lookup.ts")).toContain("observer.counters");
  });

  it("T6.1: counters-lookup reads a fixed 9-name whitelist (7 B-group + 2 health)", () => {
    const code = codeOf("mesh/counters-lookup.ts");
    for (const n of [
      "messages_total",
      "deliveries_total",
      "wake_per_message_idle",
      "wake_per_message_busy",
      "verbatim_copies",
      "silent_grade",
      "cold_hit",
      "policy_degraded",
      "invariant_violated",
    ]) {
      expect(code, `missing counter ${n}`).toContain(`"${n}"`);
    }
  });

  // ── E1/E2/E5/E6 + 段序 ──────────────────────────────────────────────────

  it("T6.2: cost exclusion never reads or writes counters (E1)", () => {
    const code = codeOf("inspect/cost.ts");
    expect(code).not.toContain("mesh_counter");
    expect(code).not.toContain("counters");
    expect(code).not.toContain("bumpCounter");
    // 先过滤再求和：reflect 行 `continue` 跳过，绝不求和后相减（无 `- excluded` 减法）。
    expect(code).toContain("continue;");
    expect(code).not.toMatch(/-\s*excludedReflect/);
  });

  it("T6.5: mesh grouping (段一) read before role mapping (段二) — §20.2.5 direction safety", () => {
    const code = codeOf("inspect/cost.ts");
    const meshGroup = code.indexOf("meshCostGroups(");
    const roleMap = code.indexOf("SELECT mesh_reflect_account_id");
    expect(meshGroup).toBeGreaterThanOrEqual(0);
    expect(roleMap).toBeGreaterThanOrEqual(0);
    expect(meshGroup).toBeLessThan(roleMap);
  });

  it("T6.12: mesh lookups open read-only; no src file writes mesh_ tables (E6)", () => {
    for (const name of ["cost-lookup.ts", "timeline-lookup.ts", "dangling-lookup.ts"]) {
      const code = codeOf(`mesh/${name}`);
      expect(code, `${name} opens mesh db read-only`).toContain("readonly: true");
      expect(code, `${name} requires mesh file to exist`).toContain("fileMustExist: true");
    }
  });

  // ── E2 无后缀依赖 ──────────────────────────────────────────────────────

  it("T6.3: exclusion keys on agents.mesh_reflect_account_id, never a :reflect suffix (E2)", () => {
    const dir = trackedDir();
    const roleDb = openRoleDb(join(dir, "role-agent.db"));

    // reflect account「audit-7」不含 :reflect 后缀——排除仍必须命中。
    roleDb.db
      .prepare(
        `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at,
                             mesh_account_id, mesh_reflect_account_id)
         VALUES (?, 'role', 'x', ?, 'active', ?, ?, ?)`,
      )
      .run("ag", "0".repeat(64), "2026-01-01T00:00:00.000Z", "acct-main", "audit-7");
    installRolePairing(roleDb.db); // R33：配对标识 + agents.mesh_instance_tag

    const meshDbPath = join(dir, "mesh.db");
    const mesh = new Database(meshDbPath);
    mesh.exec(`CREATE TABLE mesh_messages (id TEXT PRIMARY KEY, from_account TEXT, routed_at TEXT)`);
    mesh.exec(
      `CREATE TABLE mesh_deliveries (
         id TEXT PRIMARY KEY, message_id TEXT, account_id TEXT, grade TEXT, woke INTEGER, path TEXT)`,
    );
    const routedAt = "2026-01-01T12:00:00.000Z";
    const insMsg = mesh.prepare("INSERT INTO mesh_messages (id, from_account, routed_at) VALUES (?, ?, ?)");
    insMsg.run("m-main", "acct-main", routedAt);
    insMsg.run("m-audit", "audit-7", routedAt);
    const insDel = mesh.prepare(
      "INSERT INTO mesh_deliveries (id, message_id, account_id, grade, woke, path) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insDel.run("d1", "m-main", "acct-main", "steer", 0, "P1");
    insDel.run("d2", "m-main", "audit-7", "steer", 1, "P1"); // reflect 账号收到
    addMeshAnchor(mesh); // R33：锚点账号，配对成立
    mesh.close();

    const m = costMetricsExcludingReflect(roleDb.db, meshDbPath, {
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-02T00:00:00.000Z",
    });

    // 不解析后缀：audit-7 仍被排除。
    expect(m.excludedReflectDeliveries).toBe(1);
    expect(m.excludedReflectMessages).toBe(1);
    expect(m.deliveriesTotal).toBe(1);
    expect(m.messagesTotal).toBe(1);
    expect(m.unattributedAccounts).toEqual([]);

    roleDb.db.close();
  });

  // ── E5 caveats ─────────────────────────────────────────────────────────

  it("T6.11: cost caveats carry the 3 required口径 boundaries (E5) + E3 note", () => {
    const dir = trackedDir();
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    // B2 降级路径同样返回完整 caveats（caveats 先于 existsSync 判定组装）。
    const m = costMetricsExcludingReflect(roleDb.db, join(dir, "missing.db"));
    expect(m.caveats.length).toBeGreaterThanOrEqual(3);
    const joined = m.caveats.join("\n");
    expect(joined).toContain("下界"); // ① 原文份数是 P1 下界
    expect(joined).toContain("闲/忙"); // ② 唤醒闲/忙不可分
    expect(joined).toContain("保留期"); // ③ 只在保留期内有效
    roleDb.db.close();
  });

  // ── 计数器接线 ─────────────────────────────────────────────────────────

  it("deriveMeshCounters: raw counters → §20.3.3 derived rates", () => {
    const snapshot: MeshCounterSnapshot = {
      messagesTotal: 100,
      deliveriesTotal: 200,
      wakePerMessageIdle: 10,
      wakePerMessageBusy: 5,
      verbatimCopies: 40,
      silentGrade: 60,
      coldHit: 20,
      policyDegraded: 3,
      invariantViolated: 7,
    };
    const block = deriveMeshCounters(snapshot);
    expect(block.messagesTotal).toBe(100);
    expect(block.deliveriesTotal).toBe(200);
    expect(block.wakeIdle).toBe(10);
    expect(block.wakeBusy).toBe(5);
    expect(block.verbatimCopies).toBe(40);
    expect(block.derived.wakePerMessage).toBeCloseTo(15 / 100);
    expect(block.derived.wakePerMessageIdle).toBeCloseTo(10 / 100);
    expect(block.derived.wakePerMessageBusy).toBeCloseTo(5 / 100);
    expect(block.derived.verbatimPerMessage).toBeCloseTo(40 / 100);
    expect(block.derived.silentRate).toBeCloseTo(60 / 200);
    expect(block.derived.verbatimRate).toBeCloseTo(40 / 200);
    expect(block.derived.coldHitRate).toBeCloseTo(20 / 200);
  });

  it("deriveMeshCounters: missing snapshot / zero denominators → null rates, no division by zero", () => {
    const block = deriveMeshCounters(undefined);
    expect(block.messagesTotal).toBe(0);
    expect(block.deliveriesTotal).toBe(0);
    expect(block.derived.wakePerMessage).toBeNull();
    expect(block.derived.silentRate).toBeNull();
    expect(block.derived.coldHitRate).toBeNull();
  });

  it("buildCostView: injected snapshot wires meshCounters + health counters", () => {
    const dir = trackedDir();
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    const snapshot: MeshCounterSnapshot = {
      messagesTotal: 100,
      deliveriesTotal: 200,
      wakePerMessageIdle: 10,
      wakePerMessageBusy: 5,
      verbatimCopies: 40,
      silentGrade: 60,
      coldHit: 20,
      policyDegraded: 3,
      invariantViolated: 7,
    };
    // mesh db 缺失（B2）：meshCounters 段来自快照而非 mesh 库，证明接线不为零值占位。
    const view = buildCostView(roleDb.db, join(dir, "missing.db"), { meshCounters: snapshot });
    expect(view.meshCounters.messagesTotal).toBe(100);
    expect(view.meshCounters.derived.silentRate).toBeCloseTo(60 / 200);
    expect(view.health.policyDegradedEvents).toBe(3);
    expect(view.health.invariantViolatedEvents).toBe(7);
    roleDb.db.close();
  });
});