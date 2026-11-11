// ═══════════════════════════════════════════════════════════════════════════
// O04 · 场景暂停/恢复（§7.5 状态机扩展）
//
// 区分 pause / abort / close：pause 是「干净停在轮次边界 + 持久化」，不解散会话、不跑
// 日终；resume 从停点无损续上（turn_count / virtual_now 不丢）。终态 ended/aborted 不可再
// pause 或 resume。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createRuntimeInternals } from "../src/runtime/runtime.js";
import type { RuntimeInternals } from "../src/runtime/runtime.js";
import { ValidationError } from "../src/runtime/errors.js";
import { createRoleAgent, writeRoleBlueprint } from "./helpers/role-agents.js";

async function setup(): Promise<{ rt: RuntimeInternals; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-o04-"));
  const rt = (await createRuntimeInternals({
    root: dir,
    db: join(dir, "role-agent.db"),
    devMode: true,
    fake: { streamPort: true },
  })) as RuntimeInternals;
  const blueprint = writeRoleBlueprint(dir, "role");
  await createRoleAgent(rt, blueprint, "teacher", "王老师");
  await createRoleAgent(rt, blueprint, "stu1", "刘明涛");
  return { rt, dir };
}

function readScene(dir: string, sceneId: string) {
  const db = new Database(join(dir, "role-agent.db"), { readonly: true });
  const row = db
    .prepare(`SELECT turn_count, virtual_now, status FROM scenes WHERE scene_id = ?`)
    .get(sceneId) as { turn_count: number; virtual_now: string; status: string } | undefined;
  db.close();
  return row;
}

describe("O04 场景暂停/恢复", () => {
  it("pause 持久化停点；跑一半暂停后 resume 无损续上", async () => {
    const { rt, dir } = await setup();
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
      });

      // 先跑 3 轮再暂停。
      const run1 = await rt.scenes.run("s1", undefined, { maxTurns: 3 });
      expect(run1.stopReason).toBe("max_turns");
      expect(run1.turnsCompleted).toBe(3);

      const paused = await rt.scenes.pause("s1");
      expect(paused.stopReason).toBe("paused");
      expect(paused.turnsCompleted).toBe(3); // 停点轮次原样报回
      expect(paused.dissolved).toBe(false);

      // DB-A 权威落库：status='paused'，turn_count 与虚拟钟都停在原处。
      const frozen = readScene(dir, "s1");
      expect(frozen?.status).toBe("paused");
      expect(frozen?.turn_count).toBe(3);
      expect(frozen?.virtual_now).toBe("W1D1T11"); // W1D1T8 + 3h

      // paused 态直接 run：不再推进，明确回报 paused（不吞成 closed，也不新建轮次）。
      const rerun = await rt.scenes.run("s1", undefined, { maxTurns: 100 });
      expect(rerun.stopReason).toBe("paused");
      expect(rerun.turnsCompleted).toBe(3);
      expect(readScene(dir, "s1")?.turn_count).toBe(3);

      // resume：恢复 active 并从停点继续，turn_count 从 3 → 6，虚拟钟接着走。
      const res2 = await rt.scenes.resume("s1", undefined, { maxTurns: 3 });
      expect(res2.stopReason).toBe("max_turns");
      expect(res2.turnsCompleted).toBe(3);
      const after = readScene(dir, "s1");
      expect(after?.status).toBe("active");
      expect(after?.turn_count).toBe(6);
      expect(after?.virtual_now).toBe("W1D1T14"); // W1D1T8 + 6h（3 停点 + 3 续跑）
    } finally {
      await rt.close();
    }
  });

  it("pause 幂等：已 paused 再 pause 不报错、状态不变", async () => {
    const { rt, dir } = await setup();
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
      });
      await rt.scenes.run("s1", undefined, { maxTurns: 1 });

      await rt.scenes.pause("s1");
      const again = await rt.scenes.pause("s1"); // 幂等：已 paused 条件写 0 行，不抛
      expect(again.stopReason).toBe("paused");
      expect(readScene(dir, "s1")?.status).toBe("paused");
    } finally {
      await rt.close();
    }
  });

  it("终态 ended 不可再 pause / resume", async () => {
    const { rt, dir } = await setup();
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
      });
      await rt.scenes.run("s1", undefined, { maxTurns: 1 });
      await rt.scenes.close("s1");
      expect(readScene(dir, "s1")?.status).toBe("ended");

      await expect(rt.scenes.pause("s1")).rejects.toThrow(ValidationError);
      await expect(rt.scenes.resume("s1")).rejects.toThrow(ValidationError);
    } finally {
      await rt.close();
    }
  });
});