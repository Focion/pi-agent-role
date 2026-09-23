// ═══════════════════════════════════════════════════════════════════════════
// P3 对话记忆集成测试（§12 / §14 / §16.3）—— 事件闭环 + 跨轮召回 + R3 注入纪律
//
// 用「最小假 mesh」驱动 MemoryService 的三类事件订阅，验证完整闭环：
//   1. scoreMemorability 三分策略差异化（三角色对同一 msg_id 判定明显不同）
//   2. delivered → domainHandlersFor().remember → consumed 产出 episode + decision
//   3. 跨轮召回（上一轮 remember 的 gist，下一轮 recall 能想回）
//   4. R3 context 钩子 append-only（不覆盖已有消息）+ 同轮幂等（retrieval_log 只落一次）
//   5. 发送方自我记忆（message_routed → 只落判定行，written=0）
//   6. 设施事件观察（kind:event + facilityEvent → observation episode + facility/self 主体）
//
// 与 §18 的悬挂扫描不同：本文件不建 mesh_messages，改验证 episode.source_msg_id 指向
// 本轮真实投递消息（非空且等于 delivered 的 id）；「缺锚点 ≠ 悬挂」在 dangling-scan 测。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultMemoryPolicy, type MemoryPolicy } from "../src/compile/types.js";
import { openRoleDb, type RoleDb } from "../src/db/db.js";
import type { KnowledgeService } from "../src/knowledge/service.js";
import type { LearningQueueItem } from "../src/knowledge/types.js";
import { RoleAccountRegistry } from "../src/mesh/accounts.js";
import { MemoryDao } from "../src/memory/dao.js";
import { MemoryService } from "../src/memory/service.js";
import {
  scoreMemorability,
  scoreSenderMemorability,
  type MemoryTrigger,
} from "../src/memory/score.js";

// ─── 假 KnowledgeService：默认空队列，测试按需替换。─────────────────────────────

function fakeKnowledge(): KnowledgeService {
  return { learningQueue: () => [] as LearningQueueItem[] } as unknown as KnowledgeService;
}

// ─── 最小假 mesh（只实现 on/nudge，供 attach 消费）──────────────────────────

interface FakeMesh {
  handlers: Map<string, (p: unknown) => void>;
  nudges: Array<{ endpointId: string; cue: string; opts?: unknown }>;
  on(kind: string, h: (p: unknown) => void): () => void;
  nudge(endpointId: string, cue: string, opts?: unknown): Promise<void>;
  emit(kind: string, p: unknown): void;
}

function makeFakeMesh(): FakeMesh {
  const handlers = new Map<string, (p: unknown) => void>();
  const nudges: Array<{ endpointId: string; cue: string; opts?: unknown }> = [];
  return {
    handlers,
    nudges,
    on(kind, h) {
      handlers.set(kind, h);
      return () => handlers.delete(kind);
    },
    async nudge(endpointId, cue, opts) {
      nudges.push({ endpointId, cue, opts });
    },
    emit(kind, p) {
      handlers.get(kind)?.(p);
    },
  };
}

// ─── 装配夹具 ───────────────────────────────────────────────────────────────

interface Harness {
  dir: string;
  roleDb: RoleDb;
  dao: MemoryDao;
  registry: RoleAccountRegistry;
  service: MemoryService;
  fake: FakeMesh;
  db: RoleDb["db"];
}

function setup(policyMap: Record<string, MemoryPolicy> = {}, knowledgeOverride?: KnowledgeService): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-mem-"));
  const roleDb = openRoleDb(join(dir, "role-agent.db"));
  const db = roleDb.db;

  let realNow = 0;
  const nowReal = (): string => new Date(Date.UTC(2026, 0, 1) + realNow++).toISOString();

  const dao = new MemoryDao(db, { nowReal });
  const registry = new RoleAccountRegistry();
  const service = new MemoryService({
    dao,
    registry,
    knowledge: knowledgeOverride ?? fakeKnowledge(),
    policyOf: async (acct) => policyMap[acct] ?? defaultMemoryPolicy(),
  });
  const fake = makeFakeMesh();
  service.attach(fake as unknown as Parameters<MemoryService["attach"]>[0]);

  return { dir, roleDb, dao, registry, service, fake, db };
}

function addRole(r: RoleAccountRegistry, agentId: string, accountId: string, displayName?: string): void {
  r.register({ agentId, agentType: "role", accountId, endpointId: `ep-${agentId}`, displayName });
}

/** 冲刷微任务队列（MemoryService 的事件处理内部是 `void asyncFn()`，不阻塞派发）。 */
const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

/** MeshToolResult 的窄化：ToolExecute = (toolCallId, params, signal, onUpdate, ctx)。 */
type SimpleTool = (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: unknown; details?: unknown }>;

const decisionOf = (db: RoleDb["db"], owner: string, msgId: string) =>
  db
    .prepare("SELECT * FROM memory_decisions WHERE owner_agent = ? AND source_msg_id = ?")
    .get(owner, msgId) as
    | {
        owner_agent: string;
        source_msg_id: string;
        path: string;
        score: number;
        write_decided: number;
        written: number;
        nudged: number;
        components_json: string;
        virtual_ts: string;
      }
    | undefined;

const episodeOf = (db: RoleDb["db"], owner: string, msgId: string) =>
  db
    .prepare("SELECT * FROM episodes WHERE owner_agent = ? AND source_msg_id = ?")
    .get(owner, msgId) as
    | { episode_id: string; owner_agent: string; gist: string; kind: string; confidence: number; source_msg_id: string }
    | undefined;

interface Cleanup {
  dir: string;
  roleDb: RoleDb;
}
const cleanups: Cleanup[] = [];

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

// ─── 事件载荷构造（Envelope 是 mesh 泛型，这里原样叠最小字段）────────────────

const envelope = (
  id: string,
  from: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  seq: 0,
  from,
  fromEndpoint: `ep-${from}`,
  routedAt: "2026-01-01T00:00:00.000Z",
  idempotencyKey: `k-${id}`,
  conversationId: "conv-1",
  kind: "chat",
  expect: "none",
  payload: { text },
  to: [],
  ...extra,
});

describe("P3 记忆子系统（§12 / §14 / §16.3）", () => {
  it("scoreMemorability 对同一消息在三套策略下给出互不相同的 salience（三角色差异化）", () => {
    const trigger: MemoryTrigger = {
      messageId: "msg-x",
      from: "acct-narrator",
      text: "你又错了，真让人生气",
      path: "P1",
      roleExt: {},
      kind: "chat",
      to: ["acct-stu", "acct-tea", "acct-prin"],
    };
    const signals = {
      currentAccountId: "acct-stu",
      senderRole: "other",
      trustOfSender: 0.5,
      recentGists: [],
    };

    // 三套策略刻意拉开权重/增益/阈值，制造「对同一件事记得深浅不同」的可比差异。
    const tea = {
      ...defaultMemoryPolicy(),
      w: { ...defaultMemoryPolicy().w, novelty: 0.4, arousal: 0.2, selfRelevance: 0.3, authority: 0.1 },
      arousalGain: 1.5,
      writeThreshold: 0.35,
    };
    const stu = defaultMemoryPolicy();
    const prin = {
      ...defaultMemoryPolicy(),
      w: { ...defaultMemoryPolicy().w, novelty: 0.2, arousal: 0.1, selfRelevance: 0.1, authority: 0.1 },
      arousalGain: 0.5,
      writeThreshold: 0.7,
    };

    const a = scoreMemorability(trigger, tea, signals);
    const b = scoreMemorability(trigger, stu, signals);
    const c = scoreMemorability(trigger, prin, signals);

    const sals = [a.salience, b.salience, c.salience];
    const distinct = new Set(sals.map((x) => Math.round(x * 1000)));
    expect(distinct.size).toBe(3);

    // 阈值差也应体现在 write 判定的差异上。
    expect(new Set([a.write, b.write, c.write]).size).toBeGreaterThan(1);

    // 发送方打分与接收方打分是两套公式：selfRelevance 恒 1.0、hint/authority 缺席。
    const self = scoreSenderMemorability(trigger, stu, { currentAccountId: "acct-tea", recentGists: [] });
    expect(self.components.selfRelevance).toBe(1);
    expect(self.components.authority).toBe(0);
  });

  it("全链路：delivered → remember → consumed 产出 episode + decision，source_msg_id 一致且无悬挂", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");

    const env = envelope("msg-1", "acct-tea", "你这次受力分析又画错了，重做一遍", {
      to: ["acct-stu"],
      ext: { virtualTs: "W1D1T8", sceneId: "scene-1", turn: 1 },
    });

    h.fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    const tools = await h.service.domainHandlersFor("acct-stu");
    const remember = tools.remember as unknown as SimpleTool;
    expect(remember).toBeTypeOf("function");

    const rememberRes = await remember("tc-1", { gist: "老师在受力分析上指出了我的错误" });
    expect(JSON.parse(rememberRes.content as string)).toMatchObject({ ok: true });

    h.fake.emit("message_consumed", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      partial: false,
    });
    await flush();

    // episode：source_msg_id 指向本轮真实投递消息（非空、等于 delivered 的 id）
    const ep = episodeOf(h.db, "agent-stu", "msg-1");
    expect(ep).toBeDefined();
    expect(ep!.gist).toBe("老师在受力分析上指出了我的错误");
    expect(ep!.kind).toBe("event");
    expect(ep!.source_msg_id).toBe("msg-1");

    // decision：written 由 episodes 反向确定，write_decided 由起轮打分决定
    const d = decisionOf(h.db, "agent-stu", "msg-1");
    expect(d).toBeDefined();
    expect(d!.path).toBe("P1");
    expect(d!.write_decided).toBe(1);
    expect(d!.written).toBe(1);
    expect(d!.score).toBeGreaterThan(0);

    // 幂等键 (owner, source_msg_id)：同一消息不会重复落判定
    const dup = h.db
      .prepare("SELECT count(*) AS n FROM memory_decisions WHERE owner_agent = ? AND source_msg_id = ?")
      .get("agent-stu", "msg-1") as { n: number };
    expect(dup.n).toBe(1);
  });

  it("跨轮召回：上一轮的 remember 到下一轮 recall 能想回原 gist（二次上课能提上次）", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");

    // 第 1 堂课：写入一条含「受力分析」的情节记忆。
    const env1 = envelope("msg-1", "acct-tea", "今天讲受力分析", {
      to: ["acct-stu"],
      ext: { virtualTs: "W1D1T8", sceneId: "scene-1", turn: 1 },
    });
    h.fake.emit("message_delivered", {
      envelope: env1,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    const tools1 = await h.service.domainHandlersFor("acct-stu");
    const remember1 = tools1.remember as unknown as SimpleTool;
    await remember1("tc-1", { gist: "受力分析的解题方法要画受力图" });

    h.fake.emit("message_consumed", {
      envelope: env1,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      partial: false,
    });
    await flush();

    // 第 2 堂课（虚拟时间 +24h）：显式回忆上一轮的「受力分析」。
    const env2 = envelope("msg-2", "acct-tea", "上次的受力分析你再想想", {
      to: ["acct-stu"],
      ext: { virtualTs: "W1D2T8", sceneId: "scene-1", turn: 2 },
    });
    h.fake.emit("message_delivered", {
      envelope: env2,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    const tools2 = await h.service.domainHandlersFor("acct-stu");
    const recall = tools2.recall as unknown as SimpleTool;
    const res = await recall("tc-2", { query: "受力分析" });

    expect((res.content as string).includes("受力分析")).toBe(true);
    expect((res.details as { count: number }).count).toBeGreaterThanOrEqual(1);
  });

  it("R3 注入纪律：context 钩子 append-only，同轮幂等只落一次 retrieval_log", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");

    // 第 1 轮写入记忆。
    const env1 = envelope("msg-1", "acct-tea", "今天讲受力分析", {
      to: ["acct-stu"],
      ext: { virtualTs: "W1D1T8", sceneId: "scene-1", turn: 1 },
    });
    h.fake.emit("message_delivered", {
      envelope: env1,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();
    const t1 = await h.service.domainHandlersFor("acct-stu");
    await (t1.remember as unknown as SimpleTool)("tc-1", { gist: "受力分析的解题方法要画受力图" });
    h.fake.emit("message_consumed", {
      envelope: env1,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      partial: false,
    });
    await flush();

    // 第 2 轮：新消息文本命中 gist 子串，触发自动检索注入。
    const env2 = envelope("msg-2", "acct-tea", "受力分析", {
      to: ["acct-stu"],
      ext: { virtualTs: "W1D1T8", sceneId: "scene-1", turn: 2 },
    });
    h.fake.emit("message_delivered", {
      envelope: env2,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    const hook = h.service.contextHookFor("acct-stu");
    const existing = [{ role: "user", content: [{ type: "text", text: "已有消息" }] }];

    const r1 = await hook({ type: "context", messages: existing }, undefined);
    expect(r1).toBeDefined();
    const msgs1 = r1!.messages as Array<Record<string, unknown>>;
    expect(msgs1).toHaveLength(2);
    expect(msgs1[0]).toBe(existing[0]); // append-only：已有消息原样保留
    expect(msgs1[1]).toMatchObject({ customType: "memory", display: false });

    const nLogs1 = h.db
      .prepare("SELECT count(*) AS n FROM retrieval_log WHERE owner_agent = ? AND trigger_msg_id = ?")
      .get("agent-stu", "msg-2") as { n: number };
    expect(nLogs1.n).toBe(1);

    // 同一轮再次注入：不追加第二条 retrieval_log（幂等守门），也不缩水消息数。
    await hook({ type: "context", messages: existing }, undefined);
    const nLogs2 = h.db
      .prepare("SELECT count(*) AS n FROM retrieval_log WHERE owner_agent = ? AND trigger_msg_id = ?")
      .get("agent-stu", "msg-2") as { n: number };
    expect(nLogs2.n).toBe(1);
  });

  it("三角色对同一 msg_id 各落一行判定，score 互不相同（§12.1 差异化接受标准）", async () => {
    const h = tracked(
      setup({
        "acct-tea": {
          ...defaultMemoryPolicy(),
          w: { ...defaultMemoryPolicy().w, novelty: 0.4, arousal: 0.2, selfRelevance: 0.3, authority: 0.1 },
          arousalGain: 1.5,
          writeThreshold: 0.35,
        },
        "acct-stu": defaultMemoryPolicy(),
        "acct-prin": {
          ...defaultMemoryPolicy(),
          w: { ...defaultMemoryPolicy().w, novelty: 0.2, arousal: 0.1, selfRelevance: 0.1, authority: 0.1 },
          arousalGain: 0.5,
          writeThreshold: 0.7,
        },
      }),
    );
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");
    addRole(h.registry, "agent-stu", "acct-stu", "小明");
    addRole(h.registry, "agent-prin", "acct-prin", "校长");

    const env = envelope("msg-x", "acct-narrator", "你又错了，真让人生气", {
      to: ["acct-tea", "acct-stu", "acct-prin"],
      ext: { virtualTs: "W1D1T8" },
    });

    for (const accountId of ["acct-tea", "acct-stu", "acct-prin"]) {
      h.fake.emit("message_delivered", {
        envelope: env,
        endpointId: `ep-agent-${accountId.slice(5)}`,
        accountId,
        grade: "steer",
        woke: true,
        path: "P1",
      });
      await flush();
      h.fake.emit("message_consumed", {
        envelope: env,
        endpointId: `ep-agent-${accountId.slice(5)}`,
        accountId,
        partial: false,
      });
      await flush();
    }

    const agents = ["agent-tea", "agent-stu", "agent-prin"];
    const scores = agents.map((a) => decisionOf(h.db, a, "msg-x")?.score);
    expect(scores.every((s) => s !== undefined)).toBe(true);

    const distinctScores = new Set(scores.map((s) => Math.round((s as number) * 1000)));
    expect(distinctScores.size).toBe(3);
  });

  it("发送方自我记忆：message_routed 只落判定行（written=0），不直接写 episode（§12.5）", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");

    const env = envelope("msg-r", "acct-tea", "你这次受力分析又画错了，重做一遍", {
      to: ["acct-stu"],
    });
    h.fake.emit("message_routed", { envelope: env });
    await flush();

    const d = decisionOf(h.db, "agent-tea", "msg-r");
    expect(d).toBeDefined();
    expect(d!.path).toBe("P1");
    expect(d!.write_decided).toBe(1);
    expect(d!.written).toBe(0); // 真正的写走 B 模式兜底 nudge，不在 routed 直接写 episode

    const ep = episodeOf(h.db, "agent-tea", "msg-r");
    expect(ep).toBeUndefined();
  });

  it("设施事件观察：kind:event + facilityEvent → observation episode，挂 facility 与 self 主体（§16.3）", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");

    const env = envelope("msg-f", "acct-facility", "实验室的灯突然灭了", {
      kind: "event",
      expect: "none",
      ext: {
        virtualTs: "W1D1T9",
        facilityEvent: {
          facilities: ["fac-lab"],
          event: "state_change",
          state: { lighting: "off" },
          renderHints: { visual: ["灯突然灭了"] },
          anomalous: false,
        },
      },
    });

    // ambient event 不唤醒（woke:false 也无路径信息），但仍应被观察记录。
    h.fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "silent",
      woke: false,
      path: "P3",
    });
    await flush();

    const ep = episodeOf(h.db, "agent-stu", "msg-f");
    expect(ep).toBeDefined();
    expect(ep!.kind).toBe("event");
    expect(ep!.gist).toBe("灯突然灭了");
    expect(ep!.confidence).toBeCloseTo(0.4); // OBSERVATION_CONFIDENCE

    const subjects = h.db
      .prepare("SELECT subject_type, subject_id FROM episode_subjects WHERE episode_id = ?")
      .all(ep!.episode_id) as Array<{ subject_type: string; subject_id: string }>;
    const keys = subjects.map((s) => `${s.subject_type}:${s.subject_id}`).sort();
    expect(keys).toEqual(["facility:fac-lab", "self:self"]);

    // 观察不产生判定行：没有起轮就没有 decision。
    const d = decisionOf(h.db, "agent-stu", "msg-f");
    expect(d).toBeUndefined();
  });

  it("学习队列上下文注入：无记忆卡片时仍注入 transient 卡片（§17.5.2 → §14.1 150-token）", async () => {
    const lqItems: LearningQueueItem[] = [
      { topic: "变力做功", priority: "high", motivation: "上次被考住了" },
      { topic: "牛顿第二定律", priority: "medium", motivation: "推导总搞混" },
    ];
    const fakeLqK = { learningQueue: (_owner: string) => lqItems } as unknown as KnowledgeService;

    const h = tracked(setup({}, fakeLqK));
    addRole(h.registry, "agent-stu", "acct-stu", "小明");

    const env = envelope("msg-lq-1", "acct-tea", "今天讲新内容", {
      to: ["acct-stu"],
      ext: { virtualTs: "W3D1T14", sceneId: "scene-1", turn: 12 },
    });
    h.fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    // 无记忆卡片（没有 episode），但 learningQueue 非空 → 仍应注入 transient。
    const hook = h.service.contextHookFor("acct-stu");
    const existing = [{ role: "user", content: [{ type: "text", text: "已有消息" }] }];

    const r = await hook({ type: "context", messages: existing }, undefined);
    expect(r).toBeDefined();
    const msgs = r!.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(2); // existing + transient
    expect(msgs[0]).toBe(existing[0]); // R3: append-only
    expect(msgs[1]).toMatchObject({ customType: "transient", display: false });

    const content = (msgs[1] as { content: Array<{ text: string }> }).content[0]!.text;
    expect(content).toContain("<<<INTENT");
    expect(content).toContain("[学习意图]");
    expect(content).toContain("[高] 变力做功");
    expect(content).toContain("[中] 牛顿第二定律");
    expect(content).toContain("INTENT>>>");

    // retrieval_log：transient token 非零且 total = l1 + transient（l1=0 因为无记忆卡）。
    const log = h.db
      .prepare("SELECT tokens_total, tokens_transient, tokens_l1 FROM retrieval_log WHERE owner_agent = ?")
      .get("agent-stu") as { tokens_total: number; tokens_transient: number; tokens_l1: number } | undefined;
    expect(log).toBeDefined();
    expect(log!.tokens_transient).toBeGreaterThan(0);
    expect(log!.tokens_l1).toBe(0);
    expect(log!.tokens_total).toBe(log!.tokens_l1 + log!.tokens_transient);
  });

  it("学习队列无内容时与无记忆卡片一起返回 undefined（no-op）", async () => {
    const emptyK = { learningQueue: () => [] as LearningQueueItem[] } as unknown as KnowledgeService;
    const h = tracked(setup({}, emptyK));
    addRole(h.registry, "agent-stu", "acct-stu", "小明");

    const env = envelope("msg-noop-1", "acct-tea", "无匹配的触发消息", {
      to: ["acct-stu"],
      ext: { virtualTs: "W3D1T14", sceneId: "scene-1", turn: 12 },
    });
    h.fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    const hook = h.service.contextHookFor("acct-stu");
    const r = await hook({ type: "context", messages: [] }, undefined);
    // 无记忆卡、无学习队列 → undefined（no-op），不写 retrieval_log。
    expect(r).toBeUndefined();
  });

  it("学习队列 150-token 预算硬截断（§14.1.2）", async () => {
    // 造足够多的长项，确保超出 150 token。
    const manyItems: LearningQueueItem[] = Array.from({ length: 20 }, (_, i) => ({
      topic: `知识点-${i + 1}-非常长的名称为了占token`,
      priority: "low" as const,
      motivation: "这是一个很长的动机描述用于填充token预算直到超出上限触发截断",
    }));
    const fakeLqK = { learningQueue: (_owner: string) => manyItems } as unknown as KnowledgeService;

    const h = tracked(setup({}, fakeLqK));
    addRole(h.registry, "agent-stu", "acct-stu", "小明");

    const env = envelope("msg-lq-cap-1", "acct-tea", "截断测试", {
      to: ["acct-stu"],
      ext: { virtualTs: "W3D1T14", sceneId: "scene-1", turn: 12 },
    });
    h.fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    const hook = h.service.contextHookFor("acct-stu");
    const r = await hook({ type: "context", messages: [] }, undefined);
    expect(r).toBeDefined();
    const msgs = r!.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1); // only transient, no memory
    const content = (msgs[0] as { content: Array<{ text: string }> }).content[0]!.text;
    expect(content).toContain("INTENT>>>");

    // Not all 20 items should fit in 150 tokens — verify truncation happened.
    const itemCount = (content.match(/- \[低\] 知识点/g) ?? []).length;
    expect(itemCount).toBeLessThan(20);
    expect(itemCount).toBeGreaterThan(0); // some still fit

    const log = h.db
      .prepare("SELECT tokens_transient FROM retrieval_log WHERE owner_agent = ?")
      .get("agent-stu") as { tokens_transient: number } | undefined;
    expect(log).toBeDefined();
    expect(log!.tokens_transient).toBeGreaterThan(0);
    // transient budget is 150 tokens — tokens_transient should be ≤ ~200
    expect(log!.tokens_transient).toBeLessThanOrEqual(200);
  });
});