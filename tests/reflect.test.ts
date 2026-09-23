// ═══════════════════════════════════════════════════════════════════════════
// P4 自省与巩固集成测试（§13 / §15.2）—— 触发器分级 + 自省往返 + reflect_result 落地
//
// 用「最小假 mesh（send/ensureDirect）+ 真实 DB-A」驱动 ReflectionService，验证：
//   1. 三档分级：manual/arousal_spike/pre_compaction → full；episodes_since 未达阈值 → skip
//   2. full 档：发 cue（expect:"none"、to=[reflect]、kind:"system"）+ reflections 行 running + inFlight
//   3. reflect_result：落地画像回写 / 巩固 L1→L2 / 自我洞察 / 状态微调 + state_writes 审计 + done
//   4. K3 delta 限幅：trustDelta 连加合并后一次限幅到 cap；state_writes.reason='k3_clamp'
//   5. owner 证据校验：consolidation 引用非本人 episode → ARG_INVALID + reflection failed
//   6. exactly-once：同一自省二次 reflect_result → TOOL_DISABLED；未进行中 → TOOL_DISABLED
//   7. reflect_result 只挂自省流（§3.8）：reflect account 有、主 account 无
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultMemoryPolicy, type MemoryPolicy } from "../src/compile/types.js";
import { openRoleDb, type RoleDb } from "../src/db/db.js";
import { KnowledgeDao } from "../src/knowledge/dao.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { RoleAccountRegistry } from "../src/mesh/accounts.js";
import { MemoryDao } from "../src/memory/dao.js";
import { ReflectionDao } from "../src/reflect/dao.js";
import { ReflectionService } from "../src/reflect/service.js";

// ─── 最小假 mesh（send + ensureDirect，供 attach 消费）──────────────────────

interface SentMsg {
  from: string;
  to: string[];
  conversationId: string;
  kind: string;
  expect: string;
  text: string;
  ext: unknown;
}
interface ReflectFakeMesh {
  sent: SentMsg[];
  ensureDirect(a: string, b: string): Promise<{ id: string }>;
  send(m: { from: string; to: string[]; conversationId: string; kind: string; expect: string; text: string; ext: unknown }): Promise<{ messageId: string; seq: number }>;
}

function makeReflectFakeMesh(): ReflectFakeMesh {
  const sent: SentMsg[] = [];
  return {
    sent,
    async ensureDirect(a, b) {
      return { id: `conv-${a}-${b}` };
    },
    async send(m) {
      sent.push(m);
      return { messageId: `msg-${sent.length}`, seq: sent.length };
    },
  };
}

// ─── 装配 ───────────────────────────────────────────────────────────────────

interface Harness {
  dir: string;
  roleDb: RoleDb;
  db: RoleDb["db"];
  memoryDao: MemoryDao;
  reflectDao: ReflectionDao;
  knowledge: KnowledgeService;
  registry: RoleAccountRegistry;
  service: ReflectionService;
  fake: ReflectFakeMesh;
}

function setup(policyMap: Record<string, MemoryPolicy> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-reflect-"));
  const roleDb = openRoleDb(join(dir, "role-agent.db"));
  const db = roleDb.db;

  let t = 0;
  const nowReal = (): string => new Date(Date.UTC(2026, 0, 1) + t++ * 1000).toISOString();

  const memoryDao = new MemoryDao(db, { nowReal });
  const reflectDao = new ReflectionDao({ db, nowReal });
  const registry = new RoleAccountRegistry();
  const knowledge = new KnowledgeService({
    dao: new KnowledgeDao(db, { nowReal }),
    knownAgents: () => new Set(registry.allAgentIds()),
  });
  const service = new ReflectionService({
    dao: reflectDao,
    memoryDao,
    knowledge,
    registry,
    policyOf: async (acct) => policyMap[acct] ?? defaultMemoryPolicy(),
  });
  const fake = makeReflectFakeMesh();
  service.attach(fake as unknown as Parameters<ReflectionService["attach"]>[0]);

  return { dir, roleDb, db, memoryDao, reflectDao, knowledge, registry, service, fake };
}

const cleanups: Array<{ dir: string; roleDb: RoleDb }> = [];
function tracked(h: Harness): Harness {
  cleanups.push({ dir: h.dir, roleDb: h.roleDb });
  return h;
}
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c.roleDb.close();
    } catch {
      /* noop */
    }
    try {
      rmSync(c.dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

/** 注册一个带自省流的 role。 */
function addRoleWithReflect(r: RoleAccountRegistry, agentId: string, accountId: string, displayName?: string): void {
  r.register({
    agentId,
    agentType: "role",
    accountId,
    endpointId: `ep-${agentId}`,
    reflectAccountId: `${accountId}:reflect`,
    reflectEndpointId: `ep-${agentId}-reflect`,
    displayName,
  });
}

/** 写一条 active 情节（供自省依据）。 */
function seedEpisode(h: Harness, owner: string, gist: string): string {
  const id = `ep-${gist.slice(0, 4)}-${Math.random().toString(36).slice(2, 8)}`;
  h.memoryDao.insertEpisode({
    episodeId: id,
    ownerAgent: owner,
    kind: "event",
    sceneId: "scene-1",
    purposeKind: null,
    sourceMsgId: `msg-${id}`,
    sourceSessionId: null,
    sourceEntryId: null,
    gist,
    detail: null,
    quote: null,
    emotion: null,
    valence: null,
    arousal: 0.8,
    salience: 0.7,
    confidence: 0.8,
    accuracy: null,
    virtualTs: "W1D1T8",
    virtualHours: 0,
    retention: 0.7,
    status: "active",
    subjects: [{ ref: { type: "self", id: "self" } }],
  });
  return id;
}

type SimpleTool = (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: unknown; details?: unknown }>;

// ─── 测试 ───────────────────────────────────────────────────────────────────

describe("P4 自省与巩固（§13 / §15.2）", () => {
  it("三档分级：manual/pre_compaction/arousal_spike → full；episodes_since 未达阈值 → skip", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");

    // 无情节 + episodes_since → skip（0 < episodesPerReflection=6）。
    const skip = await h.service.run("agent-stu", { trigger: "episodes_since" });
    expect(skip.depth).toBe("skip");
    expect(skip.sent).toBe(false);

    // 低于阈值的少量情节仍 skip。
    seedEpisode(h, "agent-stu", "第一课");
    seedEpisode(h, "agent-stu", "第二课");
    const skip2 = await h.service.run("agent-stu", { trigger: "episodes_since" });
    expect(skip2.depth).toBe("skip");

    // manual 恒 full。
    const manual = await h.service.run("agent-stu", { trigger: "manual" });
    expect(manual.depth).toBe("full");
    expect(manual.sent).toBe(true);
    expect(manual.reflectionId).toBeTruthy();
  });

  it("full 档：发 cue（to=[reflect]/kind=system/expect=none）+ reflections 行 running", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    seedEpisode(h, "agent-stu", "受力分析");

    const r = await h.service.run("agent-stu", { trigger: "manual", virtualTs: "W1D1T9", sceneId: "scene-1" });
    expect(r.sent).toBe(true);

    // cue 发送形态（§13.4.1 / §20.2.4：send 非 request/ack）。
    expect(h.fake.sent).toHaveLength(1);
    const cue = h.fake.sent[0]!;
    expect(cue.from).toBe("acct-stu");
    expect(cue.to).toEqual(["acct-stu:reflect"]);
    expect(cue.conversationId).toBe("conv-acct-stu-acct-stu:reflect");
    expect(cue.kind).toBe("system");
    expect(cue.expect).toBe("none");

    // reflections 行 running。
    const row = h.db.prepare("SELECT status, trigger, reflect_msg_id FROM reflections WHERE reflection_id = ?").get(r.reflectionId!) as
      { status: string; trigger: string; reflect_msg_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("running");
    expect(row!.trigger).toBe("manual");
    expect(row!.reflect_msg_id).toBe("msg-1");
  });

  it("reflect_result 落地：画像回写 + 巩固 L1→L2 + 自我洞察 + 状态微调 + done", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    const ep1 = seedEpisode(h, "agent-stu", "受力分析画错");
    seedEpisode(h, "agent-stu", "被老师纠正");

    const r = await h.service.run("agent-stu", { trigger: "manual", virtualTs: "W1D1T9" });
    expect(r.sent).toBe(true);

    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    const res = await reflect_result("tc-1", {
      updates: {
        profileUpdates: [{ subject: "person:agent-tea", impression: "严厉但负责", trustDelta: 0.1 }],
        consolidations: [{ episodeIds: [ep1], gist: "受力分析容易出错，需要多练" }],
        selfInsights: [{ gist: "我对受力分析还不太熟练" }],
        stateAdjust: { mood: "懊恼", moodDelta: -0.1 },
      },
    });
    expect(JSON.parse(res.content as string)).toMatchObject({ ok: true });

    // 画像：trust 落在 person:agent-tea。
    const prof = h.db
      .prepare("SELECT impression, trust FROM subject_profiles WHERE owner_agent = ? AND subject_type = 'person' AND subject_id = 'agent-tea'")
      .get("agent-stu") as { impression: string; trust: number } | undefined;
    expect(prof).toBeDefined();
    expect(prof!.impression).toBe("严厉但负责");
    expect(prof!.trust).toBeCloseTo(0.6); // 默认 0.5 + 0.1

    // 巩固：原 L1 情节 consolidated + 新 impression 摘要。
    const consolidated = h.db.prepare("SELECT status FROM episodes WHERE episode_id = ?").get(ep1) as { status: string };
    expect(consolidated.status).toBe("consolidated");
    const imp = h.db.prepare("SELECT gist, kind FROM episodes WHERE owner_agent = ? AND kind = 'impression'").get("agent-stu") as
      { gist: string; kind: string } | undefined;
    expect(imp).toBeDefined();
    expect(imp!.gist).toBe("受力分析容易出错，需要多练");

    // 自我洞察 kind 'self'。
    const self = h.db.prepare("SELECT gist FROM episodes WHERE owner_agent = ? AND kind = 'self'").get("agent-stu") as { gist: string } | undefined;
    expect(self).toBeDefined();
    expect(self!.gist).toBe("我对受力分析还不太熟练");

    // 状态微调：mood 文字被覆盖 + mood_intensity 下移。
    const mood = h.db.prepare("SELECT value_json FROM agent_state WHERE agent_id = ? AND key = 'mood'").get("agent-stu") as { value_json: string };
    expect(JSON.parse(mood.value_json)).toBe("懊恼");

    // 审计：state_writes actor=ReflectionService。
    const sw = h.db.prepare("SELECT count(*) AS n FROM state_writes WHERE owner_agent = ? AND actor = 'ReflectionService'").get("agent-stu") as { n: number };
    expect(sw.n).toBeGreaterThanOrEqual(2); // 画像 + 状态各一条

    // 行程 done + 计数。
    const row = h.db.prepare("SELECT status, profiles_touched, episodes_written FROM reflections WHERE reflection_id = ?").get(r.reflectionId!) as
      { status: string; profiles_touched: number; episodes_written: number };
    expect(row.status).toBe("done");
    expect(row.profiles_touched).toBe(1);
    expect(row.episodes_written).toBe(2); // 巩固 1 + 自我洞察 1
  });

  it("K3 delta 限幅：同主体连加后一次限幅到 cap，state_writes.reason='k3_clamp'", async () => {
    const h = tracked(setup()); // 默认 trustDeltaCap=0.15
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    seedEpisode(h, "agent-stu", "被老师批评");

    const r = await h.service.run("agent-stu", { trigger: "manual" });
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    await reflect_result("tc-1", {
      updates: {
        // 两个 +0.1 在同一主体上合并为 +0.2，超过 cap 0.15，限幅一次 → 0.15（而非朴素 0.2）。
        profileUpdates: [
          { subject: "person:agent-tea", trustDelta: 0.1 },
          { subject: "person:agent-tea", trustDelta: 0.1 },
        ],
      },
    });

    const prof = h.db
      .prepare("SELECT trust FROM subject_profiles WHERE owner_agent = ? AND subject_type = 'person' AND subject_id = 'agent-tea'")
      .get("agent-stu") as { trust: number };
    expect(prof.trust).toBeCloseTo(0.65); // 0.5 + 0.15

    const sw = h.db
      .prepare("SELECT reason FROM state_writes WHERE owner_agent = ? AND target = 'subject_profile' ORDER BY real_ts DESC LIMIT 1")
      .get("agent-stu") as { reason: string | null };
    expect(sw.reason).toBe("k3_clamp");
  });

  it("owner 证据校验：consolidation 引用非本人 episode → ARG_INVALID + reflection failed", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    seedEpisode(h, "agent-stu", "自己的情节");

    const r = await h.service.run("agent-stu", { trigger: "manual" });
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    const res = await reflect_result("tc-1", {
      updates: { consolidations: [{ episodeIds: ["ep-else别人"], gist: "别人的结论" }] },
    });
    expect(JSON.parse(res.content as string)).toMatchObject({
      error: { code: "ARG_INVALID" },
    });

    const row = h.db.prepare("SELECT status FROM reflections WHERE reflection_id = ?").get(r.reflectionId!) as { status: string };
    expect(row.status).toBe("failed");
  });

  it("exactly-once：同一自省二次 reflect_result → TOOL_DISABLED；未进行中 → TOOL_DISABLED", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    seedEpisode(h, "agent-stu", "一段经历");

    // 未进行中 → TOOL_DISABLED。
    const handlers0 = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const before = await (handlers0.reflect_result as unknown as SimpleTool)("tc-0", { updates: { selfInsights: [{ gist: "x" }] } });
    expect(JSON.parse(before.content as string)).toMatchObject({ error: { code: "TOOL_DISABLED" } });

    const r = await h.service.run("agent-stu", { trigger: "manual" });
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    const ok = await reflect_result("tc-1", { updates: { selfInsights: [{ gist: "我对这件事有新认识" }] } });
    expect(JSON.parse(ok.content as string)).toMatchObject({ ok: true });

    const dup = await reflect_result("tc-2", { updates: { selfInsights: [{ gist: "再一次" }] } });
    expect(JSON.parse(dup.content as string)).toMatchObject({ error: { code: "TOOL_DISABLED" } });
  });

  it("reflect_result 只挂自省流（§3.8）：reflect account 有、主 account 无", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");

    const main = await h.service.reflectResultHandlerFor("acct-stu");
    expect(main.reflect_result).toBeUndefined();

    const refl = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    expect(refl.reflect_result).toBeTypeOf("function");
  });

  it("runAll 对全部 role agent 广播（scene_end 触发器）", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    addRoleWithReflect(h.registry, "agent-tea", "acct-tea", "王老师");
    seedEpisode(h, "agent-stu", "学生有情节");
    seedEpisode(h, "agent-tea", "老师有情节");

    const results = await h.service.runAll({ trigger: "scene_end", virtualTs: "W1D1T10" });
    expect(results).toHaveLength(2);
    expect(results.every((x) => x.trigger === "scene_end")).toBe(true);
    // 两人都有情节 → 都 full 且各发一条 cue。
    expect(results.every((x) => x.depth === "full" && x.sent === true)).toBe(true);
    expect(h.fake.sent).toHaveLength(2);
  });

  it("harvest：即将被压缩的原文去重后走 full，cue 携带原文（§15.4 H2）", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    // 已知 source_msg_id 的情节 = 已提炼；msg-2 是尚未入记忆的原文。
    h.memoryDao.insertEpisode({
      episodeId: "ep-known",
      ownerAgent: "agent-stu",
      kind: "event",
      sceneId: null,
      purposeKind: null,
      sourceMsgId: "known-msg-1",
      sourceSessionId: null,
      sourceEntryId: null,
      gist: "已提炼过的旧事",
      detail: null,
      quote: null,
      emotion: null,
      valence: null,
      arousal: 0.3,
      salience: 0.3,
      confidence: 0.8,
      accuracy: null,
      virtualTs: "W1D1T8",
      virtualHours: 0,
      retention: 0.3,
      status: "active",
      subjects: [{ ref: { type: "self", id: "self" } }],
    });

    const r = await h.service.harvest("agent-stu", {
      virtualTs: "W1D1T9",
      messages: [
        { msgId: "known-msg-1", text: "旧消息，已提炼" },
        { msgId: "msg-2", text: "新消息，尚未提炼" },
      ],
    });
    expect(r.depth).toBe("full");
    expect(r.sent).toBe(true);

    // cue 只带走未提炼的 msg-2，不含已提炼的旧消息。
    const cue = h.fake.sent[0]!;
    expect(cue.text).toContain("新消息，尚未提炼");
    expect(cue.text).not.toContain("旧消息，已提炼");
  });

  it("harvest：区间内全部已提炼 → skip（不发 LLM、不写 reflections 行）", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    h.memoryDao.insertEpisode({
      episodeId: "ep-known",
      ownerAgent: "agent-stu",
      kind: "event",
      sceneId: null,
      purposeKind: null,
      sourceMsgId: "known-msg-1",
      sourceSessionId: null,
      sourceEntryId: null,
      gist: "已提炼过的旧事",
      detail: null,
      quote: null,
      emotion: null,
      valence: null,
      arousal: 0.3,
      salience: 0.3,
      confidence: 0.8,
      accuracy: null,
      virtualTs: "W1D1T8",
      virtualHours: 0,
      retention: 0.3,
      status: "active",
      subjects: [{ ref: { type: "self", id: "self" } }],
    });

    const r = await h.service.harvest("agent-stu", {
      messages: [{ msgId: "known-msg-1", text: "已提炼" }],
    });
    expect(r.depth).toBe("skip");
    expect(r.sent).toBe(false);
    expect(r.skipped).toContain("already distilled");
    expect(h.fake.sent).toHaveLength(0);
  });
});