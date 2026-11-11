// ═══════════════════════════════════════════════════════════════════════════
// O01 · 蓝本谱系导出（§6.4）
//
// 验证：从已运行 Agent 的可信成长状态导出「谱系 + 隐私受控」的新蓝本，不覆盖来源蓝本。
//   1. 内容分级：skills/specialties 缺省导出；social/shadow 显式 include 才导出；
//   2. 谱系：derivedFrom = 父蓝本 id，generation 递增，blueprintHash 稳定，记录来源 Agent；
//   3. 来源蓝本逐字节不变（导出是 create，不是 write）；
//   4. 消费（起跑）：用新蓝本创建的 Agent 经 knowledge_boundaries 种子继承知识话题；
//   5. social 脱敏：同伴 agent id → 角色泛称，导出文件里不再出现具体 id；
//   6. 净化断言：shadow 中同伴指称 → PEER_AGENT_ID_PRESENT，不产出蓝本。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { parseYamlText } from "../src/compile/yaml.js";
import { BlueprintExportError } from "../src/runtime/errors.js";
import { createRuntimeInternals } from "../src/runtime/runtime.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";
import { createRoleAgent, writeRoleBlueprint } from "./helpers/role-agents.js";

async function setup(): Promise<{ rt: RuntimeInternals; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-o01-"));
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

function seedKnowledge(dir: string, owner: string): void {
  const db = openDb(dir);
  const ins = db.prepare(
    `INSERT INTO knowledge_items (kn_id, owner_agent, topic, claim, mastery, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(`kn-${owner}-1`, owner, "能量守恒", "孤立系统总能量守恒", "mastered", "2026-11-07T00:00:00.000Z", "2026-11-07T00:00:00.000Z");
  ins.run(`kn-${owner}-2`, owner, "动量守恒", "外力为零时动量守恒", "heard", "2026-11-07T00:00:00.000Z", "2026-11-07T00:00:00.000Z");
  db.close();
}

function seedSocial(dir: string, owner: string, peerId: string): void {
  const db = openDb(dir);
  db.prepare(
    `INSERT INTO subject_profiles (owner_agent, subject_type, subject_id, impression, valence, closeness, trust, episode_count, updated_at)
     VALUES (?, 'person', ?, ?, 0.3, 0.5, 0.4, 1, ?)`,
  ).run(owner, peerId, `${peerId} 每次抢答都比我快`, "2026-11-07T00:00:00.000Z");
  db.close();
}

function seedShadow(dir: string, owner: string, gist: string): void {
  const db = openDb(dir);
  db.prepare(
    `INSERT INTO reflections (reflection_id, owner_agent, trigger, status, output_json, started_at)
     VALUES (?, ?, 'manual', 'done', ?, ?)`,
  ).run(`ref-${owner}-1`, owner, JSON.stringify({ selfInsights: [{ gist, detail: "自省细节", salience: 0.6 }] }), "2026-11-07T00:00:00.000Z");
  db.close();
}

describe("O01 蓝本谱系导出（§6.4）", () => {
  it("缺省导出 skills/specialties；谱系正确；来源蓝本不变；新 Agent 起跑", async () => {
    const { rt, dir } = await setup();
    try {
      const blueprint = writeRoleBlueprint(dir, "role");
      await createRoleAgent(rt, blueprint, "ag-src", "源学生");
      await createRoleAgent(rt, blueprint, "ag-peer", "同伴");
      seedKnowledge(dir, "ag-src");
      seedSocial(dir, "ag-src", "ag-peer");
      seedShadow(dir, "ag-src", "我最近更容易专注了");

      const res = await rt.agents.exportAsBlueprint({ agentId: "ag-src", blueprintId: "role-v1" });

      expect(res.blueprintId).toBe("role-v1");
      expect(res.lineage.derivedFrom).toBe("role");
      expect(res.lineage.generation).toBe(1);
      expect(res.lineage.derivedFromAgent?.agentId).toBe("ag-src");
      expect(res.lineage.derivedFromAgent?.promptVersion).toBeTruthy();
      expect(res.lineage.blueprintHash).toMatch(/^[0-9a-f]{64}$/);

      // 来源蓝本未被改写（导出是 create，不是 write）。
      const srcManifest = parseYamlText<{ identity?: { id?: string } }>(
        readFileSync(join(dir, "templates", "role", "manifest.yaml"), "utf8"),
        "src-manifest",
      );
      expect(srcManifest.identity?.id).toBe("id-role");

      // 新蓝本目录：skills/specialties 有，social/shadow 无（缺省不导出）。
      const target = join(dir, "templates", "identities", "role-v1");
      expect(existsSync(join(target, "skills.yaml"))).toBe(true);
      expect(existsSync(join(target, "specialties.yaml"))).toBe(true);
      expect(existsSync(join(target, "social.yaml"))).toBe(false);
      expect(existsSync(join(target, "shadow.yaml"))).toBe(false);

      const skills = parseYamlText<{ skills: Array<{ topic: string; mastery: string }> }>(
        readFileSync(join(target, "skills.yaml"), "utf8"),
        "skills",
      );
      expect(skills.skills.map((s) => s.topic).sort()).toEqual(["动量守恒", "能量守恒"]);

      const specialties = parseYamlText<{ specialties: Array<{ topic: string }> }>(
        readFileSync(join(target, "specialties.yaml"), "utf8"),
        "specialties",
      );
      expect(specialties.specialties.map((s) => s.topic)).toEqual(["能量守恒"]);

      // 消费（起跑）：用新蓝本创建 Agent，知识话题经 knowledge_boundaries 种子继承为 heard。
      await createRoleAgent(rt, "templates/identities/role-v1", "ag-child", "子学生");
      const db = openDb(dir);
      const rows = db.prepare("SELECT topic, mastery FROM knowledge_items WHERE owner_agent = 'ag-child' ORDER BY topic").all() as Array<{ topic: string; mastery: string }>;
      expect(rows.map((r) => r.topic)).toEqual(["动量守恒", "能量守恒"]);
      expect(rows.every((r) => r.mastery === "heard")).toBe(true);
      db.close();
    } finally {
      await rt.close();
    }
  });

  it("social 显式 include 走脱敏（同伴 id → 角色泛称）", async () => {
    const { rt, dir } = await setup();
    try {
      const blueprint = writeRoleBlueprint(dir, "role");
      await createRoleAgent(rt, blueprint, "ag-src", "源学生");
      await createRoleAgent(rt, blueprint, "ag-peer", "同伴");
      seedSocial(dir, "ag-src", "ag-peer");

      await rt.agents.exportAsBlueprint({ agentId: "ag-src", blueprintId: "role-social", include: ["social"] });

      const social = parseYamlText<{ acquaintances: Array<{ subject_id: string; impression: string }> }>(
        readFileSync(join(dir, "templates", "identities", "role-social", "social.yaml"), "utf8"),
        "social",
      );
      const raw = readFileSync(join(dir, "templates", "identities", "role-social", "social.yaml"), "utf8");
      expect(raw).not.toContain("ag-peer");
      expect(social.acquaintances[0]!.subject_id).toBe("一位同学·1");
      expect(social.acquaintances[0]!.impression).not.toContain("ag-peer");
    } finally {
      await rt.close();
    }
  });

  it("shadow 含同伴指称 → PEER_AGENT_ID_PRESENT，不产出蓝本", async () => {
    const { rt, dir } = await setup();
    try {
      const blueprint = writeRoleBlueprint(dir, "role");
      await createRoleAgent(rt, blueprint, "ag-src", "源学生");
      await createRoleAgent(rt, blueprint, "ag-peer", "同伴");
      seedShadow(dir, "ag-src", "我发现 ag-peer 每次抢答都比我快");

      await expect(
        rt.agents.exportAsBlueprint({ agentId: "ag-src", blueprintId: "role-shadow", include: ["shadow"] }),
      ).rejects.toThrow(BlueprintExportError);
      // 失败不产出蓝本（catch 清理自己刚创建的目录）。
      expect(existsSync(join(dir, "templates", "identities", "role-shadow"))).toBe(false);

      await expect(
        rt.agents.exportAsBlueprint({ agentId: "ag-src", blueprintId: "role-shadow", include: ["shadow"] }),
      ).rejects.toMatchObject({
        violations: [{ code: "PEER_AGENT_ID_PRESENT" }],
      });
    } finally {
      await rt.close();
    }
  });
});