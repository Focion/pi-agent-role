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
  return {
    learningQueue: () => [] as LearningQueueItem[],
    summary: () => "",
  } as unknown as KnowledgeService;
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

  it("R22：发送方角色取 agents.role（真实角色名）而非 agentType——authority 权重按老师命中", async () => {
    const teacherAuthority: MemoryPolicy = {
      ...defaultMemoryPolicy(),
      authorityWeights: { teacher: 0.9 },
    };
    const h = tracked(setup({ "acct-stu": teacherAuthority }));
    addRole(h.registry, "agent-stu", "acct-stu", "小明");
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");
    // agents.role 才是权威角色名；注册表只带 agentType（"role"）。落一行 role='teacher'。
    h.db
      .prepare(
        `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, role, status, created_at)
         VALUES (?, 'role', ?, ?, 'teacher', 'active', ?)`,
      )
      .run("agent-tea", "/tmp/bp", "hash-tea", "2026-01-01T00:00:00.000Z");

    const env = envelope("msg-1", "acct-tea", "今天讲受力分析", {
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
    h.fake.emit("message_consumed", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      partial: false,
    });
    await flush();

    const d = decisionOf(h.db, "agent-stu", "msg-1");
    expect(d).toBeDefined();
    const comps = JSON.parse(d!.components_json) as Record<string, number>;
    // 若把 agentType（"role"）当角色名，authorityWeights.role 命中不到，落默认 0.5；
    // 正确解析出 'teacher' 才命中 0.9。
    expect(comps.authority).toBeCloseTo(0.9);
  });

  it("R22：remember 保留 emotion/valence/arousal 到情节；valence 越界 → ARG_INVALID", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");

    const env = envelope("msg-r22", "acct-tea", "讲到我最怕被点名的题", {
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

    // 合法值保真落库（§12.3 表）。
    await remember("tc-1", {
      gist: "老师点名我上去做受力分析",
      emotion: "紧张",
      valence: -0.6,
      arousal: 0.9,
      subjectRefs: ["person:agent-tea"],
    });

    const row = h.db
      .prepare("SELECT emotion, valence, arousal FROM episodes WHERE owner_agent = ? AND source_msg_id = ?")
      .get("agent-stu", "msg-r22") as
      | { emotion: string | null; valence: number | null; arousal: number | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.emotion).toBe("紧张");
    expect(row!.valence).toBeCloseTo(-0.6);
    expect(row!.arousal).toBeCloseTo(0.9);

    // valence 越界 → ARG_INVALID（不落库）。
    const bad = await remember("tc-2", { gist: "再写一条", valence: 1.5 });
    expect(JSON.stringify(bad.content)).toContain("ARG_INVALID");
  });

  it("R25：显式 recall 留痕——空结果与命中都落 retrieval_log（trigger_msg_id=null，独立于自动注入幂等键）", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");

    // 起一个活动轮（recall 只能发生在进行中的轮）。
    const env = envelope("msg-1", "acct-tea", "今天讲受力分析", {
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
    const recall = tools.recall as unknown as SimpleTool;

    // 空结果也留痕：候选 0、入选空数组。
    await recall("tc-1", { query: "量子引力波" });
    const emptyLog = h.db
      .prepare("SELECT candidates, selected_json FROM retrieval_log WHERE owner_agent = ? AND trigger_msg_id IS NULL")
      .get("agent-stu") as { candidates: number; selected_json: string } | undefined;
    expect(emptyLog).toBeDefined();
    expect(emptyLog!.selected_json).toBe("[]");

    // 命中留痕：先写记忆再 recall。
    await (tools.remember as unknown as SimpleTool)("tc-2", { gist: "受力分析的解题方法要画受力图" });
    const res = await recall("tc-3", { query: "受力分析" });
    expect((res.details as { count: number }).count).toBeGreaterThanOrEqual(1);

    const n = h.db
      .prepare("SELECT count(*) AS n FROM retrieval_log WHERE owner_agent = ? AND trigger_msg_id IS NULL")
      .get("agent-stu") as { n: number };
    expect(n.n).toBe(2); // 空结果一行 + 命中一行
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
    const existing = [{ role: "user", content: "已有消息", timestamp: Date.now() }];

    const r1 = await hook({ type: "context", messages: existing }, undefined);
    expect(r1).toBeDefined();
    const msgs1 = r1!.messages as Array<Record<string, unknown>>;
    expect(msgs1).toHaveLength(2);
    expect(msgs1[0]).toBe(existing[0]); // append-only：已有消息原样保留
    // M02：记忆卡片是 durable 端 pi-ai UserMessage（role:"user" + 字符串 content），非旧 coding-agent 形状。
    expect(msgs1[1]).toMatchObject({ role: "user", timestamp: expect.any(Number) });
    expect(typeof (msgs1[1] as { content: unknown }).content).toBe("string");

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

    // ambient event 不唤醒（woke:false），但路径非 P3 → 仍应被观察记录。
    h.fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "silent",
      woke: false,
      path: "P2",
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

  it("R22：设施观察按 dominant_channel 过滤感官通道（视觉型只记视觉片段）", async () => {
    const visualPolicy: MemoryPolicy = { ...defaultMemoryPolicy(), dominantChannel: "visual" };
    const h = tracked(setup({ "acct-stu": visualPolicy }));
    addRole(h.registry, "agent-stu", "acct-stu", "小明");

    const env = envelope("msg-sense", "acct-facility", "中性摘要：实验室此刻很安静", {
      kind: "event",
      expect: "none",
      ext: {
        virtualTs: "W1D1T9",
        facilityEvent: {
          facilities: ["fac-lab"],
          event: "state_change",
          state: { lighting: "off", noise: "low" },
          renderHints: { visual: ["灯突然灭了"], auditory: ["空调嗡嗡响"] },
          anomalous: false,
        },
      },
    });
    h.fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "silent",
      woke: false,
      path: "P2",
    });
    await flush();

    const ep = episodeOf(h.db, "agent-stu", "msg-sense");
    expect(ep).toBeDefined();
    // 视觉型只挑 visual 通道，不把 auditory 串进来（§16.3.2）。
    expect(ep!.gist).toBe("灯突然灭了");
  });

  it("P3 静默档连设施观察也零情节（A20）：先按消费档判定，不落 observation episode", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");

    const env = envelope("msg-p3", "acct-facility", "实验室的灯突然灭了", {
      kind: "event",
      expect: "none",
      ext: {
        virtualTs: "W1D1T9",
        facilityEvent: {
          facilities: ["fac-lab"],
          event: "state_change",
          state: { lighting: "off" },
          renderHints: { visual: ["灯突然灭了"] },
          anomalous: true,
        },
      },
    });

    // P3 = 静默消费档：即使带 facilityEvent，也不落任何情节（§12.1.1 静默零情节 / R21）。
    h.fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "silent",
      woke: true,
      path: "P3",
    });
    await flush();

    const ep = episodeOf(h.db, "agent-stu", "msg-p3");
    expect(ep).toBeUndefined();
    const d = decisionOf(h.db, "agent-stu", "msg-p3");
    expect(d).toBeUndefined();
    const episodeCount = h.db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE owner_agent = ?")
      .get("agent-stu") as { n: number };
    expect(episodeCount.n).toBe(0);
  });

  it("学习队列上下文注入：无记忆卡片时仍注入 transient 卡片（§17.5.2 → §14.1 150-token）", async () => {
    const lqItems: LearningQueueItem[] = [
      { topic: "变力做功", priority: "high", motivation: "上次被考住了" },
      { topic: "牛顿第二定律", priority: "medium", motivation: "推导总搞混" },
    ];
    const fakeLqK = { learningQueue: (_owner: string) => lqItems, summary: () => "" } as unknown as KnowledgeService;

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
    const existing = [{ role: "user", content: "已有消息", timestamp: Date.now() }];

    const r = await hook({ type: "context", messages: existing }, undefined);
    expect(r).toBeDefined();
    const msgs = r!.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(2); // existing + transient
    expect(msgs[0]).toBe(existing[0]); // R3: append-only
    // M02：瞬时卡片是 durable 端 UserMessage（role:"user" + 字符串 content）。
    expect(msgs[1]).toMatchObject({ role: "user", timestamp: expect.any(Number) });

    const content = (msgs[1] as { content: string }).content;
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
    const emptyK = { learningQueue: () => [] as LearningQueueItem[], summary: () => "" } as unknown as KnowledgeService;
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
    const fakeLqK = { learningQueue: (_owner: string) => manyItems, summary: () => "" } as unknown as KnowledgeService;

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
    const content = (msgs[0] as { content: string }).content;
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

  it("R23：无 L1 命中也注入 L2 本人画像/知识/发送者印象 + 实时状态，L2·瞬时·owner 分桶", async () => {
    const knowledgeSummary =
      "牛顿第二定律: understood · conf 0.80 · 保持 0.75\n变力做功: fading · conf 0.40 · 保持 0.30";
    const fakeK = {
      learningQueue: () => [] as LearningQueueItem[],
      summary: (_owner: string) => knowledgeSummary,
    } as unknown as KnowledgeService;
    const h = tracked(setup({}, fakeK));
    addRole(h.registry, "agent-stu", "acct-stu", "小明");
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");

    // L2 数据源：self 画像 + 对发送者（老师）的印象，直接落 subject_profiles（owner=agent-stu）。
    const now = "2026-01-01T00:00:00.000Z";
    const insertProfile = (type: string, id: string, impression: string): void => {
      h.db
        .prepare(
          `INSERT INTO subject_profiles
             (owner_agent, subject_type, subject_id, impression, valence, closeness, trust, episode_count, evidence_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, '[]', ?)`,
        )
        .run("agent-stu", type, id, impression, 0.6, null, null, now);
    };
    insertProfile("self", "self", "我是个偏科但好学的学生");
    insertProfile("person", "agent-tea", "王老师讲题很耐心");

    // 非默认实时状态：自省后情绪兴奋、精力略降。
    const setState = (key: string, value: unknown): void => {
      h.db
        .prepare(`INSERT INTO agent_state (agent_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)`)
        .run("agent-stu", key, JSON.stringify(value), now);
    };
    setState("mood", "兴奋");
    setState("mood_intensity", 0.9);
    setState("energy", 0.8);

    const env = envelope("msg-r23", "acct-tea", "这件事与任何记忆都不相干", {
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
    const existing = [{ role: "user", content: "已有消息", timestamp: Date.now() }];
    const r = await hook({ type: "context", messages: existing }, undefined);
    expect(r).toBeDefined();
    const msgs = r!.messages as Array<Record<string, unknown>>;
    // 无 L1 命中仍注入：existing + L2 卡 + 状态卡（瞬时）。次序 L2 → 瞬时。
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toBe(existing[0]); // R3 append-only

    const l2 = (msgs[1] as { content: string }).content;
    expect(l2).toContain("<<<SELF");
    expect(l2).toContain("[我的画像与知识]");
    expect(l2).toContain("自我印象：我是个偏科但好学的学生");
    expect(l2).toContain("对王老师的印象：王老师讲题很耐心");
    expect(l2).toContain("牛顿第二定律: understood");
    expect(l2).toContain("变力做功: fading");
    expect(l2).toContain("SELF>>>");

    const state = (msgs[2] as { content: string }).content;
    expect(state).toContain("<<<STATE");
    expect(state).toContain("[当前状态]");
    expect(state).toContain("情绪：兴奋");
    expect(state).toContain("精力：0.80");
    expect(state).toContain("STATE>>>");

    const log = h.db
      .prepare("SELECT tokens_l2, tokens_l1, tokens_transient, tokens_total FROM retrieval_log WHERE owner_agent = ?")
      .get("agent-stu") as
      | { tokens_l2: number; tokens_l1: number; tokens_transient: number; tokens_total: number }
      | undefined;
    expect(log).toBeDefined();
    expect(log!.tokens_l1).toBe(0); // 无 L1 命中
    expect(log!.tokens_l2).toBeGreaterThan(0);
    expect(log!.tokens_l2).toBeLessThanOrEqual(500); // §14.1.2 L2 ≤ 500
    expect(log!.tokens_transient).toBeGreaterThan(0);
    expect(log!.tokens_transient).toBeLessThanOrEqual(150); // 瞬时 ≤ 150
    expect(log!.tokens_total).toBe(log!.tokens_l2 + log!.tokens_l1 + log!.tokens_transient);
  });

  it("A11：同账号两 delivery 乱序消费按来源消息精确结算（不串来源、不删错轮）", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");

    // 第 1 条投递：msg-a。
    const envA = envelope("msg-a", "acct-tea", "先讲概念 A", {
      to: ["acct-stu"],
      ext: { virtualTs: "W1D1T8", sceneId: "scene-1", turn: 1 },
    });
    h.fake.emit("message_delivered", {
      envelope: envA,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });

    // 第 2 条投递：msg-b（在 msg-a 未消费前覆盖账号级「当前轮」入口）。
    const envB = envelope("msg-b", "acct-tea", "再讲概念 B", {
      to: ["acct-stu"],
      ext: { virtualTs: "W1D1T8", sceneId: "scene-1", turn: 1 },
    });
    h.fake.emit("message_delivered", {
      envelope: envB,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();

    // 乱序消费：先结算 B，再结算 A。
    h.fake.emit("message_consumed", { envelope: envB, endpointId: "ep-agent-stu", accountId: "acct-stu", partial: false });
    await flush();
    h.fake.emit("message_consumed", { envelope: envA, endpointId: "ep-agent-stu", accountId: "acct-stu", partial: false });
    await flush();

    const rows = h.db
      .prepare("SELECT source_msg_id, path, write_decided FROM memory_decisions WHERE owner_agent = ? ORDER BY source_msg_id")
      .all("agent-stu") as Array<{ source_msg_id: string; path: string; write_decided: number }>;
    // 两条判定各按自己的来源 message 落一行，不双记账、不缺失、不串来源。
    expect(rows.map((r) => r.source_msg_id)).toEqual(["msg-a", "msg-b"]);
    expect(rows.every((r) => r.path === "P1")).toBe(true);
  });

  it("A31：重复 subjectRef 只落一条关系、画像只计一次（episode_count / evidence 去重）", () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");

    // 同一 (person:tea) 出现两次（不同 role/weight），另有一个独立主体 person:prin。
    h.dao.insertEpisode({
      episodeId: "ep-dup",
      ownerAgent: "agent-stu",
      kind: "fact",
      gist: "王老师强调的重点",
      salience: 0.6,
      confidence: 0.8,
      virtualTs: "W1D1T8",
      virtualHours: 8,
      retention: 1.0,
      subjects: [
        { ref: { type: "person", id: "acct-tea" }, roleInEpisode: "sender", weight: 1.0 },
        { ref: { type: "person", id: "acct-tea" }, roleInEpisode: "authority", weight: 0.5 },
        { ref: { type: "person", id: "acct-prin" }, roleInEpisode: "wit", weight: 0.3 },
      ],
    });

    // 关系表：重复主体只保留首条（OR IGNORE），共 2 行而非 3 行。
    const rels = h.db
      .prepare("SELECT subject_type, subject_id, role_in_episode FROM episode_subjects WHERE episode_id = ? ORDER BY rowid")
      .all("ep-dup") as Array<{ subject_type: string; subject_id: string; role_in_episode: string }>;
    expect(rels).toEqual([
      { subject_type: "person", subject_id: "acct-tea", role_in_episode: "sender" },
      { subject_type: "person", subject_id: "acct-prin", role_in_episode: "wit" },
    ]);

    // 画像：acct-tea 的 episode_count 恒为 1，evidence 只含本情节一条——不被重复计入两次。
    const profile = h.db
      .prepare(
        "SELECT episode_count, evidence_json FROM subject_profiles WHERE owner_agent = ? AND subject_type = ? AND subject_id = ?",
      )
      .get("agent-stu", "person", "acct-tea") as { episode_count: number; evidence_json: string };
    expect(profile.episode_count).toBe(1);
    const evidence = JSON.parse(profile.evidence_json) as Array<{ episode_id: string; weight: number }>;
    expect(evidence).toEqual([{ episode_id: "ep-dup", weight: 1.0 }]);
  });

  it("A30：P2 摘要唤醒的 remember 拒绝写 quote（未见原文不产引文证据，P1 才可摘录）", async () => {
    const h = tracked(setup());
    addRole(h.registry, "agent-stu", "acct-stu", "小明");
    addRole(h.registry, "agent-tea", "acct-tea", "王老师");

    const env = envelope("msg-p2", "acct-tea", "上次讲的内容（摘要视图）", {
      to: ["acct-stu"],
      ext: { virtualTs: "W1D1T8", sceneId: "scene-1", turn: 1 },
    });
    h.fake.emit("message_delivered", {
      envelope: env,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "silent",
      woke: true,
      path: "P2",
    });
    await flush();

    const tools = await h.service.domainHandlersFor("acct-stu");
    const remember = tools.remember as unknown as SimpleTool;
    const rejected = await remember("tc-1", { gist: "老师说过一句话", quote: "这句话是精确原文" });
    expect(JSON.parse(rejected.content as string)).toMatchObject({ error: { code: "ARG_INVALID" } });
    expect(episodeOf(h.db, "agent-stu", "msg-p2")).toBeUndefined();

    // 正向：P1（原文可见）带 quote 是合法的。
    const envP1 = envelope("msg-p1", "acct-tea", "精确原文可见", {
      to: ["acct-stu"],
      ext: { virtualTs: "W1D1T8", sceneId: "scene-1", turn: 2 },
    });
    h.fake.emit("message_delivered", {
      envelope: envP1,
      endpointId: "ep-agent-stu",
      accountId: "acct-stu",
      grade: "steer",
      woke: true,
      path: "P1",
    });
    await flush();
    const tools2 = await h.service.domainHandlersFor("acct-stu");
    const accepted = await (tools2.remember as unknown as SimpleTool)("tc-2", {
      gist: "老师说了句重话",
      quote: "这句是精确原文",
    });
    expect(JSON.parse(accepted.content as string)).toMatchObject({ ok: true });
  });

  it("A29：主体候选通道——同一人物、措辞不同也能召回（FTS 精确短语召回缺失的兜底）", () => {
    const h = tracked(setup());
    // 旧记忆：gist 措辞与查询完全无关，但挂在 person:stu-1 主体上。
    h.dao.insertEpisode({
      episodeId: "ep-subject",
      ownerAgent: "agent-stu",
      kind: "event",
      gist: "他在篮球场上崴了脚",
      salience: 0.7,
      confidence: 0.8,
      virtualTs: "W1D1T8",
      virtualHours: 8,
      retention: 0.7,
      status: "active",
      subjects: [{ ref: { type: "person", id: "stu-1" } }],
    });
    // 另一条挂在无关 person 上的记忆，不应被主体候选召回。
    h.dao.insertEpisode({
      episodeId: "ep-other",
      ownerAgent: "agent-stu",
      kind: "event",
      gist: "运动会安排在周末",
      salience: 0.7,
      confidence: 0.8,
      virtualTs: "W1D1T8",
      virtualHours: 8,
      retention: 0.7,
      status: "active",
      subjects: [{ ref: { type: "person", id: "other" } }],
    });

    // FTS 文本候选：措辞完全不同的自然语言进精确短语 → 命不中旧 gist（A29 的缺口本身）。
    const textCandidates = h.dao.searchCandidates("agent-stu", "他上周在学校里表现得怎么样", false);
    expect(textCandidates.map((c) => c.episodeId)).not.toContain("ep-subject");

    // 主体候选通道：在场 person:stu-1 → 同一人物的情节被捞回候选面（关系表反查，非向量检索）。
    const subjectCandidates = h.dao.searchCandidatesBySubjects(
      "agent-stu",
      [{ type: "person", id: "stu-1" }],
      false,
    );
    expect(subjectCandidates.map((c) => c.episodeId)).toContain("ep-subject");
    expect(subjectCandidates.map((c) => c.episodeId)).not.toContain("ep-other");

    // self 是 owner 自聚焦兜底、范围过宽，不在主体候选通道（DAO 内部排除）。
    const selfOnly = h.dao.searchCandidatesBySubjects("agent-stu", [{ type: "self", id: "self" }], false);
    expect(selfOnly).toHaveLength(0);
  });
});

describe("R22 衰减 τ/growth 全链（§15.1 decaySweep）", () => {
  it("negativeBias 放大负面 τ、arousal 放大 τ：同 salience 同时长下负面/高唤醒衰减更慢", () => {
    const h = tracked(setup());
    const policy = { ...defaultMemoryPolicy(), negativeBias: 2, tau0Hours: 10 };

    const base = {
      ownerAgent: "agent-stu",
      kind: "event",
      salience: 1,
      confidence: 0.8,
      virtualTs: "W1D1T0",
      virtualHours: 0,
      retention: 1,
      status: "active" as const,
      subjects: [{ ref: { type: "self" as const, id: "self" } }],
    };
    h.dao.insertEpisode({ ...base, episodeId: "ep-neg", gist: "负面", valence: -0.8, arousal: 0.5 });
    h.dao.insertEpisode({ ...base, episodeId: "ep-pos", gist: "正面", valence: 0.8, arousal: 0.5 });
    h.dao.insertEpisode({ ...base, episodeId: "ep-aro", gist: "高唤醒", valence: 0, arousal: 0.9 });
    h.dao.insertEpisode({ ...base, episodeId: "ep-calm", gist: "平静", valence: 0, arousal: 0.1 });

    h.dao.decaySweep("agent-stu", 10, policy);

    const retentionOf = (id: string): number =>
      (h.db.prepare("SELECT retention FROM episodes WHERE episode_id = ?").get(id) as { retention: number })
        .retention;

    // τ = tau0Hours · (1+0.5·rehearsal) · (1+arousal) · (1+negativeBias·[valence<0])
    // negativeBias=2：负面 τ 更大 → 比正面衰减慢；arousal 越高 τ 越大 → 衰减越慢。
    expect(retentionOf("ep-neg")).toBeGreaterThan(retentionOf("ep-pos"));
    expect(retentionOf("ep-aro")).toBeGreaterThan(retentionOf("ep-calm"));
    // 便于复核具体数值仍落在 (0,1) 且舍入后不相等（避免浮点误判相等）。
    expect(retentionOf("ep-neg")).toBeCloseTo(Math.exp(-10 / 45), 4);
    expect(retentionOf("ep-aro")).toBeCloseTo(Math.exp(-10 / 19), 4);
  });
});