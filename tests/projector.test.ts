// ═══════════════════════════════════════════════════════════════════════════
// R09 Projector（§6.2）：DB → 实例文件的纯、单向、幂等渲染器 + reconcile 手工导入
//
// 覆盖：
//   R09-1  reproject 渲染 identity/*.yaml（evolution/skills/specialties/social/shadow）；
//   R09-2  reproject 渲染 memory/*.md（short_term/long_term/subjects/<slug>.md）；
//   R09-3  幂等：无 DB 变更时重复 reproject 产生逐字节相同的文件；
//   R09-4  reconcile 把 evolution/skills/social 的手工改动审计后导入 DB，再重投影；
//   R09-5  shadow.yaml 单向不可回导：手工改动被重投影覆盖（不冒充导入）；
//   R09-6  不存在 / 无实例模板的 agent 抛错；
//   R09-7  subject_id 含越界字符时文件名被安全 slug 化，不产生路径穿越。
//
// 分层纪律：本文件不 import @pi/agent-mesh（R1）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openRoleDb } from "../src/db/db.js";
import { reconcile, reproject } from "../src/runtime/projector.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-projector-"));
  const db = openRoleDb(join(dir, "role-agent.db"));
  // 最小 agent 行：满足 reproject 的「存在 + identity_dir 非空」前导。
  db.db.prepare(
    `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, identity_dir, created_at)
     VALUES ('alice','role','/bp','h1','agents/alice/identity','2026-01-01T00:00:00.000Z')`,
  ).run();
  return {
    dir,
    db: db.db,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("R09 Projector（§6.2）", () => {
  it("R09-1: reproject renders identity template files from DB", () => {
    const { dir, db, cleanup } = setup();
    try {
      db.prepare(
        `INSERT INTO agent_state (agent_id, key, value_json, updated_at) VALUES
          ('alice','mood','"平静"','2026-01-01T00:00:00.000Z'),
          ('alice','mood_intensity','0.6','2026-01-01T00:00:00.000Z'),
          ('alice','energy','0.7','2026-01-01T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO knowledge_items (kn_id, owner_agent, topic, claim, mastery, first_seen_at, updated_at) VALUES
          ('k1','alice','受力分析','先画受力图','applied','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
          ('k2','alice','勾股定理','a²+b²=c²','mastered','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO subject_profiles (owner_agent, subject_type, subject_id, impression, valence, closeness, trust, updated_at)
         VALUES ('alice','person','ag-teacher-01','严谨但耐心',0.6,0.5,0.7,'2026-01-01T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO reflections (reflection_id, owner_agent, trigger, output_json, status, started_at)
         VALUES ('r1','alice','manual','{"selfInsights":[{"gist":"我总抢答","detail":"太急","salience":0.8}]}','done','2026-01-02T00:00:00.000Z')`,
      ).run();

      const res = reproject(db, dir, "alice");

      const read = (p: string) => readFileSync(join(dir, p), "utf8");
      expect(res.files).toContain("agents/alice/identity/evolution.yaml");
      expect(read("agents/alice/identity/evolution.yaml")).toContain("mood: 平静");
      expect(read("agents/alice/identity/evolution.yaml")).toContain("moodIntensity: 0.6");

      const skills = read("agents/alice/identity/skills.yaml");
      expect(skills).toContain("topic: 受力分析");
      expect(skills).toContain("topic: 勾股定理");

      const specialties = read("agents/alice/identity/specialties.yaml");
      expect(specialties).toContain("topic: 勾股定理");
      expect(specialties).not.toContain("topic: 受力分析"); // 只有 mastered 进 specialties

      const social = read("agents/alice/identity/social.yaml");
      expect(social).toContain("subject_id: ag-teacher-01");
      expect(social).toContain("impression: 严谨但耐心");

      const shadow = read("agents/alice/identity/shadow.yaml");
      expect(shadow).toContain("gist: 我总抢答");
    } finally {
      cleanup();
    }
  });

  it("R09-2: reproject renders memory projections（short_term/long_term/subjects）", () => {
    const { dir, db, cleanup } = setup();
    try {
      db.prepare(
        `INSERT INTO episodes (episode_id, owner_agent, kind, gist, detail, virtual_ts, virtual_hours, real_ts, status)
         VALUES ('e1','alice','event','老师讲了受力分析','分解重力','W3D1T14',542,'2026-01-01T00:00:00.000Z','active'),
                ('e2','alice','self','我以后先画图再算',NULL,'W4D2T3',713,'2026-01-02T00:00:00.000Z','consolidated')`,
      ).run();
      db.prepare(
        `INSERT INTO subject_profiles (owner_agent, subject_type, subject_id, impression, episode_count, updated_at)
         VALUES ('alice','self','self','我在缓慢进步',3,'2026-01-01T00:00:00.000Z'),
                ('alice','facility','fac-classroom-01','第三排的灯会闪',1,'2026-01-01T00:00:00.000Z')`,
      ).run();

      const res = reproject(db, dir, "alice");
      const read = (p: string) => readFileSync(join(dir, p), "utf8");

      const short = read("agents/alice/memory/short_term.md");
      expect(short).toContain("老师讲了受力分析");
      expect(short).toContain("细节：分解重力");
      expect(short).not.toContain("我以后先画图再算"); // consolidated 不进 short_term

      const long = read("agents/alice/memory/long_term.md");
      expect(long).toContain("我以后先画图再算");

      expect(res.files).toContain("agents/alice/memory/subjects/self.md");
      expect(res.files).toContain("agents/alice/memory/subjects/facility-fac-classroom-01.md");
      expect(read("agents/alice/memory/subjects/self.md")).toContain("我在缓慢进步");
      expect(read("agents/alice/memory/subjects/facility-fac-classroom-01.md")).toContain("第三排的灯会闪");
    } finally {
      cleanup();
    }
  });

  it("R09-3: idempotent — repeated reproject yields byte-identical files", () => {
    const { dir, db, cleanup } = setup();
    try {
      db.prepare(
        `INSERT INTO knowledge_items (kn_id, owner_agent, topic, claim, mastery, first_seen_at, updated_at)
         VALUES ('k1','alice','物理','F=ma','applied','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      ).run();
      const first = reproject(db, dir, "alice").files.map((p) => readFileSync(join(dir, p), "utf8")).join("\n\u0000");
      const second = reproject(db, dir, "alice").files.map((p) => readFileSync(join(dir, p), "utf8")).join("\n\u0000");
      expect(second).toBe(first);
    } finally {
      cleanup();
    }
  });

  it("R09-4: reconcile imports manual edits (evolution/skills/social) with audit, then reprojects", () => {
    const { dir, db, cleanup } = setup();
    try {
      db.prepare(
        `INSERT INTO agent_state (agent_id, key, value_json, updated_at) VALUES
          ('alice','mood','"平静"','2026-01-01T00:00:00.000Z'),
          ('alice','mood_intensity','0.5','2026-01-01T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO knowledge_items (kn_id, owner_agent, topic, claim, mastery, first_seen_at, updated_at)
         VALUES ('k1','alice','受力分析','先画受力图','applied','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO subject_profiles (owner_agent, subject_type, subject_id, impression, updated_at)
         VALUES ('alice','person','ag-teacher-01','严谨','2026-01-01T00:00:00.000Z')`,
      ).run();

      reproject(db, dir, "alice");

      // 手工改三个模板文件后再 reconcile。
      const evo = join(dir, "agents/alice/identity/evolution.yaml");
      writeFileSync(evo, readFileSync(evo, "utf8").replace("mood: 平静", "mood: 开心"), "utf8");
      const skills = join(dir, "agents/alice/identity/skills.yaml");
      writeFileSync(skills, readFileSync(skills, "utf8").replace("先画受力图", "先标出所有力"), "utf8");
      const social = join(dir, "agents/alice/identity/social.yaml");
      writeFileSync(social, readFileSync(social, "utf8").replace("严谨", "严谨但严格"), "utf8");

      const result = reconcile(db, dir, "alice");

      expect(result.imported).toContainEqual({ file: "evolution.yaml", field: "mood", from: "平静", to: "开心" });
      expect(result.imported).toContainEqual(
        expect.objectContaining({ file: "skills.yaml", field: "skills[受力分析].claim", from: "先画受力图", to: "先标出所有力" }),
      );
      expect(result.imported).toContainEqual(
        expect.objectContaining({ file: "social.yaml", field: "acquaintances[ag-teacher-01].impression", from: "严谨", to: "严谨但严格" }),
      );

      // DB 已更新。
      const moodRow = db.prepare("SELECT value_json FROM agent_state WHERE agent_id='alice' AND key='mood'").get() as { value_json: string };
      expect(JSON.parse(moodRow.value_json)).toBe("开心");
      const claimRow = db.prepare("SELECT claim FROM knowledge_items WHERE topic='受力分析'").get() as { claim: string };
      expect(claimRow.claim).toBe("先标出所有力");
      const personRow = db.prepare("SELECT impression FROM subject_profiles WHERE subject_id='ag-teacher-01'").get() as { impression: string };
      expect(personRow.impression).toBe("严谨但严格");

      // 审计行已写（actor='Projector', reason='manual'）。
      const audits = db.prepare("SELECT target, target_id, op, reason, actor FROM state_writes WHERE owner_agent='alice' ORDER BY real_ts").all() as Array<{
        target: string; target_id: string; op: string; reason: string | null; actor: string;
      }>;
      expect(audits.length).toBe(3);
      expect(audits.every((a) => a.reason === "manual" && a.actor === "Projector")).toBe(true);

      // 重投影后文件回到一致快照。
      expect(readFileSync(evo, "utf8")).toContain("mood: 开心");
    } finally {
      cleanup();
    }
  });

  it("R09-5: shadow.yaml is one-way — manual edits are overwritten, not imported", () => {
    const { dir, db, cleanup } = setup();
    try {
      db.prepare(
        `INSERT INTO reflections (reflection_id, owner_agent, trigger, output_json, status, started_at)
         VALUES ('r1','alice','manual','{"selfInsights":[{"gist":"原洞察"}]}','done','2026-01-02T00:00:00.000Z')`,
      ).run();
      reproject(db, dir, "alice");

      const shadow = join(dir, "agents/alice/identity/shadow.yaml");
      writeFileSync(shadow, readFileSync(shadow, "utf8").replace("原洞察", "被手改的洞察"), "utf8");

      const result = reconcile(db, dir, "alice");
      expect(result.imported).toHaveLength(0);
      expect(result.ignored).toContainEqual(
        expect.objectContaining({ file: "shadow.yaml", field: "self_insights" }),
      );
      // 重投影覆盖手工改动，回到 DB 权威值。
      expect(readFileSync(shadow, "utf8")).toContain("原洞察");
      expect(readFileSync(shadow, "utf8")).not.toContain("被手改的洞察");
    } finally {
      cleanup();
    }
  });

  it("R09-6: throws for missing agent / missing identity_dir", () => {
    const { dir, db, cleanup } = setup();
    try {
      expect(() => reproject(db, dir, "nobody")).toThrow(/agent not found/);
      db.prepare("UPDATE agents SET identity_dir = NULL WHERE agent_id='alice'").run();
      expect(() => reproject(db, dir, "alice")).toThrow(/no instance template/);
    } finally {
      cleanup();
    }
  });

  it("R09-7: unsafe subject_id is slugged, no path traversal", () => {
    const { dir, db, cleanup } = setup();
    try {
      db.prepare(
        `INSERT INTO subject_profiles (owner_agent, subject_type, subject_id, impression, updated_at)
         VALUES ('alice','person','npc:../../evil','阴影', '2026-01-01T00:00:00.000Z')`,
      ).run();
      const res = reproject(db, dir, "alice");
      // 文件名不含分隔符，且落在 subjects/ 目录内。
      const memFile = res.files.find((p) => p.startsWith("agents/alice/memory/subjects/") && p.includes("npc"));
      expect(memFile).toBeDefined();
      expect(memFile).not.toContain("..");
      expect(existsSync(join(dir, memFile!))).toBe(true);
      // 越界内容绝不能逃到 subjects/ 之外。
      expect(existsSync(join(dir, "agents", "alice", "memory", "evil.md"))).toBe(false);
      expect(existsSync(join(dir, "evil.md"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("R09-8: evolution.yaml preserves template static keys (growth_rules) on writeback", () => {
    const { dir, db, cleanup } = setup();
    try {
      // 实例模板里的 evolution.yaml 夹带静态配置（memory-policy 编译器会读 growth_rules）。
      const evoPath = join(dir, "agents/alice/identity/evolution.yaml");
      mkdirSync(join(dir, "agents/alice/identity"), { recursive: true });
      writeFileSync(evoPath, "mood: 平静\ngrowth_rules:\n  trustDeltaCap: 0.1\n", "utf8");
      // 运行期状态写回 mood（绝对值），静态键 growth_rules 必须原样保留。
      db.prepare(
        `INSERT INTO agent_state (agent_id, key, value_json, updated_at)
         VALUES ('alice','mood','"开心"','2026-01-01T00:00:00.000Z')`,
      ).run();

      reproject(db, dir, "alice");
      const after = readFileSync(evoPath, "utf8");
      expect(after).toContain("growth_rules:");
      expect(after).toContain("trustDeltaCap: 0.1");
      expect(after).toContain("mood: 开心");
      expect(after).not.toContain("mood: 平静");
    } finally {
      cleanup();
    }
  });
});