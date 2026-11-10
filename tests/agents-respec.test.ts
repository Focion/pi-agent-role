// ═══════════════════════════════════════════════════════════════════════════
// R10 · agents.respec / retire / restore / deleteAgent + inspect.checkMeshConsistency
//
// spec 版本/hash 漂移不得静默改变身份；身份字段变化拒绝、不自动迁移。非 mesh respec 只改
// mesh 不认识的部分并写新快照；mesh 投影漂移只在返回里报告（mesh 无 updateAccount）。
// 可恢复退役（restore）+ 永久删除（deleteAgent 只删 role 侧，保留 mesh 历史）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import { stringifyYaml } from "../src/compile/yaml.js";
import { parseYamlText } from "../src/compile/yaml.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";

/** 写一个最小身份蓝本（6 个冷启动文件齐整，满足 §5.1 严格校验）。 */
function writeBlueprint(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const files: [string, unknown][] = [
    [
      "manifest.yaml",
      {
        identity: { id: "id-respec-tm" },
        files: ["manifest", "personal", "constraints", "evolution", "narrative_voice", "agent_protocol"].map(
          (n) => ({ path: `${n}.yaml`, priority: "cold_start" }),
        ),
      },
    ],
    ["personal.yaml", { name: { full: "刘明涛" }, age: 15, gender: "male", role: "学生" }],
    ["constraints.yaml", { constraints: [{ id: "c1", text: "不说脏话", severity: "hard" }] }],
    ["evolution.yaml", { mood: "平静", moodIntensity: 0.5, energy: 0.8 }],
    ["narrative_voice.yaml", { default_mode: "平实" }],
    ["agent_protocol.yaml", { capabilities: ["语文", "讲故事"], initiate: ["chat"] }],
  ];
  for (const [name, data] of files) writeFileSync(join(dir, name), stringifyYaml(data));
}

/** 改写实例模板里某个 YAML 文件的一个顶层键（保留其余字段，模拟手工编辑或演进）。 */
function editInstanceYaml(root: string, agentId: string, file: string, mutate: (doc: Record<string, any>) => void): void {
  const p = join(root, "agents", agentId, "identity", file);
  const doc = parseYamlText<Record<string, any>>(readFileSync(p, "utf8"), p);
  mutate(doc);
  writeFileSync(p, stringifyYaml(doc), "utf8");
}

async function makeRuntime() {
  const root = mkdtempSync(join(tmpdir(), "pi-role-respec-"));
  writeBlueprint(join(root, "templates", "student"));
  const rt = (await createRuntimeInternals({
    root,
    db: join(root, "role-agent.db"),
    devMode: true,
    fake: { streamPort: true },
  })) as RuntimeInternals;
  return { root, rt };
}

describe("R10 agents.respec / retire / restore / deleteAgent (§4.6.2)", () => {
  it("非 mesh 字段变化：写新快照 + 审计，无 mesh 漂移", async () => {
    const { root, rt } = await makeRuntime();
    try {
      await rt.agents.create({ blueprint: "templates/student", agentId: "ag-s1" });
      const pre = new Database(join(root, "role-agent.db"));
      const beforeHash = (pre.prepare("SELECT spec_hash FROM agents WHERE agent_id = ?").get("ag-s1") as {
        spec_hash: string;
      }).spec_hash;
      pre.close();
      expect(beforeHash).toBeTruthy();

      // 改 constraints（mesh 不认识的部分）。
      editInstanceYaml(root, "ag-s1", "constraints.yaml", (doc) => {
        doc.constraints.push({ id: "c2", text: "要举手发言", severity: "soft" });
      });

      const r = await rt.agents.respec("ag-s1");
      expect(r.agentId).toBe("ag-s1");
      expect(r.promptVersion).toMatch(/^[0-9a-f]{64}$/);
      expect(r.specHashChanged).toBe(true);
      expect(r.pendingMeshDrift).toEqual([]);

      // 落库快照已更新。
      const probe = new Database(join(root, "role-agent.db"));
      try {
        const row = probe.prepare("SELECT spec_hash, retired_at FROM agents WHERE agent_id = ?").get("ag-s1") as {
          spec_hash: string;
          retired_at: string | null;
        };
        expect(row.spec_hash).not.toBe(beforeHash);
        expect(row.retired_at).toBeNull();
        // 审计流留痕 target='agent', op='respec'。
        const audit = probe.prepare("SELECT COUNT(*) AS c FROM state_writes WHERE owner_agent = ? AND op = 'respec'").get("ag-s1") as { c: number };
        expect(audit.c).toBe(1);
      } finally {
        probe.close();
      }
    } finally {
      await rt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("displayName 漂移：报告 FIELD_DRIFT 不静默迁移", async () => {
    const { root, rt } = await makeRuntime();
    try {
      await rt.agents.create({ blueprint: "templates/student", agentId: "ag-s2" });

      // 改 displayName（personal.name.full）→ mesh 认识但注册后不可改。
      editInstanceYaml(root, "ag-s2", "personal.yaml", (doc) => {
        doc.name.full = "刘明涛学长";
      });

      const r = await rt.agents.respec("ag-s2");
      expect(r.specHashChanged).toBe(true);
      const name = r.pendingMeshDrift.find((d) => d.field === "displayName");
      expect(name).toBeTruthy();
      expect(name!.from).toBe("刘明涛");
      expect(name!.to).toBe("刘明涛学长");
      // displayName 属 mesh 认识的字段：修复路径仍是 respec（migrateMeshIdentity 未实装，报告而非静默改现场）。
      expect(name!.repair).toBe("respec");
    } finally {
      await rt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("identityId 漂移：拒绝重编译，不自动迁移", async () => {
    const { root, rt } = await makeRuntime();
    try {
      await rt.agents.create({ blueprint: "templates/student", agentId: "ag-s3" });

      editInstanceYaml(root, "ag-s3", "manifest.yaml", (doc) => {
        doc.identity.id = "id-respec-changed";
      });

      await expect(rt.agents.respec("ag-s3")).rejects.toThrow(/identity field changed/);
    } finally {
      await rt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("退役→恢复→删除：status 可逆，deleteAgent 只删 role 侧行", async () => {
    const { root, rt } = await makeRuntime();
    try {
      await rt.agents.create({ blueprint: "templates/student", agentId: "ag-s4" });

      // 退役（幂等）。
      const ret = rt.agents.retire("ag-s4");
      expect(ret.status).toBe("retired");
      expect(ret.alreadyRetired).toBe(false);
      expect(ret.retiredAt).toBeTruthy();
      const again = rt.agents.retire("ag-s4");
      expect(again.alreadyRetired).toBe(true);

      // 退役后不可 respec。
      await expect(rt.agents.respec("ag-s4")).rejects.toThrow(/retired/);

      // 恢复。
      const res = rt.agents.restore("ag-s4");
      expect(res.status).toBe("active");

      // 永久删除：agents + agent_specs + agent_state 全清，实例目录也清除。
      const del = rt.agents.deleteAgent("ag-s4");
      expect(del.deleted).toBe(true);
      expect(existsSync(join(root, "agents", "ag-s4"))).toBe(false);

      const probe = new Database(join(root, "role-agent.db"));
      try {
        const n = probe.prepare("SELECT COUNT(*) AS c FROM agents WHERE agent_id = ?").get("ag-s4") as { c: number };
        expect(n.c).toBe(0);
        const specs = probe.prepare("SELECT COUNT(*) AS c FROM agent_specs WHERE agent_id = ?").get("ag-s4") as { c: number };
        expect(specs.c).toBe(0);
        const st = probe.prepare("SELECT COUNT(*) AS c FROM agent_state WHERE agent_id = ?").get("ag-s4") as { c: number };
        expect(st.c).toBe(0);
      } finally {
        probe.close();
      }

      // 删除的 agent 再次操作 → 不存在。
      expect(() => rt.agents.retire("ag-s4")).toThrow(/not found/);
    } finally {
      await rt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R10 inspect.checkMeshConsistency (§4.6.1)", () => {
  it("一致性报告：干净 Agent 无 findings，标注未核对项", async () => {
    const { root, rt } = await makeRuntime();
    try {
      await rt.agents.create({ blueprint: "templates/student", agentId: "ag-c1" });
      const rep = await rt.inspect.checkMeshConsistency();
      // 未核对项如实标注，不以 0 占位。
      expect(rep.notChecked.length).toBeGreaterThan(0);
      const mine = rep.agents.find((a) => a.agentId === "ag-c1");
      expect(mine).toBeUndefined(); // 干净 agent 无 findings
    } finally {
      await rt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FIELD_DRIFT：注册快照 vs 当前 spec 投影不一致（改 displayName 后）", async () => {
    const { root, rt } = await makeRuntime();
    try {
      await rt.agents.create({ blueprint: "templates/student", agentId: "ag-c2" });
      editInstanceYaml(root, "ag-c2", "personal.yaml", (doc) => {
        doc.name.full = "刘明涛（改名后）";
      });
      const rep = await rt.inspect.checkMeshConsistency();
      const mine = rep.agents.find((a) => a.agentId === "ag-c2");
      expect(mine).toBeTruthy();
      const fd = mine!.findings.find((f) => f.code === "FIELD_DRIFT" && f.field === "displayName");
      expect(fd).toBeTruthy();
      expect(fd!.actual).toBe("刘明涛（改名后）");
    } finally {
      await rt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("MAPPING_MISSING：mesh_account_id 漂移（≠ agent_id）记 manual；registering 记疑似缺失", async () => {
    const { root, rt } = await makeRuntime();
    const dbPath = join(root, "role-agent.db");
    try {
      await rt.agents.create({ blueprint: "templates/student", agentId: "ag-c3" });
      // 手工把 mesh_account_id 改成别的（改 id 等于换身份，manual）——不要 reshape 成非法跨库态。
      const w = new Database(dbPath);
      w.prepare("UPDATE agents SET mesh_account_id = 'someone-else' WHERE agent_id = 'ag-c3'").run();
      w.prepare(
        `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at)
         VALUES ('ag-reg', 'role', 'templates/student', ?, 'registering', ?)`,
      ).run("0".repeat(64), new Date().toISOString());
      w.close();

      const rep = await rt.inspect.checkMeshConsistency();
      const c3 = rep.agents.find((a) => a.agentId === "ag-c3");
      const mm = c3!.findings.find((f) => f.code === "MAPPING_MISSING" && f.field === "mesh_account_id");
      expect(mm).toBeTruthy();
      expect(mm!.repair).toBe("manual");
      expect(mm!.expected).toBe("ag-c3");
      expect(mm!.actual).toBe("someone-else");

      const reg = rep.agents.find((a) => a.agentId === "ag-reg");
      expect(reg!.findings.some((f) => f.code === "ACCOUNT_MISSING")).toBe(true);
      expect(reg!.findings.some((f) => f.code === "ENDPOINT_MISSING")).toBe(true);

      // 修回后干净。
      const w2 = new Database(dbPath);
      w2.prepare("UPDATE agents SET mesh_account_id = 'ag-c3' WHERE agent_id = 'ag-c3'").run();
      w2.close();
      const rep2 = await rt.inspect.checkMeshConsistency();
      expect(rep2.agents.find((a) => a.agentId === "ag-c3")).toBeUndefined();
    } finally {
      await rt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});