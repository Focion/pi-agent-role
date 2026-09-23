// ═══════════════════════════════════════════════════════════════════════════
// P2 · facilities.create()（§3.2 / §5.5 最小面）——设施 = 只应答的 Account
//
// 设施不是 persona：无身份编译，直接注册 mesh Account（initiate:[] + defaultGrade:"steer"）。
// 本测试断言三件事：
//   1. create 结果三映射正确，且 accountId === facilityId（§4.2.1 恒等）。
//   2. 注册表闭包 kindOf === "facility"（C1：注册参数由工具层算出，非调用方）。
//   3. 「不主动发言」由 mesh 库层强制：无 correlationId 的 mesh_send 得
//      reject(CANNOT_INITIATE)，同步抛 MeshRejectError、不落任何 delivery（§3.2 ③）。
//   4. facilityId 为空 → ValidationError。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createRuntime } from "../src/index.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";

describe("P2 facilities.create() (§3.2)", () => {
  it("注册只应答 Account + 发主动消息被 reject(CANNOT_INITIATE)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-facility-"));
    const rt = (await createRuntime({
      root: dir,
      db: join(dir, "role-agent.db"),
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;

    try {
      // ① 注册设施 + 一个角色（用于建 direct 会话给设施一个可发送的语境）
      const classroom = await rt.facilities.create({ facilityId: "classroom", name: "教室设施" });
      expect(classroom.facilityId).toBe("classroom");
      expect(classroom.accountId).toBe("classroom"); // §4.2.1 恒等：facilityId 就是 mesh accountId
      expect(classroom.endpointId).toBeTruthy();

      const alice = await rt.registerAgent({ agentId: "alice", agentType: "role", displayName: "Alice" });
      const conv = await rt.mesh.ensureDirect(classroom.accountId, alice.accountId);

      // ② 注册表闭包：kindOf === facility（C1）
      expect(rt.registry.kindOf(classroom.accountId)).toBe("facility");
      expect(rt.registry.nameOf(classroom.accountId)).toBe("教室设施");

      // ③ 主动发 chat → 库层闸②（initiate:[]）同步 reject，不落 delivery
      let code: string | undefined;
      try {
        await rt.mesh.send({
          from: classroom.accountId,
          conversationId: conv.id,
          kind: "chat",
          expect: "none",
          text: "太吵了，安静！",
        });
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("CANNOT_INITIATE");
    } finally {
      await rt.close();
    }
  });

  it("facilityId 为空 / 空白 → ValidationError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-facility-err-"));
    const rt = (await createRuntime({
      root: dir,
      db: join(dir, "role-agent.db"),
      devMode: true,
      fake: { streamPort: true },
    })) as RuntimeInternals;
    try {
      await expect(rt.facilities.create({ facilityId: "" })).rejects.toThrow(/facilityId is required/);
      await expect(rt.facilities.create({ facilityId: "   " })).rejects.toThrow(/facilityId is required/);
    } finally {
      await rt.close();
    }
  });
});