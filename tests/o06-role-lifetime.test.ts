// ═══════════════════════════════════════════════════════════════════════════
// O06 · 知识/记忆长期巩固（角色生命周期内）
//
// 概念口径（2026-11-10 定稿）：role 不感知「学校/学期」这类上层领域概念；知识掌握度
// （knowledge_items）与学习记忆（episodes）基于角色（owner_agent）建立，随虚拟时钟衰减/
// 巩固，在角色消亡前不因场景收场而丢弃或重置。
//
// 验证四点：
//   1. 归属：episodes / knowledge_items 按 owner_agent 挂到角色上；
//   2. 长跨度只衰减不丢弃：跨 10 个虚拟日反复日终，行仍在、retention 单调衰减（非重置回初始）；
//   3. 批次幂等：每个新虚拟日各落一条日终台账，重复同日为 alreadyDone 空操作，不多不重；
//   4. 消亡边界：退役（retire）不丢；永久删除（deleteAgent）才清角色侧行。
//
// 断言落在 DB-A 的 episodes / knowledge_items / agent_state 台账，经 rt.dayEnd 直接触发多日
// 日终（不借场景 run 推进，保持虚拟时刻可控）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";
import { virtualHoursOf } from "../src/runtime/virtual-clock.js";
import { createRoleAgent, writeRoleBlueprint } from "./helpers/role-agents.js";

async function setup(): Promise<{ rt: RuntimeInternals; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-o06-"));
  const rt = (await createRuntimeInternals({
    root: dir,
    db: join(dir, "role-agent.db"),
    devMode: true,
    fake: { streamPort: true },
  })) as RuntimeInternals;
  return { rt, dir };
}

function openDb(dir: string): Database.Database {
  return new Database(join(dir, "role-agent.db"));
}

/** 物化一条学习记忆（fact 情节）。virtual_hours 固定为 W1D1T10，之后随日终逐日衰减。 */
function seedEpisode(dir: string, agentId: string): void {
  const db = openDb(dir);
  db.prepare(
    `INSERT INTO episodes (episode_id, owner_agent, kind, gist, virtual_ts, virtual_hours, real_ts, salience, retention, status)
     VALUES (?, ?, 'fact', ?, 'W1D1T10', ?, '2026-11-07T00:00:00.000Z', 0.9, 0.9, 'active')`,
  ).run("ep-o06-1", agentId, "教学知识点：能量守恒", virtualHoursOf("W1D1T10"));
  db.close();
}

/** 物化一条知识掌握度（heard，未练习）。last_practiced_vhours=0 使日终知识衰减立即生效。 */
function seedKnowledge(dir: string, agentId: string): void {
  const db = openDb(dir);
  db.prepare(
    `INSERT INTO knowledge_items (kn_id, owner_agent, topic, claim, mastery, confidence, retention, last_practiced_vhours, first_seen_at, updated_at)
     VALUES (?, ?, '能量守恒', '能量守恒定律', 'heard', 0.8, 1.0, 0, '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z')`,
  ).run("kn-o06-1", agentId);
  db.close();
}

describe("O06 知识/记忆长期巩固（角色生命周期内）", () => {
  it("跨 10 个虚拟日日终只衰减不丢弃；退役不丢、永久删除才清", async () => {
    const { rt, dir } = await setup();
    try {
      const blueprint = writeRoleBlueprint(dir, "role");
      await createRoleAgent(rt, blueprint, "ag-s1", "小明");

      seedEpisode(dir, "ag-s1");
      seedKnowledge(dir, "ag-s1");

      // 长跨度：10 个不同虚拟日逐日日终（虚拟周 D1..D7 循环；跨到 W2）。
      const days: string[] = [];
      for (let i = 0; i < 10; i++) {
        days.push(`W${Math.floor(i / 7) + 1}D${(i % 7) + 1}T10`);
      }
      for (const ts of days) {
        await rt.dayEnd.runForScene({ sceneId: "s1", agentIds: ["ag-s1"], virtualTs: ts });
      }

      const db = openDb(dir);
      // 批次幂等：10 个新虚拟日各落一条台账，不多不少。
      const ledgerN = (
        db.prepare(`SELECT COUNT(*) AS n FROM agent_state WHERE agent_id = ? AND key LIKE 'day_end:%'`).get("ag-s1") as { n: number }
      ).n;
      expect(ledgerN).toBe(10);

      // 记忆/知识行仍在（不因日终丢弃/重置），各恰好 1 行（不重复）。
      const epN = (db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE owner_agent = ?`).get("ag-s1") as { n: number }).n;
      const knN = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_items WHERE owner_agent = ?`).get("ag-s1") as { n: number }).n;
      expect(epN).toBe(1);
      expect(knN).toBe(1);

      // 衰减发生过（retention 低于初始），且行仍在——证明「衰减≠重置/丢弃」。
      const ep = db
        .prepare(`SELECT retention FROM episodes WHERE episode_id = 'ep-o06-1'`)
        .get() as { retention: number };
      const kn = db
        .prepare(`SELECT retention FROM knowledge_items WHERE kn_id = 'kn-o06-1'`)
        .get() as { retention: number };
      expect(ep.retention).toBeLessThan(0.9);
      expect(kn.retention).toBeLessThan(1.0);
      db.close();

      // 幂等：重复触发最早虚拟日 → alreadyDone，台账行数不变。
      const again = await rt.dayEnd.runForScene({ sceneId: "s1", agentIds: ["ag-s1"], virtualTs: "W1D1T10" });
      expect(again.ran).toHaveLength(1);
      expect(again.ran[0]!.alreadyDone).toBe(true);
      const db2 = openDb(dir);
      const ledgerN2 = (
        db2.prepare(`SELECT COUNT(*) AS n FROM agent_state WHERE agent_id = ? AND key LIKE 'day_end:%'`).get("ag-s1") as { n: number }
      ).n;
      expect(ledgerN2).toBe(10);
      db2.close();

      // 退役（retire）只改 status，不丢记忆/知识。
      rt.agents.retire("ag-s1");
      const db3 = openDb(dir);
      const epAfterRetire = (db3.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE owner_agent = ?`).get("ag-s1") as { n: number }).n;
      const knAfterRetire = (db3.prepare(`SELECT COUNT(*) AS n FROM knowledge_items WHERE owner_agent = ?`).get("ag-s1") as { n: number }).n;
      expect(epAfterRetire).toBe(1);
      expect(knAfterRetire).toBe(1);
      db3.close();

      // 永久删除（消亡）才清角色侧行。
      rt.agents.deleteAgent("ag-s1");
      const db4 = openDb(dir);
      const epAfterDelete = (db4.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE owner_agent = ?`).get("ag-s1") as { n: number }).n;
      const knAfterDelete = (db4.prepare(`SELECT COUNT(*) AS n FROM knowledge_items WHERE owner_agent = ?`).get("ag-s1") as { n: number }).n;
      const agAfterDelete = (db4.prepare(`SELECT COUNT(*) AS n FROM agents WHERE agent_id = ?`).get("ag-s1") as { n: number }).n;
      expect(epAfterDelete).toBe(0);
      expect(knAfterDelete).toBe(0);
      expect(agAfterDelete).toBe(0);
      db4.close();
    } finally {
      await rt.close();
    }
  });
});