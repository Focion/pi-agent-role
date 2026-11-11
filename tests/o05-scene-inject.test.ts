// ═══════════════════════════════════════════════════════════════════════════
// O05 · 场景注入（scenes.inject）——授权 / 归属 / 审计 / 幂等恢复
//
// 注入 = 往运行中场景发一条旁白（kind:"system" + msgClass:"narration"，不点名、不唤醒）。
//   1. 授权：只有场景 host / deps.host / @system 可充当旁白发送者，参与者不可；
//   2. 归属：from_account + message_id 落库，回链 mesh 消息；
//   3. 审计：scene_injections 持久记录 inject_id → message_id + text/virtual_ts 快照；
//   4. 幂等恢复：同 inject_id 重试直接回读，不重发消息。
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

async function setup(): Promise<{ rt: RuntimeInternals; dir: string; teacher: { accountId: string } }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-o05-"));
  const rt = (await createRuntimeInternals({
    root: dir,
    db: join(dir, "role-agent.db"),
    devMode: true,
    fake: { streamPort: true },
  })) as RuntimeInternals;
  const blueprint = writeRoleBlueprint(dir, "role");
  const teacher = await createRoleAgent(rt, blueprint, "teacher", "王老师");
  await createRoleAgent(rt, blueprint, "stu1", "刘明涛");
  return { rt, dir, teacher };
}

function readInjections(dir: string) {
  const db = new Database(join(dir, "role-agent.db"), { readonly: true });
  const rows = db
    .prepare(`SELECT inject_id, scene_id, conversation_id, message_id, from_account, msg_class, text, virtual_ts FROM scene_injections ORDER BY inject_id`)
    .all() as Array<{ inject_id: string; scene_id: string; conversation_id: string; message_id: string; from_account: string; msg_class: string; text: string; virtual_ts: string | null }>;
  db.close();
  return rows;
}

describe("O05 场景注入", () => {
  it("注入旁白 + 落库审计（归属/正文/虚拟时间快照）", async () => {
    const { rt, dir } = await setup();
    try {
      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
      });
      await rt.scenes.run("s1", undefined, { maxTurns: 2 });

      const inj = await rt.scenes.inject({ sceneId: "s1", injectId: "inj-1", text: "（下课铃响了）" });

      expect(inj.injectId).toBe("inj-1");
      expect(inj.sceneId).toBe("s1");
      expect(inj.conversationId).toBe(est.conversationId);
      expect(inj.messageId).toBeTruthy();
      expect(inj.msgClass).toBe("narration");
      expect(inj.text).toBe("（下课铃响了）");

      const rows = readInjections(dir);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.from_account).toBe("@system"); // 缺省归属 = 场景 host（无 deps.host 时 @system）
      expect(rows[0]!.virtual_ts).toBe("W1D1T10"); // 2 轮后虚拟时间快照

      // mesh 消息史：旁白是 kind:system + expect:none，不点名任何一人（不唤醒）。
      const msgs = await rt.mesh.observer.messages({ conversationId: est.conversationId, kind: "system" });
      const narr = msgs.find((m) => m.payload?.text === "（下课铃响了）");
      expect(narr).toBeTruthy();
      expect(narr!.expect).toBe("none");
      expect(Array.isArray(narr!.to) ? narr!.to.length : 0).toBe(0);
    } finally {
      await rt.close();
    }
  });

  it("幂等：同 injectId 重试直接回读，不重发不重复记账", async () => {
    const { rt, dir } = await setup();
    try {
      const est = await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
      });

      const a = await rt.scenes.inject({ sceneId: "s1", injectId: "inj-x", text: "旁白一" });
      const b = await rt.scenes.inject({ sceneId: "s1", injectId: "inj-x", text: "旁白一" });

      expect(b.messageId).toBe(a.messageId); // 直接回读，未重发
      expect(readInjections(dir)).toHaveLength(1);
      const msgs = await rt.mesh.observer.messages({ conversationId: est.conversationId, kind: "system" });
      const narrs = msgs.filter((m) => m.payload?.text === "旁白一");
      expect(narrs).toHaveLength(1); // 只有一条旁白消息
    } finally {
      await rt.close();
    }
  });

  it("授权：参与者账号不能充当旁白发送者", async () => {
    const { rt, dir, teacher } = await setup();
    try {
      await rt.scenes.create({
        sceneId: "s1",
        participants: [
          { agentId: "teacher", role: "teacher" },
          { agentId: "stu1", role: "student" },
        ],
        floorMode: "round_robin",
      });

      await expect(
        rt.scenes.inject({ sceneId: "s1", injectId: "inj-bad", text: "越权旁白", from: teacher.accountId }),
      ).rejects.toThrow(ValidationError);
      expect(readInjections(dir)).toHaveLength(0);
    } finally {
      await rt.close();
    }
  });

  it("终态 ended 不可再注入", async () => {
    const { rt } = await setup();
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

      await expect(rt.scenes.inject({ sceneId: "s1", injectId: "inj-end", text: "迟到旁白" })).rejects.toThrow(ValidationError);
    } finally {
      await rt.close();
    }
  });
});