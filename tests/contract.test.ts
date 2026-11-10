// ═══════════════════════════════════════════════════════════════════════════
// P6.4 契约测试：只 import index.ts
//
// 验证公开类型面完整：createRuntime 是唯一函数出口，所有关键类型可 import。
// 最小冒烟：createRuntime → 调用 inspect 全部方法 → close。
//
// 分层纪律：本文件不得 import 任何 src/ 内部模块（如 RuntimeInternals）。
// 如有违规，check:imports 会通过具体的白名单规则捕获。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createRuntime,
  type Runtime,
  type RuntimeOptions,
  type RuntimeEvent,
  type CostRecord,
  type AgentApi,
  type InspectApi,
  type MemoryApi,
  type ReflectApi,
  type SceneApi,
  type FacilityApi,
  type BlueprintApi,
  type RoleInvariantReport,
  type RoleCostMetrics,
  type MemoryTimeline,
  type ImpressionEvolution,
  type CostView,
  type EvidenceLevel,
} from "../src/index.js";

describe("P6.4 contract: import only index.ts", () => {
  it("createRuntime is a function", () => {
    expect(typeof createRuntime).toBe("function");
  });

  it("R01: 公开运行时不含内部句柄——JavaScript 宿主无法触达 mesh/registry/registerAgent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-contract-r01-"));
    const rt = await createRuntime({
      root: dir,
      db: join(dir, "role-agent.db"),
      fake: { streamPort: true, sessions: true },
    });

    try {
      // 公开门面只有 Runtime 字段；内部句柄不在对象上（不在属性名，也不是可枚举键）。
      for (const key of ["mesh", "registry", "registerAgent", "agentMeta", "sceneExt", "health", "dayEnd"]) {
        expect(key in rt).toBe(false);
        expect((rt as unknown as Record<string, unknown>)[key]).toBeUndefined();
      }
      expect(Object.keys(rt as object).sort()).toEqual(
        ["agents", "blueprints", "close", "facilities", "inspect", "memory", "reflect", "replay", "scenes"].sort(),
      );
    } finally {
      await rt.close();
    }
  });

  it("all inspect methods return expected types on empty runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-contract-"));
    const rt = await createRuntime({
      root: dir,
      db: join(dir, "role-agent.db"),
      fake: { streamPort: true, sessions: true },
    });

    try {
      // checkInvariants
      const inv = await rt.inspect.checkInvariants();
      expect(typeof inv.mesh.ok).toBe("boolean");
      expect(typeof inv.role.ok).toBe("boolean");
      expect(inv.role.checked).toBeGreaterThanOrEqual(0);

      // scanDanglingMessages
      const dang = await rt.inspect.scanDanglingMessages();
      expect(typeof dang.scanned).toBe("number");

      // costMetrics
      const cost = await rt.inspect.costMetrics();
      expect(typeof cost.deliveriesTotal).toBe("number");

      // memoryTimeline
      const tl = await rt.inspect.memoryTimeline("alice");
      expect(tl.ownerAgent).toBe("alice");
      expect(Array.isArray(tl.scenes)).toBe(true);

      // impressionEvolution
      const imp = await rt.inspect.impressionEvolution("alice", "person", "bob");
      expect(imp.ownerAgent).toBe("alice");
      expect(imp.subjectType).toBe("person");
      expect(imp.subjectId).toBe("bob");

      // costView
      const cv = await rt.inspect.costView();
      expect(typeof cv.roleOnly.messagesTotal).toBe("number");
    } finally {
      await rt.close();
    }
  });

  it("close 幂等且并发安全（A37）：并发/连续 close 不抛、不重复释放", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-contract-close-"));
    const rt = await createRuntime({
      root: dir,
      db: join(dir, "role-agent.db"),
      fake: { streamPort: true, sessions: true },
    });

    // 并发 close：三次共享同一在途 promise，收敛到同一次释放，无并发双重关闭。
    await Promise.all([rt.close(), rt.close(), rt.close()]);
    // 之后再次 close：走已缓存/可重试路径，仍 resolve（不因资源已关而炸）。
    await expect(rt.close()).resolves.toBeUndefined();
  });

  it("public type surface: key types are importable", () => {
    // Type-level assertion: if any of these types disappear from index.ts,
    // this file won't compile. The values are just cast-existence checks.
    const _types: Record<string, unknown> = {
      Runtime: null as unknown as Runtime,
      RuntimeOptions: null as unknown as RuntimeOptions,
      RuntimeEvent: null as unknown as RuntimeEvent,
      CostRecord: null as unknown as CostRecord,
      AgentApi: null as unknown as AgentApi,
      InspectApi: null as unknown as InspectApi,
      MemoryApi: null as unknown as MemoryApi,
      ReflectApi: null as unknown as ReflectApi,
      SceneApi: null as unknown as SceneApi,
      FacilityApi: null as unknown as FacilityApi,
      BlueprintApi: null as unknown as BlueprintApi,
      RoleInvariantReport: null as unknown as RoleInvariantReport,
      RoleCostMetrics: null as unknown as RoleCostMetrics,
      MemoryTimeline: null as unknown as MemoryTimeline,
      ImpressionEvolution: null as unknown as ImpressionEvolution,
      CostView: null as unknown as CostView,
      EvidenceLevel: null as unknown as EvidenceLevel,
      // untagged type alias assertions
      _evL0: "L0" as EvidenceLevel,
      _evL1: "L1" as EvidenceLevel,
      _evL2: "L2" as EvidenceLevel,
    };
    expect(Object.keys(_types).length).toBeGreaterThanOrEqual(17);
  });
});