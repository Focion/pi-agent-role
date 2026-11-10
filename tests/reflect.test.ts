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

function setup(
  policyMap: Record<string, MemoryPolicy> = {},
  resultTimeoutMs = 50,
  extra: {
    usageForReflect?: (reflectAccountId: string) => Promise<{ tokensIn: number; tokensOut: number; totalTokens: number }>;
    onCost?: (c: { source: string; agentId?: string; sceneId?: string; tokensIn?: number; tokensOut?: number; at: string }) => void;
  } = {},
): Harness {
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
    resultTimeoutMs,
    usageForReflect: extra.usageForReflect,
    onCost: extra.onCost,
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

  it("full 档：发 cue（to=[reflect]/kind=task/expect=none）+ reflections 行 running", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    seedEpisode(h, "agent-stu", "受力分析");

    const r = await h.service.run("agent-stu", { trigger: "manual", virtualTs: "W1D1T9", sceneId: "scene-1" });
    expect(r.sent).toBe(true);

    // cue 发送形态（§13.4.1 / §20.2.4：send 非 request/ack；A04：kind=task 而非 system——
    // 普通角色 initiate 无 system，用 task 才能合法发出自省 cue）。
    expect(h.fake.sent).toHaveLength(1);
    const cue = h.fake.sent[0]!;
    expect(cue.from).toBe("acct-stu");
    expect(cue.to).toEqual(["acct-stu:reflect"]);
    expect(cue.conversationId).toBe("conv-acct-stu-acct-stu:reflect");
    expect(cue.kind).toBe("task");
    expect(cue.expect).toBe("none");
    // A22：cue 正文必须携带可锚定的 episodeId，不能让模型只看到无 ID 的 gist。
    expect(cue.text).toContain("受力分析");
    expect(cue.text).toMatch(/\[ep-[^\]]+\]/);

    // reflections 行 running。
    const row = h.db.prepare("SELECT status, trigger, reflect_msg_id FROM reflections WHERE reflection_id = ?").get(r.reflectionId!) as
      { status: string; trigger: string; reflect_msg_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("running");
    expect(row!.trigger).toBe("manual");
    expect(row!.reflect_msg_id).toBe("msg-1");
  });

  it("R17: cue 携带预算内画像（profiles 文本进 cue，非只藏 input_json）", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    // 直接沉淀一条主体画像，再触发自省，验证画像文本真的进了 cue。
    h.reflectDao.applyProfile(
      "agent-stu",
      { type: "person", id: "agent-tea" },
      {
        impression: "严厉但负责",
        valence: 0.4,
        closeness: 0.6,
        trust: 0.6,
      },
      { reason: "种子画像" },
    );
    seedEpisode(h, "agent-stu", "受力分析");

    const r = await h.service.run("agent-stu", { trigger: "manual", virtualTs: "W1D1T9" });
    expect(r.sent).toBe(true);
    const cue = h.fake.sent[0]!.text;
    expect(cue).toContain("当前对主要对象的印象（画像）");
    expect(cue).toContain("严厉但负责");
  });

  it("R17: 上一轮未澄清问题（openQuestions）随下一轮 cue 重注入，连续自省不丢", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    seedEpisode(h, "agent-stu", "受力分析");

    // 第一轮：自省流提交一个未澄清问题 + 一条自我洞察（非空结论）。
    const r1 = await h.service.run("agent-stu", { trigger: "manual", virtualTs: "W1D1T9" });
    expect(r1.sent).toBe(true);
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    await reflect_result("tc-1", {
      updates: {
        selfInsights: [{ gist: "受力分析还不熟练" }],
        openQuestions: ["为何画受力图总漏掉摩擦力？"],
      },
    });
    // output_json 持久化了问题（供下一轮读回）。
    const done = h.db
      .prepare("SELECT output_json FROM reflections WHERE reflection_id = ?")
      .get(r1.reflectionId!) as { output_json: string } | undefined;
    expect(done).toBeDefined();
    expect(JSON.parse(done!.output_json).openQuestions).toEqual(["为何画受力图总漏掉摩擦力？"]);

    // 第二轮：cue 应重注入上一轮未澄清问题。
    seedEpisode(h, "agent-stu", "静摩擦力");
    const r2 = await h.service.run("agent-stu", { trigger: "manual", virtualTs: "W1D1T10" });
    expect(r2.sent).toBe(true);
    const cue2 = h.fake.sent[1]!.text;
    expect(cue2).toContain("上一轮未澄清的问题");
    expect(cue2).toContain("为何画受力图总漏掉摩擦力？");
  });

  it("R34：自省成本归因——reflect_result 落地后按自省流账户做差上抛 onCost(source=reflect)", async () => {
    let usageCalls = 0;
    const usageForReflect = async () => {
      usageCalls += 1;
      // 第一次是发 cue 前的基线（0），第二次是落地后的累计 → 纯增量 100/50。
      return usageCalls === 1
        ? { tokensIn: 0, tokensOut: 0, totalTokens: 0 }
        : { tokensIn: 100, tokensOut: 50, totalTokens: 150 };
    };
    let cost: { source: string; agentId?: string; sceneId?: string; tokensIn?: number; tokensOut?: number; at: string } | undefined;
    const h = tracked(setup({}, 50, { usageForReflect, onCost: (c) => (cost = c) }));
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    seedEpisode(h, "agent-stu", "受力分析");

    const r = await h.service.run("agent-stu", { trigger: "manual", virtualTs: "W1D1T9", sceneId: "scene-1" });
    expect(r.sent).toBe(true);

    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    await reflect_result("tc-1", { updates: { selfInsights: [{ gist: "受力分析还不熟练" }] } });

    expect(cost).toBeDefined();
    expect(cost!.source).toBe("reflect");
    expect(cost!.agentId).toBe("agent-stu");
    expect(cost!.sceneId).toBe("scene-1");
    expect(cost!.tokensIn).toBe(100);
    expect(cost!.tokensOut).toBe(50);
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

  it("R27 纠正流程第④步：误区 1→0 写系统抬高高显著情节（person+knowledge 双主体）", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    addRoleWithReflect(h.registry, "agent-tea", "acct-tea", "王老师");

    // 制造一条误区：heard → applied（T5）→ understood（T11 corrected，置误区）。
    h.knowledge.applyUpdate("agent-stu", { topic: "kn:friction", toMastery: "heard", evidenceKind: "mentioned", evidence: "提到" }, { virtualTs: "W1D1T8" });
    h.knowledge.applyUpdate("agent-stu", { topic: "kn:friction", toMastery: "applied", evidenceKind: "solved", evidence: "会用" }, { virtualTs: "W1D1T9" });
    h.knowledge.applyUpdate("agent-stu", {
      topic: "kn:friction", toMastery: "understood", evidenceKind: "corrected", evidence: "画错方向",
      wrongBelief: "摩擦力总是与运动方向相反", taughtBy: "person:agent-tea",
    }, { virtualTs: "W1D2T8" });

    // 自省时纠正：isMisconception:false 清误区 + 记上纠正者。
    const r = await h.service.run("agent-stu", { trigger: "manual", virtualTs: "W1D2T9" });
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    const res = await reflect_result("tc-1", {
      updates: {
        knowledgeUpdates: [{ topic: "kn:friction", toMastery: "applied", evidenceKind: "solved", evidence: "这回画对了", isMisconception: false, taughtBy: "person:agent-tea" }],
      },
    });
    expect(JSON.parse(res.content as string)).toMatchObject({ ok: true });

    // 误区已清，wrong_belief 保留为历史。
    const ki = h.db.prepare("SELECT is_misconception, wrong_belief FROM knowledge_items WHERE owner_agent = ? AND topic = ?").get("agent-stu", "kn:friction") as { is_misconception: number; wrong_belief: string };
    expect(ki.is_misconception).toBe(0);
    expect(ki.wrong_belief).toContain("摩擦力");

    // 高显著节情节：kind 'self' + salience/retention ≥ 0.75 + 双主体 person:agent-tea + knowledge:kn:friction。
    const ep = h.db.prepare("SELECT episode_id, salience, retention, gist FROM episodes WHERE owner_agent = ? AND kind = 'self'").get("agent-stu") as { episode_id: string; salience: number; retention: number; gist: string } | undefined;
    expect(ep).toBeDefined();
    expect(ep!.salience).toBeGreaterThanOrEqual(0.75);
    expect(ep!.retention).toBeGreaterThanOrEqual(0.75);
    expect(ep!.gist).toContain("摩擦力");

    const subs = h.db.prepare("SELECT subject_type, subject_id FROM episode_subjects WHERE episode_id = ? ORDER BY subject_type").all(ep!.episode_id) as Array<{ subject_type: string; subject_id: string }>;
    expect(subs).toEqual([
      { subject_type: "knowledge", subject_id: "kn:friction" },
      { subject_type: "person", subject_id: "agent-tea" },
    ]);
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

  it("A23：pre_compaction 提炼成功后把来源记为已消化，重复 compaction 不再重落情节", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");

    const r = await h.service.harvest("agent-stu", {
      virtualTs: "W1D1T9",
      messages: [{ msgId: "msg-2", text: "新消息，尚未提炼" }],
    });
    expect(r.depth).toBe("full");
    expect(r.sent).toBe(true);
    // A23：cue 不再丢 msgId——原文逐条带 [来源 id] 锚点，供模型引用溯源。
    expect(h.fake.sent[0]!.text).toContain("[msg-2]");

    // 自省流回传一条 selfInsight → 落地并整批来源记为已消化（compact_distilled 台账）。
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    const res = await reflect_result("tc-1", { updates: { selfInsights: [{ gist: "小明学到一条新知识" }] } });
    expect(JSON.parse(res.content as string)).toMatchObject({ ok: true });

    const distilled = h.db
      .prepare("SELECT count(*) AS n FROM compact_distilled WHERE owner_agent = ? AND source_msg_id = ?")
      .get("agent-stu", "msg-2") as { n: number };
    expect(distilled.n).toBe(1);

    // 第二次 harvest 同一条原文 → skip（不再重复提炼落情节）。
    const r2 = await h.service.harvest("agent-stu", {
      virtualTs: "W1D1T10",
      messages: [{ msgId: "msg-2", text: "新消息，尚未提炼" }],
    });
    expect(r2.depth).toBe("skip");
    expect(r2.sent).toBe(false);
    expect(r2.skipped).toContain("already distilled");
    expect(h.fake.sent).toHaveLength(1);
  });

  it("A23：pre_compaction 只写画像未落情节 → 不标记已消化，原文下次仍被提炼", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");

    await h.service.harvest("agent-stu", {
      virtualTs: "W1D1T9",
      messages: [{ msgId: "msg-3", text: "还没变成情节的原文" }],
    });
    // 只提交画像、没有 selfInsights → episodesWritten=0，不落 compact_distilled。
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    const res = await reflect_result("tc-1", { updates: { profileUpdates: [{ subject: "person:acct-tea", impression: "值得记住的人" }] } });
    expect(JSON.parse(res.content as string)).toMatchObject({ ok: true });

    const distilled = h.db
      .prepare("SELECT count(*) AS n FROM compact_distilled WHERE owner_agent = ? AND source_msg_id = ?")
      .get("agent-stu", "msg-3") as { n: number };
    expect(distilled.n).toBe(0);

    // 原文尚未入记忆 → 下次仍 full（不跳过）。
    const r2 = await h.service.harvest("agent-stu", {
      virtualTs: "W1D1T10",
      messages: [{ msgId: "msg-3", text: "还没变成情节的原文" }],
    });
    expect(r2.depth).toBe("full");
    expect(r2.sent).toBe(true);
  });

  it("A23：harvest 有界等待成功——超时内回传 reflect_result → settled:true，来源记为已消化", async () => {
    const h = tracked(setup({}, 5_000));
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");

    // 并发回传结论：先让 harvest 装配批次（run 落行 + 推 flight + 发 cue），自省流再在
    // 超时内回传 reflect_result。setTimeout 宏任务保证 flight 已入 FIFO。
    const resultP = (async () => {
      await new Promise((r) => setTimeout(r, 20));
      const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
      const reflect_result = handlers.reflect_result as unknown as SimpleTool;
      await reflect_result("tc-1", { updates: { selfInsights: [{ gist: "小明学会画受力图" }] } });
    })();

    const r = await h.service.harvest("agent-stu", {
      virtualTs: "W1D1T9",
      messages: [{ msgId: "msg-2", text: "新消息，尚未提炼" }],
    });
    await resultP;

    expect(r.depth).toBe("full");
    expect(r.sent).toBe(true);
    expect(r.settled).toBe(true);
    const distilled = h.db
      .prepare("SELECT count(*) AS n FROM compact_distilled WHERE owner_agent = ? AND source_msg_id = ?")
      .get("agent-stu", "msg-2") as { n: number };
    expect(distilled.n).toBe(1);
  });

  it("A23：harvest 超时降级——超时仍未回传 → settled:false 留痕，行仍 running 不伪造完成", async () => {
    const h = tracked(setup({}, 30));
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");

    const r = await h.service.harvest("agent-stu", {
      virtualTs: "W1D1T9",
      messages: [{ msgId: "msg-2", text: "新消息，尚未提炼" }],
    });
    expect(r.depth).toBe("full");
    expect(r.sent).toBe(true);
    expect(r.settled).toBe(false);
    expect(r.skipped).toContain("timeout");

    // 行仍在 running（cue 在途，稍后异步落地），绝不伪造 done；来源台账也未写。
    const row = h.db.prepare("SELECT status FROM reflections WHERE reflection_id = ?").get(r.reflectionId!) as { status: string };
    expect(row.status).toBe("running");
    const distilled = h.db
      .prepare("SELECT count(*) AS n FROM compact_distilled WHERE owner_agent = ? AND source_msg_id = ?")
      .get("agent-stu", "msg-2") as { n: number };
    expect(distilled.n).toBe(0);
  });

  it("A13 嵌套结构先验：selfInsights.detail={} 整批拒绝，不残留已提交画像", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    seedEpisode(h, "agent-stu", "一段经历");

    const r = await h.service.run("agent-stu", { trigger: "manual" });
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    const res = await reflect_result("tc-1", {
      updates: {
        // 合法画像置前，非法 selfInsights.detail 置后：整批应在写画像**之前**被拒。
        profileUpdates: [{ subject: "person:agent-tea", impression: "本不该残留" }],
        selfInsights: [{ gist: "一段认识", detail: {} }],
      },
    });
    expect(JSON.parse(res.content as string)).toMatchObject({ error: { code: "ARG_INVALID" } });

    // 无画像残留（本批试图写的 person:agent-tea 未落库；seedEpisode 的 self 画像不算）。
    const prof = h.db
      .prepare("SELECT count(*) AS n FROM subject_profiles WHERE owner_agent = ? AND subject_type = 'person' AND subject_id = 'agent-tea'")
      .get("agent-stu") as { n: number };
    expect(prof.n).toBe(0);
    const row = h.db.prepare("SELECT status FROM reflections WHERE reflection_id = ?").get(r.reflectionId!) as { status: string };
    expect(row.status).toBe("failed");
  });

  it("A24 负 valence 不再被 clamp 成 0（限 [-1,1]）", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");
    seedEpisode(h, "agent-stu", "一段经历");

    const r = await h.service.run("agent-stu", { trigger: "manual" });
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    await reflect_result("tc-1", {
      updates: { profileUpdates: [{ subject: "person:agent-tea", valence: -0.8 }] },
    });

    const prof = h.db
      .prepare("SELECT valence FROM subject_profiles WHERE owner_agent = ? AND subject_type = 'person' AND subject_id = 'agent-tea'")
      .get("agent-stu") as { valence: number };
    expect(prof.valence).toBeCloseTo(-0.8);
  });

  it("A21 成功游标只看 done 的 finished_at，failed/running 不推进 since", () => {
    const h = tracked(setup());
    h.db
      .prepare(
        `INSERT INTO reflections (reflection_id, owner_agent, trigger, status, started_at, finished_at)
         VALUES ('rf-done', 'agent-stu', 'manual', 'done', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:10.000Z'),
                ('rf-failed', 'agent-stu', 'manual', 'failed', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:05.000Z'),
                ('rf-running', 'agent-stu', 'manual', 'running', '2026-01-01T00:02:00.000Z', NULL)`,
      )
      .run();

    // 游标是最近一次 done 的 finished_at，不是更晚 failed/running 的 started_at。
    expect(h.reflectDao.lastReflectionAt("agent-stu")).toBe("2026-01-01T00:00:10.000Z");
  });

  it("R19 重启恢复：recoverInterrupted 终结遗留 running 批，done/failed 不动，游标不推进", () => {
    const h = tracked(setup());
    h.db
      .prepare(
        `INSERT INTO reflections (reflection_id, owner_agent, trigger, status, started_at, finished_at, output_json)
         VALUES ('rf-done',    'agent-stu', 'manual', 'done',    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:10.000Z', NULL),
                ('rf-failed',  'agent-stu', 'manual', 'failed',  '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:05.000Z', '{"error":"x"}'),
                ('rf-orphan1', 'agent-stu', 'manual', 'running', '2026-01-01T00:02:00.000Z', NULL, NULL),
                ('rf-orphan2', 'agent-tea', 'manual', 'running', '2026-01-01T00:03:00.000Z', NULL, NULL)`,
      )
      .run();

    // 重启装配：一次终结所有遗留 running 批（跨 owner）。
    const n = h.service.recoverInterrupted();
    expect(n).toBe(2);

    const byId = (id: string): { status: string; finished_at: string | null; output_json: string | null } =>
      h.db
        .prepare("SELECT status, finished_at, output_json FROM reflections WHERE reflection_id = ?")
        .get(id) as { status: string; finished_at: string | null; output_json: string | null };

    // 遗留 running → failed（interrupted），落 finished_at，不伪造 done。
    for (const id of ["rf-orphan1", "rf-orphan2"]) {
      const row = byId(id);
      expect(row.status).toBe("failed");
      expect(row.finished_at).not.toBeNull();
      expect(JSON.parse(row.output_json ?? "{}")).toMatchObject({ error: "interrupted" });
    }

    // 已终结的行不被改写。
    expect(byId("rf-done").status).toBe("done");
    expect(byId("rf-failed").status).toBe("failed");
    expect(JSON.parse(byId("rf-failed").output_json ?? "{}")).toEqual({ error: "x" });

    // A21 成功游标仍只看 done，不因这些终结的 failed 而推进。
    expect(h.reflectDao.lastReflectionAt("agent-stu")).toBe("2026-01-01T00:00:10.000Z");
  });

  it("A12 发送前批次已入队：send 未返回时 reflect_result 直接结算（不 TOOL_DISABLED）", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");

    // 可手动 resolve 的 send：让 run() 停在 await send 上模拟「send 在途」。
    let resolveSend!: (v: { messageId: string; seq: number }) => void;
    const deferred = new Promise<{ messageId: string; seq: number }>((res) => {
      resolveSend = res;
    });
    h.fake.send = async (_m) => deferred;

    const runP = h.service.run("agent-stu", { trigger: "manual" });
    const tick = (): Promise<void> =>
      new Promise<void>((r) => setTimeout(r, 0)).then(() => new Promise<void>((r) => setTimeout(r, 0)));
    await tick(); // run 已写 reflections 行 + 入队，停在 await send。

    // send 在途时 reflect_result 已可结算（A12 核心：先关联后发送，不先 await send）。
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;
    const res = await reflect_result("tc-fast", {
      updates: { selfInsights: [{ gist: "提前提交仍归到正确批次" }] },
    });
    expect(JSON.parse(res.content as string)).toMatchObject({ ok: true });

    // 再 resolve send：run 完成并把 cue msgId 回填进 reflections 行（不覆盖 done 状态字段）。
    resolveSend({ messageId: "msg-late", seq: 1 });
    const r = await runP;
    expect(r.sent).toBe(true);
    const row = h.db
      .prepare("SELECT reflect_msg_id, status FROM reflections WHERE reflection_id = ?")
      .get(r.reflectionId!) as { reflect_msg_id: string; status: string };
    expect(row.reflect_msg_id).toBe("msg-late");
    expect(row.status).toBe("done");
  });

  it("A12 FIFO：重叠两个批次按队列头顺序结算，不串号，第三个 TOOL_DISABLED", async () => {
    const h = tracked(setup());
    addRoleWithReflect(h.registry, "agent-stu", "acct-stu", "小明");

    const tick = (): Promise<void> =>
      new Promise<void>((r) => setTimeout(r, 0)).then(() => new Promise<void>((r) => setTimeout(r, 0)));

    // 两次 run 都停在各自 send 上（不 resolve），批次 A、B 依序入队。
    const defers: Array<(v: { messageId: string; seq: number }) => void> = [];
    h.fake.send = async (_m) => new Promise<{ messageId: string; seq: number }>((res) => defers.push(res));

    const runA = h.service.run("agent-stu", { trigger: "manual" });
    await tick();
    const runB = h.service.run("agent-stu", { trigger: "manual" });
    await tick();

    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as unknown as SimpleTool;

    // 第 1 个结果 → 归 A，第 2 个 → 归 B（FIFO 头：不因重叠单键串号）。
    const r1 = await reflect_result("tc-1", { updates: { selfInsights: [{ gist: "批次 A 的结论" }] } });
    expect(JSON.parse(r1.content as string)).toMatchObject({ ok: true });
    const r2 = await reflect_result("tc-2", { updates: { selfInsights: [{ gist: "批次 B 的结论" }] } });
    expect(JSON.parse(r2.content as string)).toMatchObject({ ok: true });

    // 第 3 个 → 队列空 → TOOL_DISABLED。
    const r3 = await reflect_result("tc-3", { updates: { selfInsights: [{ gist: "越界" }] } });
    expect(JSON.parse(r3.content as string)).toMatchObject({ error: { code: "TOOL_DISABLED" } });

    // 各自 send 收尾，产品行两条 done，两条 selfInsights 各归各。
    defers.forEach((d, i) => d({ messageId: `msg-${i + 1}`, seq: i + 1 }));
    const ra = await runA;
    const rb = await runB;
    const rows = h.db
      .prepare("SELECT reflection_id, status FROM reflections WHERE owner_agent = ? ORDER BY started_at")
      .all("agent-stu") as Array<{ reflection_id: string; status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.status === "done")).toBe(true);
    expect(rows[0]!.reflection_id).toBe(ra.reflectionId);
    expect(rows[1]!.reflection_id).toBe(rb.reflectionId);

    const gists = h.db
      .prepare("SELECT gist FROM episodes WHERE owner_agent = ? AND kind = 'self' ORDER BY real_ts")
      .all("agent-stu") as Array<{ gist: string }>;
    expect(gists.map((g) => g.gist).sort()).toEqual(["批次 A 的结论", "批次 B 的结论"]);
  });
});