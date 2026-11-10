// ═══════════════════════════════════════════════════════════════════════════
// R11 · facilities.create() + 四工具 + 边界审计（§3.2 / §5.5 / §18.4.4 / 附录 F 第 7–10 号）
//
// 断言五件事：
//   1. create 贯通「物化 → 编译 → 落库 → 注册」：持久化模板（agent_specs）、模型
//      （model_config_json）、身份（agents 行 agent_type='facility'）、状态（agent_state
//       facility_constraints/facility_live/facility_meta），且四域模型 map 到了模板文件。
//   2. 合法应答可用：facility_query 按功能域读到结构化数据；scope 锁死（越界报
//      FACILITY_NOT_IN_SCENE）；facility_record/report/enforce 走 DB-A 事实流水。
//   3. 非法主动发起被 mesh 闸②拒（CANNOT_INITIATE），且**恰一条** boundary_events
//      审计、不落任何 mesh_deliveries（§3.2 ③ / R31「设施拒绝无 delivery、恰一条审计」）。
//   4. 恢复：重启 runtime 后设施仍以 facility 类型认领回注册表（loadRegisteredAgents 原样回填）。
//   5. facilityId 为空 / 重复创建设施 → ValidationError。
//
// 注：四工具用真实 DB-A 连接（openRoleDb）+ makeFacilityDomainTools 直测处理器——不经
// pi SessionFactory（真实 LLM 会话需要凭据，fake 后端不挂 SessionFactory）。边界审计用
// rt.mesh.toolSet 取真实 mesh_send、decorateMeshSend 包一层，与 makeBoundaryAudit 组合，
// 验证「拒绝 → 恰一条边界审计」这条真实链路。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import { openRoleDb } from "../src/db/db.js";
import { makeFacilityDomainTools } from "../src/runtime/facility-tools.js";
import { makeBoundaryAudit } from "../src/runtime/boundary-audit.js";
import { decorateMeshSend } from "../src/mesh/session-factory.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";

/** 写一份设施蓝本（authoring/schema.ts facility 分支 + compileFacility 读取的扁平六文件）。 */
function writeFacilityBlueprint(root: string, dir: string): string {
  const p = join(root, dir);
  mkdirSync(p, { recursive: true });
  const files: Record<string, string> = {
    "manifest.yaml": ["facility:", "  id: classroom", "files:", "  - path: manifest.yaml", "  - path: facility.yaml", "  - path: protocol.yaml", "  - path: constraints.yaml", "  - path: records.yaml", "  - path: thresholds.yaml"].join("\n"),
    "facility.yaml": [
      "name: 自习室",
      "type: classroom",
      "duties:",
      "  - 管理自习座位与出入",
      "  - 维护安静纪律",
      "concrete_penalty: 违反纪律记过",
      "regulation_clause: 学生手册第3条",
      "report_target: teacher-alice",
    ].join("\n"),
    "protocol.yaml": ["capabilities:", "  - occupy", "initiate: []"].join("\n"),
    "constraints.yaml": [
      "constraints:",
      "  - id: quiet",
      "    text: 保持安静",
      "    severity: hard",
      "  - id: capacity-limit",
      "    text: 座位满员不得进入",
      "    severity: hard",
      "    violation_response: 引导到别的自习区",
    ].join("\n"),
    "records.yaml": ["record_types:", "  - usage", "  - incident"].join("\n"),
    "thresholds.yaml": ["capacity: 2", "time_window: 7"].join("\n"),
  };
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(p, name), body, "utf8");
  }
  return p;
}

interface Harness {
  dir: string;
  rt: RuntimeInternals;
  cleanup(): Promise<void>;
}

async function boot(facilityOpts?: { blueprint?: string }): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-facility-"));
  const rt = (await createRuntimeInternals({
    root: dir,
    db: join(dir, "role-agent.db"),
    devMode: true,
    fake: { streamPort: true },
  })) as RuntimeInternals;
  return {
    dir,
    rt,
    async cleanup() {
      await rt.close();
    },
  };
}

describe("R11 facilities.create() + four tools + boundary audit", () => {
  it("create 贯通持久化（模板/模型/身份/状态）并直测四工具合法应答", async () => {
    const h = await boot();
    const { dir, rt } = h;
    try {
      writeFacilityBlueprint(dir, "blueprints/classroom");
      const res = await rt.facilities.create({ facilityId: "classroom", blueprint: "blueprints/classroom" });

      // ① 恒等 + 编译指纹
      expect(res.facilityId).toBe("classroom");
      expect(res.accountId).toBe("classroom"); // §4.2.1 恒等
      expect(res.endpointId).toBeTruthy();
      expect(res.promptVersion).toMatch(/^[0-9a-f]{64}$/);
      expect(res.blueprintHash).toBeTruthy();
      expect(res.blueprintId).toBe("classroom");
      expect(res.modelConfig.dialogue.modelId).toBeTruthy();
      expect(rt.registry.kindOf(res.accountId)).toBe("facility");
      expect(rt.registry.nameOf(res.accountId)).toBe("自习室");

      // ② 持久化落库（真实 DB-A 第二连接）
      const roleDb = openRoleDb(join(dir, "role-agent.db"));
      const db = roleDb.db;
      try {
        const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get("classroom") as Record<string, unknown>;
        expect(agent).toBeTruthy();
        expect(agent.agent_type).toBe("facility");
        expect(agent.status).toBe("active");
        expect(agent.identity_id).toBeNull();
        expect(agent.identity_dir).toBe("agents/classroom/facility");
        expect((agent.model_config_json as string).length).toBeGreaterThan(0);
        expect((agent.registered_projection as string).length).toBeGreaterThan(0);
        expect((agent.spec_hash as string).length).toBeGreaterThan(0);

        const specRows = db.prepare("SELECT spec_path FROM agent_specs WHERE agent_id = ?").all("classroom");
        expect(specRows.length).toBe(6); // manifest/facility/protocol/constraints/records/thresholds

        const state = db.prepare("SELECT key FROM agent_state WHERE agent_id = ?").all("classroom");
        const keys = state.map((r) => (r as { key: string }).key).sort();
        expect(keys).toEqual(["facility_constraints", "facility_live", "facility_meta"].sort());

        const live = JSON.parse(
          (db.prepare("SELECT value_json FROM agent_state WHERE agent_id = ? AND key = 'facility_live'").get("classroom") as { value_json: string }).value_json,
        );
        expect(live).toEqual({ capacity: 2, time_window: 7 });

        // ③ 四工具合法应答（真实连接直测）
        const tools = makeFacilityDomainTools({ db, root: dir, facilityId: "classroom" });

        const q = await tools.facility_query("t-q", { facilityId: "classroom", domain: "basic" }, undefined, undefined, undefined);
        const qBody = JSON.parse(q.content as string) as { facilityId: string; domain: string; data: { name?: string } };
        expect(qBody.domain).toBe("basic");
        expect(qBody.data.name).toBe("自习室");

        // 合法域但扁平 schema 无文件 → unavailable（不发伪造数据）
        const qRes = await tools.facility_query("t-q2", { facilityId: "classroom", domain: "resources" }, undefined, undefined, undefined);
        expect(JSON.parse(qRes.content as string).unavailable).toBe(true);

        // scope 锁死：他设施 → FACILITY_NOT_IN_SCENE
        const qOther = await tools.facility_query("t-q3", { facilityId: "gym", domain: "basic" }, undefined, undefined, undefined);
        expect(JSON.parse(qOther.content as string).error.code).toBe("FACILITY_NOT_IN_SCENE");

        // 规则判定：硬约束 + 容量门
        const e1 = await tools.facility_enforce("t-e1", { facilityId: "classroom", action: "quiet" }, undefined, undefined, undefined);
        expect(JSON.parse(e1.content as string).allowed).toBe(true);

        // 追加两条 usage → 容量 2 触顶
        await tools.facility_record("t-r1", { facilityId: "classroom", kind: "usage", data: { seat: "A" } }, undefined, undefined, undefined);
        await tools.facility_record("t-r2", { facilityId: "classroom", kind: "usage", data: { seat: "B" } }, undefined, undefined, undefined);
        const e2 = await tools.facility_enforce("t-e2", { facilityId: "classroom", action: "capacity-limit" }, undefined, undefined, undefined);
        const e2Body = JSON.parse(e2.content as string);
        expect(e2Body.allowed).toBe(false);
        expect(e2Body.escalation).toBe("teacher-alice");

        // 规则未覆盖 → RULE_UNDEFINED
        const e3 = await tools.facility_enforce("t-e3", { facilityId: "classroom", action: "no-such-rule" }, undefined, undefined, undefined);
        expect(JSON.parse(e3.content as string).error.code).toBe("RULE_UNDEFINED");

        // 聚合：usage=2、incident=0、maintenance=0（不暴露原始流水）
        const rep = await tools.facility_report("t-rep", { facilityId: "classroom" }, undefined, undefined, undefined);
        const repBody = JSON.parse(rep.content as string);
        expect(repBody.total).toBe(2);
        expect(repBody.byKind.usage).toBe(2);
      } finally {
        roleDb.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("非法主动发起 → CANNOT_INITIATE + 无 delivery + 恰一条 boundary_events", async () => {
    const h = await boot();
    const { dir, rt } = h;
    try {
      writeFacilityBlueprint(dir, "blueprints/classroom");
      const classroom = await rt.facilities.create({ facilityId: "classroom", blueprint: "blueprints/classroom" });

      // 给设施一个可发送的语境（direct 会话 + 一个角色）
      const alice = await rt.registerAgent({ agentId: "alice", agentType: "role", displayName: "Alice" });
      const conv = await rt.mesh.ensureDirect(classroom.accountId, alice.accountId);

      // 真实 mesh_send（toolSet 绑定设施端点）→ 包一层边界审计装饰
      const [rawSend] = rt.mesh.toolSet(classroom.endpointId, ["mesh_send"]);
      const roleDb = openRoleDb(join(dir, "role-agent.db"));
      let boundaryRows = 0;
      try {
        const audit = makeBoundaryAudit({ db: roleDb.db, registry: rt.registry });
        const decorated = decorateMeshSend(rawSend!, classroom.accountId, () => ({}), audit);

        const result = await decorated.execute(
          "tc-1",
          { conversationId: conv.id, kind: "chat", text: "太吵了，安静！" },
          undefined,
          undefined,
          undefined,
        );
        const body = JSON.parse(result.content as string) as { error?: { code?: string } };
        expect(body.error?.code).toBe("CANNOT_INITIATE");

        boundaryRows = (
          roleDb.db.prepare("SELECT COUNT(*) AS c FROM boundary_events").get() as { c: number }
        ).c;
        expect(boundaryRows).toBe(1);
        const row = roleDb.db
          .prepare(
            "SELECT owner_agent, actor_account_id, actor_kind, reason_code, tool_call_id FROM boundary_events",
          )
          .get() as Record<string, unknown>;
        expect(row.owner_agent).toBe("classroom");
        expect(row.actor_account_id).toBe(classroom.accountId);
        expect(row.actor_kind).toBe("facility");
        expect(row.reason_code).toBe("CANNOT_INITIATE");
        expect(row.tool_call_id).toBe("tc-1");
      } finally {
        roleDb.close();
      }

      // 无 delivery：mesh 侧 mesh_deliveries 为 0（§3.2 ③ 闸②直接拒，不落投递）。
      const meshDb = new Database(join(dir, "mesh.db"));
      try {
        const deliveries = (meshDb.prepare("SELECT COUNT(*) AS c FROM mesh_deliveries").get() as { c: number }).c;
        expect(deliveries).toBe(0);
      } finally {
        meshDb.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("重启后设施恢复为 facility 类型（loadRegisteredAgents 原样回填）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-facility-recover-"));
    const dbPath = join(root, "role-agent.db");
    writeFacilityBlueprint(root, "blueprints/classroom");

    const rt1 = (await createRuntimeInternals({
      root,
      db: dbPath,
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;
    await rt1.facilities.create({ facilityId: "classroom", blueprint: "blueprints/classroom" });
    await rt1.close();

    const rt2 = (await createRuntimeInternals({
      root,
      db: dbPath,
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;
    try {
      expect(rt2.registry.byAgentId("classroom")?.agentType).toBe("facility");
      expect(rt2.registry.kindOf("classroom")).toBe("facility");
      expect(rt2.registry.nameOf("classroom")).toBe("自习室");
    } finally {
      await rt2.close();
    }
  });

  it("facilityId 为空 / 重复创建 → ValidationError", async () => {
    const h = await boot();
    const { dir, rt } = h;
    try {
      writeFacilityBlueprint(dir, "blueprints/classroom");
      await expect(rt.facilities.create({ facilityId: "", blueprint: "blueprints/classroom" })).rejects.toThrow(
        /invalid agentId: must be a non-empty/,
      );
      await rt.facilities.create({ facilityId: "classroom", blueprint: "blueprints/classroom" });
      await expect(
        rt.facilities.create({ facilityId: "classroom", blueprint: "blueprints/classroom" }),
      ).rejects.toThrow(/agent already exists/);
    } finally {
      await h.cleanup();
    }
  });
});