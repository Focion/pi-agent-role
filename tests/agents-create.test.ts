// ═══════════════════════════════════════════════════════════════════════════
// P1 · agents.create()（§4.2 八步）端到端：
//   物化(C5) → 五层模型解析(C6) → 编译(§5.1) → 落库(§18.2 注册组)
//   → 注册 mesh dialogue Account/Endpoint(§4.2.1 topology:"unified") → 回写转正。
//
// 断言落在四个落点：内存结果 / 磁盘身份目录 / 本环 DB-A 注册组 / mesh 注册表闭包。
// 「注册参数由编译器算出」通过 create 结果 + registry 的名字/种类反查验证（C1）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import { stringifyYaml } from "../src/compile/yaml.js";
import { openRoleDb } from "../src/db/db.js";
import { KnowledgeDao } from "../src/knowledge/dao.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { makeAgentApi } from "../src/runtime/agents.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";

/** 写一个最小身份蓝本（6 个冷启动文件齐整，满足 §5.1 严格校验）。 */
function writeBlueprint(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const files: [string, unknown][] = [
    [
      "manifest.yaml",
      {
        identity: { id: "id-stu-tm" },
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

describe("P1 agents.create() (§4.2)", () => {
  it("八步全链路：物化 + 编译 + 落库 + 注册 unified + 回写转正", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-create-"));
    writeBlueprint(join(root, "templates", "student"));

    const rt = (await createRuntimeInternals({
      root,
      db: join(root, "role-agent.db"),
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;

    try {
      const r = await rt.agents.create({
        blueprint: "templates/student",
        agentId: "ag-stu-01",
        model: { thinkingLevel: "high" },
      });

      // ── 内存结果 ──
      expect(r.agentId).toBe("ag-stu-01");
      expect(r.promptVersion).toMatch(/^[0-9a-f]{64}$/);
      expect(r.blueprintId).toBe("student");
      expect(r.blueprintHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.mesh.accountId).toBe("ag-stu-01"); // §4.2.1 恒等
      expect(r.mesh.endpointId).toBeTruthy();
      // 模型覆盖（第 4 层 create_arg）
      expect(r.modelConfig.dialogue.thinkingLevel).toBe("high");
      expect(r.modelConfigSource["dialogue.thinkingLevel"]).toBe("create_arg");
      // reflection 继承 dialogue（§5.4 末）
      expect(r.modelConfig.reflection?.thinkingLevel).toBe("high");

      // ── 磁盘身份目录（C5 物化）──
      const identityDir = join(root, "agents", "ag-stu-01", "identity");
      expect(existsSync(join(identityDir, "personal.yaml"))).toBe(true);
      expect(existsSync(join(identityDir, "manifest.yaml"))).toBe(true);

      // ── 本环 DB-A 注册组（§18.2）—— 经 registry 反查名字/种类（C1：注册参数来自编译器，不是调用方）。
      expect(rt.registry.nameOf(r.mesh.accountId)).toBe("刘明涛");
      expect(rt.registry.kindOf(r.mesh.accountId)).toBe("role");
      expect(rt.registry.byAccountId(r.mesh.accountId)?.agentId).toBe("ag-stu-01");

      // ── P4 自省流注册（§4.4）：reflect Account/Endpoint/ensureDirect 一步到位并回写映射。
      expect(r.mesh.reflectAccountId).toBe("ag-stu-01:reflect");
      expect(r.mesh.reflectEndpointId).toBeTruthy();
      expect(r.mesh.reflectConversationId).toBeTruthy();
      expect(rt.registry.kindOf(r.mesh.reflectAccountId!)).toBe("reflect");
      expect(rt.registry.baseOfReflect(r.mesh.reflectAccountId!)).toBe("ag-stu-01");
      expect(rt.registry.byAccountId(r.mesh.reflectAccountId!)?.agentId).toBe("ag-stu-01");

      // 幂等/独占：同名再建失败（§4.2.3）
      await expect(
        rt.agents.create({ blueprint: "templates/student", agentId: "ag-stu-01" }),
      ).rejects.toThrow(/already exists/);
    } finally {
      await rt.close();
    }
  });

  it("蓝本不存在 → BlueprintNotFound", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-bp404-"));
    const rt = (await createRuntimeInternals({
      root,
      db: join(root, "role-agent.db"),
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;
    try {
      await expect(rt.agents.create({ blueprint: "templates/ghost", agentId: "ag-x" })).rejects.toThrow(
        /blueprint not found/,
      );
    } finally {
      await rt.close();
    }
  });

  it("reconcileRegistrations：前向恢复 status='registering' 的行（§4.2.4）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-recon-"));
    const dbPath = join(root, "role-agent.db");
    const rt = (await createRuntimeInternals({
      root,
      db: dbPath,
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;

    // 模拟 create() 在第 6 步之后、第 8 步之前崩溃：DB-A 留着 registering 行 + 投影。
    const projection = {
      displayName: "王老师",
      capabilities: ["语文", "kind:role"],
      initiate: ["chat"],
      defaultGrade: "followUp",
      topology: { kind: "unified" },
      profileRef: "spec:deadbeef",
    };
    const inject = new Database(dbPath);
    inject
      .prepare(
        `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at,
                             registered_projection, model_config_json, model_config_source_json)
         VALUES (?, 'role', 'templates/teacher', ?, 'registering', ?, ?, '{}', '{}')`,
      )
      .run("ag-teacher", "0".repeat(64), new Date().toISOString(), JSON.stringify(projection));
    inject.close();

    try {
      const out = await rt.agents.reconcileRegistrations({ agentIds: ["ag-teacher"] });
      expect(out).toHaveLength(1);
      expect(out[0]!.agentId).toBe("ag-teacher");
      expect(out[0]!.before).toBe("registering");
      expect(out[0]!.after).toBe("active");
      expect(out[0]!.actions).toContain("account_created");
      expect(out[0]!.actions).toContain("endpoint_created");
      expect(out[0]!.actions).toContain("reflect_registered");

      // 回填进了注册表闭包：accountId === agentId（§4.2.1 恒等）。
      expect(rt.registry.nameOf("ag-teacher")).toBe("王老师");
      expect(rt.registry.kindOf("ag-teacher")).toBe("role");
      // P4：自省流映射一并前向恢复。
      expect(rt.registry.kindOf("ag-teacher:reflect")).toBe("reflect");
      const dbProbe = new Database(dbPath);
      const reflected = dbProbe
        .prepare("SELECT mesh_reflect_account_id, mesh_reflect_endpoint_id FROM agents WHERE agent_id = ?")
        .get("ag-teacher") as { mesh_reflect_account_id: string; mesh_reflect_endpoint_id: string };
      dbProbe.close();
      expect(reflected.mesh_reflect_account_id).toBe("ag-teacher:reflect");
      expect(reflected.mesh_reflect_endpoint_id).toBeTruthy();

      // 再跑一遍：没有 registering 行了，返回空。
      const again = await rt.agents.reconcileRegistrations();
      expect(again).toHaveLength(0);
    } finally {
      await rt.close();
    }
  });

  it("A05：create 第 7 步失败时投影已先行落库，reconcile 靠完整意图前向补齐（不删行重建）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-a05-"));
    writeBlueprint(join(root, "templates", "student"));

    const roleDb = openRoleDb(join(root, "role-agent.db"));
    const knowledge = new KnowledgeService({
      dao: new KnowledgeDao(roleDb.db, { nowReal: () => new Date().toISOString() }),
      knownAgents: () => new Set<string>(),
    });

    let meshDown = true;
    const api = makeAgentApi({
      root,
      roleDb: roleDb.db,
      knowledge,
      pairingId: "p-test-agents-create",
      onModelConfigUpdated: () => {},
      registerProjection: async () => {
        if (meshDown) throw new Error("mesh register down");
        return { accountId: "ag-stu-a05", endpointId: "ep-mesh-1" };
      },
      registerReflect: async () => ({
        reflectAccountId: "ag-stu-a05:reflect",
        reflectEndpointId: "ep-mesh-r1",
        reflectConversationId: "conv-mesh-r1",
      }),
    });

    try {
      // 第 7 步（注册 dialogue Account）失败：create 抛错，但 DB 已落 registering 行。
      await expect(api.create({ blueprint: "templates/student", agentId: "ag-stu-a05" })).rejects.toThrow(
        /mesh register down/,
      );

      const row = roleDb.db
        .prepare("SELECT status, registered_projection FROM agents WHERE agent_id = ?")
        .get("ag-stu-a05") as { status: string; registered_projection: string } | undefined;
      expect(row?.status).toBe("registering");
      // A05 核心：注册意图（完整投影）先于注册落库，而不是注册成功后才回写。
      expect(row?.registered_projection).toBeTruthy();
      const proj = JSON.parse(row!.registered_projection) as Record<string, unknown>;
      expect(proj.displayName).toBe("刘明涛");
      expect(proj.initiate).toContain("chat");

      // create 重试撞 ID（幂等/独占）——恢复通道是 reconcile，不靠删角色行重建。
      await expect(api.create({ blueprint: "templates/student", agentId: "ag-stu-a05" })).rejects.toThrow(
        /already exists/,
      );

      // mesh 恢复后 reconcile 凭落库投影补齐，转正 active。
      meshDown = false;
      const out = await api.reconcileRegistrations({ agentIds: ["ag-stu-a05"] });
      expect(out).toHaveLength(1);
      expect(out[0]!.before).toBe("registering");
      expect(out[0]!.after).toBe("active");

      const after = roleDb.db
        .prepare("SELECT status, mesh_account_id, mesh_reflect_account_id FROM agents WHERE agent_id = ?")
        .get("ag-stu-a05") as {
        status: string;
        mesh_account_id: string;
        mesh_reflect_account_id: string;
      };
      expect(after.status).toBe("active");
      expect(after.mesh_account_id).toBe("ag-stu-a05");
      expect(after.mesh_reflect_account_id).toBe("ag-stu-a05:reflect");
    } finally {
      roleDb.close();
    }
  });

  it("R04 createBatch：逐项串行、单行失败不中断后续，成功/待恢复/已回滚分别报告", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-batch-"));
    writeBlueprint(join(root, "templates", "student"));

    const roleDb = openRoleDb(join(root, "role-agent.db"));
    const knowledge = new KnowledgeService({
      dao: new KnowledgeDao(roleDb.db, { nowReal: () => new Date().toISOString() }),
      knownAgents: () => new Set<string>(),
    });

    // 仅 "ag-2" 的 dialogue 注册区间宕机 → 该项应判 registering（待 reconcile），其余不受影响。
    let ag2Up = false;
    const api = makeAgentApi({
      root,
      roleDb: roleDb.db,
      knowledge,
      pairingId: "p-test-agents-batch",
      onModelConfigUpdated: () => {},
      registerProjection: async (input: { agentId: string }) => {
        if (input.agentId === "ag-2" && !ag2Up) throw new Error("mesh register down");
        return { accountId: input.agentId, endpointId: `ep-${input.agentId}` };
      },
      registerReflect: async (input: { agentId: string }) => ({
        reflectAccountId: `${input.agentId}:reflect`,
        reflectEndpointId: `ep-${input.agentId}-reflect`,
        reflectConversationId: `conv-${input.agentId}-reflect`,
      }),
    });

    try {
      const out = await api.createBatch([
        { blueprint: "templates/student", agentId: "ag-1" },
        { blueprint: "templates/student", agentId: "ag-2" },
        { blueprint: "templates/ghost", agentId: "ag-3" }, // 物化失败 → 已回滚无行
      ]);

      expect(out.map((o) => o.agentId)).toEqual(["ag-1", "ag-2", "ag-3"]);
      expect(out.map((o) => o.after)).toEqual(["active", "registering", "failed"]);

      // 第 1 项完整注册。
      expect(out[0]!.result?.mesh.accountId).toBe("ag-1");
      expect(out[0]!.result?.mesh.reflectAccountId).toBe("ag-1:reflect");
      // 第 2 项 mesh 注册失败但行保留，待 reconcile。
      expect(out[1]!.error?.message).toContain("mesh register down");
      // 第 3 项物化失败（蓝本不存在）。
      expect(out[2]!.error?.message).toContain("blueprint not found");

      const statusOf = (id: string) =>
        (roleDb.db.prepare("SELECT status FROM agents WHERE agent_id = ?").get(id) as { status: string } | undefined)?.status;
      expect(statusOf("ag-1")).toBe("active");
      expect(statusOf("ag-2")).toBe("registering");
      expect(statusOf("ag-3")).toBeUndefined(); // 第 3 项已回滚，无残留行

      // ag-2 的 registering 行可经 reconcile 前向恢复（mesh 恢复后）。
      ag2Up = true;
      const rec = await api.reconcileRegistrations({ agentIds: ["ag-2"] });
      expect(rec[0]!.after).toBe("active");
    } finally {
      roleDb.close();
    }
  });
});