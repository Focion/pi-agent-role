// ═══════════════════════════════════════════════════════════════════════════
// P1 · 恢复链路（§4.2.4 / §18.2）—— 跨进程 kill → resume。
//
// 真实场景是两套进程分别 createRuntime 打开同一份 root/DB-A/DB-B。此处以「同一测试里
// 关掉 runtime #1 再开 runtime #2」模拟跨进程边界：唯一持久化真值在 DB-A 注册组，
// runtime #2 必须在装配 mesh（其恢复会触发 SessionFactory.open）之前，把 agentId↔
// 映射回填进注册表闭包 + spec 快照，O(1) 命中不得查库。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import { stringifyYaml } from "../src/compile/yaml.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";

function writeBlueprint(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const files: [string, unknown][] = [
    [
      "manifest.yaml",
      {
        identity: { id: "id-stu-cx" },
        files: ["manifest", "personal", "constraints", "evolution", "narrative_voice", "agent_protocol"].map(
          (n) => ({ path: `${n}.yaml`, priority: "cold_start" }),
        ),
      },
    ],
    ["personal.yaml", { name: { full: "陈小雨" }, age: 13, gender: "female" }],
    ["constraints.yaml", { constraints: [{ id: "c1", text: "上课不插嘴", severity: "soft" }] }],
    ["evolution.yaml", {}],
    ["narrative_voice.yaml", {}],
    ["agent_protocol.yaml", { capabilities: ["数学"], initiate: ["chat"] }],
  ];
  for (const [name, data] of files) writeFileSync(join(dir, name), stringifyYaml(data));
}

describe("P1 recovery (§4.2.4): cross-process kill → resume", () => {
  it("重新打开 runtime 后，映射与 spec 快照从 DB-A 原样回填", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-recover-"));
    writeBlueprint(join(root, "templates", "student"));
    const dbPath = join(root, "role-agent.db");
    const meshDbPath = join(root, "mesh.db");

    // ── 进程一：创建 Agent，落库并注册 mesh ──
    const rt1 = (await createRuntimeInternals({
      root,
      db: dbPath,
      meshDb: meshDbPath,
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;
    const created = await rt1.agents.create({ blueprint: "templates/student", agentId: "ag-stu-cx" });
    await rt1.close();

    // 唯一持久化真值在 DB-A（§18.2）：跨进程边界后读取作为比对基准。
    const dbA = new Database(dbPath, { readonly: true });
    const persisted = dbA
      .prepare("SELECT spec_hash, mesh_account_id, mesh_endpoint_id, display_name FROM agents WHERE agent_id = ?")
      .get("ag-stu-cx") as {
      spec_hash: string;
      mesh_account_id: string;
      mesh_endpoint_id: string;
      display_name: string;
    };
    dbA.close();
    expect(persisted.mesh_account_id).toBe("ag-stu-cx");
    expect(persisted.mesh_endpoint_id).toBe(created.mesh.endpointId);

    // ── 进程二：重新打开同一份 root/DB-A/DB-B，恢复期回填 ──
    const rt2 = (await createRuntimeInternals({
      root,
      db: dbPath,
      meshDb: meshDbPath,
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;
    try {
      const meta = rt2.agentMeta.get("ag-stu-cx");
      expect(meta).toBeDefined();
      expect(meta!.meshAccountId).toBe(persisted.mesh_account_id);
      expect(meta!.meshEndpointId).toBe(persisted.mesh_endpoint_id);
      expect(meta!.specHash).toBe(persisted.spec_hash);
      expect(meta!.displayName).toBe(persisted.display_name);
      expect(meta!.status).toBe("active");

      // 注册表闭包已回填（§3.7 ① 策略槽 O(1) 反查，不查库）：SessionFactory 的
      // classify / nameOf / kindOf 无需重编译即可命中。
      const rec = rt2.registry.byAccountId("ag-stu-cx");
      expect(rec?.agentId).toBe("ag-stu-cx");
      expect(rec?.endpointId).toBe(persisted.mesh_endpoint_id);
      expect(rt2.registry.nameOf("ag-stu-cx")).toBe("陈小雨");
      expect(rt2.registry.kindOf("ag-stu-cx")).toBe("role");
    } finally {
      await rt2.close();
    }
  });
});