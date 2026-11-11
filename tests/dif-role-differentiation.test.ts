// ═══════════════════════════════════════════════════════════════════════════
// DIF01–DIF07 · 角色差异性确定性门槛（G2 硬阈值）
//
// 断言「角色差异全部由模板与数据表达，代码里没有任何角色名特例」：
//   DIF01 编译 —— compileMemoryPolicy 三模板 big_five 0.2/0.8 差异跟随字段；换名无关；
//              缺值中性；非法值（越界/非数字）拒绝/归一。
//   DIF02 打分 —— scoreMemorability 对同一触发在阈值内/外/等于阈值处产生预期 write；
//              独立参考 raw（手工推导不入参）；同模板重放逐字段相同。
//   DIF03 情节衰减 —— decaySweep + projectEpisode/renderMemoryCard：中性/负面情节在
//              0/24/72 虚拟小时跨越 0.70/0.45 注入边界呈现差异；原文不改（F1）。
//   DIF04 自省限幅 —— applyResult：不同起始 trust 的同证据 Δ 仍受同一直硬限幅（K3，
//              reason=k3_clamp）；缺 owner 证据整批拒绝；同自省重复提交 TOOL_DISABLED。
//   DIF05 知识状态机 —— classifyUpdate 纯函数迁移 + 讲者/听者归因（taughtBy 已知/未知）
//              + 睡眠日终衰减（mastered 抗、understood 降 fading）+ 误区 high / 真实意图
//              可见 / 已掌握非误区出队 + Q2 三日降档 + Q05 taught 双证据延迟成立与日终回补。
//   DIF06 用途检索 —— normalizeAssignablePurpose 三态 + recentByPurpose 两班两课 curriculum
//              过滤 / consolidated 纳入 / 默认至多 3 条 + recentPurposeKnowledgeSubjects
//              最近 5 条 knowledge 主体的重复集合 + Q09 教学进度独立 token 分账（≤3/≤200/≤2950）。
//   DIF07 未知第四角色 —— 只经公开 createRuntime 跑 创建/场景/记忆/自省/恢复，指纹稳定，
//              无角色名特例、非关键词零命中。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { compileMemoryPolicy } from "../src/compile/memory-policy.js";
import { defaultMemoryPolicy, type MemoryPolicy } from "../src/compile/types.js";
import { openRoleDb, type RoleDb } from "../src/db/db.js";
import { KnowledgeDao } from "../src/knowledge/dao.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { classifyUpdate } from "../src/knowledge/types.js";
import { RoleAccountRegistry } from "../src/mesh/accounts.js";
import { DISTORTION_THRESHOLDS, RETRIEVAL_BUDGET } from "../src/memory/constants.js";
import { MemoryDao } from "../src/memory/dao.js";
import { normalizeAssignablePurpose } from "../src/memory/purpose.js";
import { projectEpisode, renderMemoryCard, renderTeachingProgress } from "../src/memory/render.js";
import { scoreMemorability, type MemoryTrigger, type ScoreSignals } from "../src/memory/score.js";
import { ReflectionDao } from "../src/reflect/dao.js";
import { ReflectionService } from "../src/reflect/service.js";
import { createRuntime, type AgentFingerprint } from "../src/index.js";
import { writeRoleBlueprint } from "./helpers/role-agents.js";

// ─── 共享分组清理（DIF03 / DIF05 / DIF06 用 DB-A 直连）──────────────────────

const cleanups: Array<{ dir: string; roleDb: RoleDb }> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c.roleDb.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(c.dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

function dbHarness(prefix: string): {
  roleDb: RoleDb;
  db: Database.Database;
  memoryDao: MemoryDao;
  knowledgeDao: KnowledgeDao;
  knowledge: KnowledgeService;
} {
  const dir = mkdtempSync(join(tmpdir(), `pi-role-${prefix}-`));
  const roleDb = openRoleDb(join(dir, "role-agent.db"));
  cleanups.push({ dir, roleDb });
  const db = roleDb.db;
  let t = 0;
  const nowReal = (): string => new Date(Date.UTC(2026, 3, 1) + t++ * 1000).toISOString();
  const memoryDao = new MemoryDao(db, { nowReal });
  const knowledgeDao = new KnowledgeDao(db, { nowReal });
  const knowledge = new KnowledgeService({
    dao: knowledgeDao,
    knownAgents: () => new Set(["agent-tea", "agent-stu"]),
  });
  return { roleDb, db, memoryDao, knowledgeDao, knowledge };
}

interface EpRow {
  gist: string;
  detail: string | null;
  quote: string | null;
  emotion: string | null;
  valence: number | null;
  arousal: number | null;
  retention: number;
  status: string;
}
function ep(db: Database.Database, id: string): EpRow {
  return db
    .prepare<[string], EpRow>(
      `SELECT gist, detail, quote, emotion, valence, arousal, retention, status FROM episodes WHERE episode_id = ?`,
    )
    .get(id) as EpRow;
}

// ═══════════════════════════════════════════════════════════════════════════
// DIF01 · 编译差异只由模板字段驱动（无角色名特例）
// ═══════════════════════════════════════════════════════════════════════════

describe("DIF01 编译差异跟随模板字段（compileMemoryPolicy）", () => {
  it("big_five 0.2/0.8 三模板输出差异跟随字段（尽责性/开放性/神经质分别驱动）", () => {
    const low = compileMemoryPolicy({
      psychology: { big_five: { openness: 0.2, conscientiousness: 0.2, neuroticism: 0.2 } },
    });
    const high = compileMemoryPolicy({
      psychology: { big_five: { openness: 0.8, conscientiousness: 0.8, neuroticism: 0.8 } },
    });
    // 尽责性 ↑ ⇒ writeThreshold ↓（记得更多）、detailRetention ↑。
    expect(high.writeThreshold).toBeLessThan(low.writeThreshold);
    expect(high.detailRetention).toBeGreaterThan(low.detailRetention);
    // 开放性 ↑ ⇒ w.novelty ↑；神经质 ↑ ⇒ negativeBias / arousalGain ↑。
    expect(high.w.novelty).toBeGreaterThan(low.w.novelty);
    expect(high.negativeBias).toBeGreaterThan(low.negativeBias);
    expect(high.arousalGain).toBeGreaterThan(low.arousalGain);
  });

  it("换名不换倾向：同一字段两次编译逐字段相等（名字不在编译输入契约里）", () => {
    const input = { psychology: { big_five: { openness: 0.6, conscientiousness: 0.6, neuroticism: 0.6 } } };
    expect(compileMemoryPolicy(input)).toEqual(compileMemoryPolicy(input));
    // 差异只由 big_five 驱动：单独换掉一个字段，对应输出立即变，其余字段不动。
    const a = compileMemoryPolicy(input);
    const b = compileMemoryPolicy({ psychology: { big_five: { openness: 0.6, conscientiousness: 0.2, neuroticism: 0.6 } } });
    expect(b.writeThreshold).toBeGreaterThan(a.writeThreshold); // conscientiousness 0.8→0.2 ⇒ 阈值抬
    expect(b.w.novelty).toBe(a.w.novelty); // openness 未变 ⇒ novelty 不变
  });

  it("缺值中性 = defaultMemoryPolicy 基线，任何字段缺失都回退 0.5", () => {
    const neutral = compileMemoryPolicy({});
    const base = defaultMemoryPolicy();
    expect(neutral.writeThreshold).toBe(base.writeThreshold); // 0.5
    expect(neutral.detailRetention).toBe(base.detailRetention); // 0.5
    expect(neutral.w.novelty).toBe(1);
    expect(neutral.negativeBias).toBe(1);
    expect(neutral.arousalGain).toBe(1);
    // 有 psychology 但 big_five 全缺 → 仍中性。
    const partial = compileMemoryPolicy({ psychology: { big_five: {} } });
    expect(partial.writeThreshold).toBe(base.writeThreshold);
  });

  it("非法值拒绝：越界有限数 clamp 到 [0,1]，非数字回退中性（不产生越界产物）", () => {
    const clamped = compileMemoryPolicy({
      psychology: { big_five: { neuroticism: 5, conscientiousness: -3, openness: 1.5 } },
    });
    expect(clamped.negativeBias).toBe(2); // clamp01(5)=1 → gain=2
    expect(clamped.arousalGain).toBe(2);
    expect(clamped.w.novelty).toBe(2); // clamp01(1.5)=1 → gain=2
    expect(clamped.writeThreshold).toBeCloseTo(0.7); // clamp01(-3)=0 → 0.5-(0-0.5)*0.4
    expect(clamped.detailRetention).toBeCloseTo(0.3);
    // 非数字（NaN/字符串/Infinity）经 num 回退 0.5。
    const bad = compileMemoryPolicy({ psychology: { big_five: { conscientiousness: "high" as unknown as number } } });
    expect(bad.writeThreshold).toBe(defaultMemoryPolicy().writeThreshold);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DIF02 · 打分阈值内/外/等于阈值 + 同模板重放（scoreMemorability）
// ═══════════════════════════════════════════════════════════════════════════

describe("DIF02 打分阈值与重放（scoreMemorability）", () => {
  // 固定触发：中性、未被点名/提及、未知发送方（peer）。手工推导 raw：
  //   novelty=1（无 recentGists 比对）、arousal=0、selfRelevance=0.3（未点名/未提及），
  //   hintWeight=0（无 rememberHint）、repetition=0、authority=0.5（peer 缺省重）。
  //   raw = 1·1 + 1·0 + 1·0.3 + 1·0 + 1·0 + 1·0.5 = 1.8（独立参考值，不经 scoreMemorability 反推）。
  const neutralTrigger: MemoryTrigger = {
    messageId: "msg-1",
    from: "acct-other",
    text: "今天是个平常的日子",
    path: "P1",
    roleExt: {},
    kind: "chat",
    to: [],
    mentions: [],
  };
  const signals: ScoreSignals = {
    currentAccountId: "acct-me",
    senderRole: "peer",
    trustOfSender: 0.5,
    recentGists: [],
  };

  it("阈值内/外/等于阈值产生预期 write 差异（独立参考 raw=1.8）", () => {
    const at = (writeThreshold: number) =>
      scoreMemorability(neutralTrigger, { ...defaultMemoryPolicy(), writeThreshold }, signals);
    expect(at(1.7).write).toBe(true); // 阈值内（< raw）
    expect(at(1.8).write).toBe(true); // 等于阈值（>= 判定）
    expect(at(1.9).write).toBe(false); // 阈值外（> raw）
  });

  it("独立参考 raw 可由六路分量解释，salience 封顶 1", () => {
    const s = scoreMemorability(neutralTrigger, defaultMemoryPolicy(), signals);
    expect(s.components.novelty).toBe(1);
    expect(s.components.arousal).toBe(0);
    expect(s.components.selfRelevance).toBe(0.3);
    expect(s.components.hintWeight).toBe(0);
    expect(s.components.repetition).toBe(0);
    expect(s.components.authority).toBe(0.5);
    // 原始分 1.8 被 clamp 到 salience 1，但 write 仍按原始分对阈值判定。
    expect(s.salience).toBe(1);
  });

  it("同模板同输入重放得到相同 Score（逐字段一致）", () => {
    const p = defaultMemoryPolicy();
    expect(scoreMemorability(neutralTrigger, p, signals)).toEqual(scoreMemorability(neutralTrigger, p, signals));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DIF03 · 情节衰减：中性/负面跨越 0.70/0.45 注入边界（F1：原文不改）
// ═══════════════════════════════════════════════════════════════════════════

describe("DIF03 中性/负面情节衰减与失真裁剪", () => {
  const fastDecay: MemoryPolicy = { ...defaultMemoryPolicy(), tau0Hours: 24 };

  function seed(h: ReturnType<typeof dbHarness>, id: string, valence: number | null): void {
    h.memoryDao.insertEpisode({
      episodeId: id,
      ownerAgent: "agent-stu",
      kind: "event",
      sceneId: null,
      purposeKind: null,
      sourceMsgId: null,
      sourceSessionId: null,
      sourceEntryId: null,
      gist: id === "ep-n" ? "中性的一天" : "被当众批评",
      detail: id === "ep-n" ? "细节A" : "细节B",
      quote: id === "ep-n" ? "原话A" : "原话B",
      emotion: null,
      valence,
      arousal: 0,
      salience: 1.0,
      confidence: 0.8,
      accuracy: null,
      virtualTs: "W1D1T8",
      virtualHours: 0,
      retention: 1.0,
      status: "active",
      subjects: [],
    });
  }

  it("0/24/72 虚拟小时：负面衰减更慢，中性先掉 detail 再 faded，原文列保存不改", () => {
    const h = dbHarness("dif03");
    seed(h, "ep-n", null); // 中性
    seed(h, "ep-p", -1); // 负面

    // 0h：两条 retention=1，quote/detail 都在（>= 0.70）。
    const n0 = ep(h.db, "ep-n");
    const p0 = ep(h.db, "ep-p");
    expect(n0.retention).toBe(1);
    expect(projectEpisode(n0).quote).toBe("原话A");
    expect(projectEpisode(n0).detail).toBe("细节A");
    expect(projectEpisode(p0).quote).toBe("原话B");

    // 24h：retention 中性 exp(-1)≈0.368、负面 exp(-0.5)≈0.607。
    const r24 = h.memoryDao.decaySweep("agent-stu", 24, fastDecay);
    const n24 = ep(h.db, "ep-n");
    const p24 = ep(h.db, "ep-p");
    expect(n24.retention).toBeCloseTo(0.368, 2);
    expect(p24.retention).toBeCloseTo(0.607, 2);
    // 两条都跌下 0.70 quote 边界；只有中性跌下 0.45 detail 边界。
    expect(r24.quoteDropped).toContain("ep-n");
    expect(r24.quoteDropped).toContain("ep-p");
    expect(r24.detailDropped).toContain("ep-n");
    expect(r24.detailDropped).not.toContain("ep-p");
    // 注入边界裁剪：中性 0.368 < 0.45 全裁；负面 0.607 保留 detail、裁 quote。
    expect(projectEpisode(n24).detail).toBeUndefined();
    expect(projectEpisode(n24).quote).toBeUndefined();
    expect(projectEpisode(p24).detail).toBe("细节B");
    expect(projectEpisode(p24).quote).toBeUndefined();
    // F1：DB 原文列仍在（失真是注入端裁剪，不是存储清空）。
    expect(n24.detail).toBe("细节A");
    expect(n24.quote).toBe("原话A");

    // 72h：中性 exp(-3)≈0.05 < 0.15 → faded；负面 exp(-1.5)≈0.223 仍 active 但掉 detail。
    const r72 = h.memoryDao.decaySweep("agent-stu", 72, fastDecay);
    const n72 = ep(h.db, "ep-n");
    const p72 = ep(h.db, "ep-p");
    expect(n72.retention).toBeCloseTo(0.05, 2);
    expect(n72.status).toBe("faded");
    expect(p72.retention).toBeCloseTo(0.223, 2);
    expect(p72.status).toBe("active");
    expect(r72.newlyFaded).toContain("ep-n");
    expect(r72.newlyFaded).not.toContain("ep-p");
    expect(r72.detailDropped).toContain("ep-p"); // 负面 72h 才掉 detail
    // 原文列即便 faded 也不清空。
    expect(n72.quote).toBe("原话A");
    expect(n72.detail).toBe("细节A");
  });

  it("渲染卡片在 0.70/0.45 边界处把被裁字段呈现为「记不清」，而非静默省略", () => {
    const h = dbHarness("dif03");
    seed(h, "ep-n", null);
    seed(h, "ep-p", -1);
    h.memoryDao.decaySweep("agent-stu", 24, fastDecay);
    const p24 = ep(h.db, "ep-p");
    const n24 = ep(h.db, "ep-n");
    const cardP = renderMemoryCard({
      kind: "event",
      projected: projectEpisode(p24),
      retention: p24.retention,
      confidence: 0.8,
      virtualHours: 0,
      nowHours: 24,
      subjects: [],
    });
    expect(cardP).toContain("细节B"); // >= 0.45 保留细节
    expect(cardP).not.toContain("原话B"); // < 0.70 原话不注入
    const cardN = renderMemoryCard({
      kind: "event",
      projected: projectEpisode(n24),
      retention: n24.retention,
      confidence: 0.8,
      virtualHours: 0,
      nowHours: 24,
      subjects: [],
    });
    expect(cardN).toContain("记不清"); // 被裁字段显式兜底，非静默
    expect(cardN).not.toContain("细节A");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DIF04 · 自省 delta 硬限幅（不同起始 trust 同一直限幅）+ owner 证据 + exactly-once
// ═══════════════════════════════════════════════════════════════════════════

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
  send(m: SentMsg): Promise<{ messageId: string; seq: number }>;
}
type SimpleTool = (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: unknown }>;

describe("DIF04 自省限幅与 owner 证据", () => {
  function setUp(): {
    db: Database.Database;
    memoryDao: MemoryDao;
    reflectDao: ReflectionDao;
    registry: RoleAccountRegistry;
    service: ReflectionService;
    roleDb: RoleDb;
    dir: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-dif04-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    cleanups.push({ dir, roleDb });
    const db = roleDb.db;
    let t = 0;
    const nowReal = (): string => new Date(Date.UTC(2026, 1, 1) + t++ * 1000).toISOString();
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
      policyOf: async () => defaultMemoryPolicy(),
      resultTimeoutMs: 50,
    });
    const fake: ReflectFakeMesh = {
      sent: [],
      async ensureDirect(a, b) {
        return { id: `conv-${a}-${b}` };
      },
      async send(m) {
        fake.sent.push(m);
        return { messageId: `msg-${fake.sent.length}`, seq: fake.sent.length };
      },
    };
    service.attach(fake as unknown as Parameters<ReflectionService["attach"]>[0]);
    return { db, memoryDao, reflectDao, registry, service, roleDb, dir };
  }

  function addRole(r: RoleAccountRegistry, agentId: string, accountId: string): void {
    r.register({
      agentId,
      agentType: "role",
      accountId,
      endpointId: `ep-${agentId}`,
      reflectAccountId: `${accountId}:reflect`,
      reflectEndpointId: `ep-${agentId}-reflect`,
    });
  }

  function seedTrustOf(h: ReturnType<typeof setUp>, owner: string, id: string, trust: number): void {
    h.reflectDao.applyProfile(owner, { type: "person", id }, { trust }, { reason: "种子" });
  }

  function seedEp(h: ReturnType<typeof setUp>, owner: string, gist: string): string {
    const id = `ep-${Math.random().toString(36).slice(2, 8)}`;
    h.memoryDao.insertEpisode({
      episodeId: id,
      ownerAgent: owner,
      kind: "event",
      sceneId: null,
      purposeKind: null,
      sourceMsgId: null,
      sourceSessionId: null,
      sourceEntryId: null,
      gist,
      detail: null,
      quote: null,
      emotion: null,
      valence: null,
      arousal: null,
      salience: 0.7,
      confidence: 0.8,
      accuracy: null,
      virtualTs: "W1D1T8",
      virtualHours: 0,
      retention: 0.7,
      status: "active",
      subjects: [],
    });
    return id;
  }

  function trustOf(h: ReturnType<typeof setUp>, owner: string, id: string): number | null | undefined {
    return h.db
      .prepare<[string, string, string], { trust: number | null }>(
        `SELECT trust FROM subject_profiles WHERE owner_agent = ? AND subject_type = ? AND subject_id = ?`,
      )
      .get(owner, "person", id)?.trust;
  }

  it("不同起始 trust 的同证据 Δ 受同一直限幅到 ±0.15，reason=k3_clamp", async () => {
    const h = setUp();
    addRole(h.registry, "agent-stu", "acct-stu");
    seedTrustOf(h, "agent-stu", "agent-a", 0.2);
    seedTrustOf(h, "agent-stu", "agent-b", 0.8);
    seedEp(h, "agent-stu", "一段经历");

    await h.service.run("agent-stu", { trigger: "manual" });
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as SimpleTool;
    const out = await reflect_result("tc-1", {
      updates: {
        profileUpdates: [
          { subject: "person:agent-a", trustDelta: 0.3 },
          { subject: "person:agent-b", trustDelta: 0.3 },
        ],
      },
    });
    expect(JSON.parse(String(out.content)).ok).toBe(true);

    // 0.2 → 0.35；0.8 → 0.95：只各自 +0.15，超出的 +0.15 被截掉。
    expect(trustOf(h, "agent-stu", "agent-a")).toBeCloseTo(0.35, 5);
    expect(trustOf(h, "agent-stu", "agent-b")).toBeCloseTo(0.95, 5);
    // 审计留痕 reason=k3_clamp。
    const clampedRows = h.db
      .prepare(`SELECT COUNT(*) AS n FROM state_writes WHERE owner_agent = 'agent-stu' AND reason = 'k3_clamp'`)
      .get() as { n: number };
    expect(clampedRows.n).toBeGreaterThanOrEqual(2);
  });

  it("缺 owner 证据整批拒绝：consolidation 引用他人情节 → 画像不变", async () => {
    const h = setUp();
    addRole(h.registry, "agent-stu", "acct-stu");
    // 他人（agent-other）的情节，agent-stu 无权引用。
    h.reflectDao.applyProfile("agent-other", { type: "person", id: "x" }, { trust: 0.5 }, { reason: "种子" });
    seedTrustOf(h, "agent-stu", "agent-a", 0.5);

    await h.service.run("agent-stu", { trigger: "manual" });
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as SimpleTool;
    const out = await reflect_result("tc-1", {
      updates: {
        profileUpdates: [{ subject: "person:agent-a", trustDelta: 0.1 }],
        consolidations: [{ episodeIds: ["ep-not-owned"], gist: "摘要" }],
      },
    });
    expect(JSON.parse(String(out.content)).error.code).toBe("ARG_INVALID");
    // 整批拒绝：trust 未动（仍 0.5）——即使 profileUpdates 合法。
    expect(trustOf(h, "agent-stu", "agent-a")).toBeCloseTo(0.5, 5);
  });

  it("同自省 repeat 不重复生效：二次 reflect_result → TOOL_DISABLED", async () => {
    const h = setUp();
    addRole(h.registry, "agent-stu", "acct-stu");
    seedTrustOf(h, "agent-stu", "agent-a", 0.4);

    await h.service.run("agent-stu", { trigger: "manual" });
    const handlers = await h.service.reflectResultHandlerFor("acct-stu:reflect");
    const reflect_result = handlers.reflect_result as SimpleTool;
    const first = await reflect_result("tc-1", {
      updates: { profileUpdates: [{ subject: "person:agent-a", trustDelta: 0.1 }] },
    });
    expect(JSON.parse(String(first.content)).ok).toBe(true);
    const second = await reflect_result("tc-2", {
      updates: { profileUpdates: [{ subject: "person:agent-a", trustDelta: 0.1 }] },
    });
    expect(JSON.parse(String(second.content)).error.code).toBe("TOOL_DISABLED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DIF05 · 知识状态机 + 讲者/听者归因 + 日终衰减 + 学习队列
// ═══════════════════════════════════════════════════════════════════════════

describe("DIF05 知识状态机与学习队列", () => {
  it("classifyUpdate 纯函数：已掌握/薄弱/误区初态迁移判定不同", () => {
    // 薄弱（unseen）→ heard，仅 mentioned 放行。
    expect(classifyUpdate(null, "heard", "mentioned")).toMatchObject({ ok: true, to: "heard", events: "one" });
    expect(classifyUpdate(null, "heard", "explained")).toMatchObject({ ok: false, reason: "EVIDENCE_MISSING" });
    // 已掌握 mastered 同态复述（T6）：只维护计数，不迁移、无事件。
    expect(classifyUpdate("mastered", "mastered", "explained")).toMatchObject({ ok: true, to: "mastered", events: "none" });
    // 误区（T11）：applied + corrected → understood + 置误区。
    expect(classifyUpdate("applied", "understood", "corrected")).toMatchObject({ ok: true, to: "understood", markMisconception: true });
    // 跳级（T5）：heard + solved → applied。
    expect(classifyUpdate("heard", "applied", "solved")).toMatchObject({ ok: true, to: "applied", events: "skip" });
    // 已掌握到 mastered 只能经 applied，不能由 understood 直接跳（T4 非法边）。
    expect(classifyUpdate("understood", "mastered", "taught")).toMatchObject({ ok: false, reason: "ILLEGAL_TRANSITION" });
  });

  it("讲者/听者归因：person 已知进 taughtBy、未知退回 self", () => {
    const h = dbHarness("dif05");
    const known = h.knowledge.applyUpdate(
      "agent-stu",
      { topic: "kn:listened", toMastery: "heard", evidenceKind: "mentioned", evidence: "被王老师讲解", taughtBy: "person:agent-tea" },
      { virtualTs: "W1D1T8" },
    );
    expect(known.ok).toBe(true);
    expect(h.knowledgeDao.item("agent-stu", "kn:listened")?.taughtBy).toBe("person:agent-tea");

    const unknown = h.knowledge.applyUpdate(
      "agent-stu",
      { topic: "kn:unknown", toMastery: "heard", evidenceKind: "mentioned", evidence: "被陌生人讲", taughtBy: "person:stranger" },
      { virtualTs: "W1D1T8" },
    );
    expect(unknown.ok).toBe(true);
    expect(h.knowledgeDao.item("agent-stu", "kn:unknown")?.taughtBy).toBe("self");
  });

  it("睡眠日终：已掌握（mastered）抗衰减，薄弱（understood）多日后降 fading", () => {
    const h = dbHarness("dif05");
    h.knowledgeDao.seedItem({ owner: "agent-stu", topic: "kn:weak", claim: "懂但没掌握", mastery: "understood", firstSeenAt: "2026-04-01T00:00:00.000Z" });
    h.knowledgeDao.seedItem({ owner: "agent-stu", topic: "kn:done", claim: "已掌握", mastery: "mastered", firstSeenAt: "2026-04-01T00:00:00.000Z" });

    // 连续 14 个「睡眠日终」节拍（每 24 虚拟小时一次）。
    for (let vh = 24; vh <= 336; vh += 24) h.knowledge.decay("agent-stu", vh, 168);

    const weak = h.knowledgeDao.item("agent-stu", "kn:weak");
    const done = h.knowledgeDao.item("agent-stu", "kn:done");
    expect(weak?.mastery).toBe("fading"); // understood 跌破 0.35 → fading
    expect(weak?.decayFrom).toBe("understood"); // 记录衰减前状态（A14）
    expect(done?.mastery).toBe("mastered"); // mastered 因子 4×，抗衰减
    expect(done?.decayFrom).toBeNull();
  });

  it("学习队列：误区自动 high 且不泄答案、真实意图可见、已掌握非误区出队", () => {
    const h = dbHarness("dif05");
    h.knowledgeDao.seedItem({
      owner: "agent-stu",
      topic: "kn:mis",
      claim: "我以为对的其实是错的",
      mastery: "heard",
      isMisconception: true,
      wrongBelief: "我原来错的想法",
      firstSeenAt: "2026-04-01T00:00:00.000Z",
    });
    h.knowledgeDao.seedItem({ owner: "agent-stu", topic: "kn:done", claim: "已掌握", mastery: "mastered", firstSeenAt: "2026-04-01T00:00:00.000Z" });

    const q = h.knowledge.organizeLearningQueue("agent-stu", [
      { topic: "kn:weak", priority: "medium", motivation: "想彻底搞懂" },
      { topic: "kn:done", priority: "high", motivation: "复习已掌握" },
    ]);

    const mis = q.find((i) => i.topic === "kn:mis");
    const weak = q.find((i) => i.topic === "kn:weak");
    expect(mis?.priority).toBe("high"); // 误区自动入队并置 high（Q4）
    expect(mis?.motivation).toBe("我好像哪里没搞对"); // 系统模糊语，绝不把 wrong_belief 带入
    expect(mis?.motivation).not.toContain("我原来错的想法");
    expect(weak?.priority).toBe("medium"); // 真实意图原样保留
    expect(weak?.motivation).toBe("想彻底搞懂");
    expect(q.find((i) => i.topic === "kn:done")).toBeUndefined(); // Q1：mastered 且非误区出队
  });

  it("Q2 三日降档：连续 3 虚拟日未触及 high→medium、medium→low、low 出队（2 日不降）", () => {
    const h = dbHarness("dif05");
    // 学习队列随自省 output_json 落库；lastLearningQueue 取最新一条 done 反射的 learningQueue。
    // 用递增 started_at 确保每次 push 都成为「最新」。
    let seq = 0;
    const pushQueue = (items: Array<{ topic: string; priority: string; enqueuedVhours: number }>): void => {
      seq += 1;
      h.db
        .prepare(
          `INSERT INTO reflections (reflection_id, owner_agent, trigger, status, input_json, output_json, started_at)
           VALUES (?, 'agent-stu', 'scene_end', 'done', '{}', ?, ?)`,
        )
        .run(
          `rf-q2-${seq}`,
          JSON.stringify({ learningQueue: items.map((i) => ({ ...i, motivation: "想做" })) }),
          new Date(Date.UTC(2026, 3, 1, 0, 0, seq)).toISOString(),
        );
    };

    pushQueue([
      { topic: "kn:high", priority: "high", enqueuedVhours: 0 },
      { topic: "kn:med", priority: "medium", enqueuedVhours: 0 },
      { topic: "kn:low", priority: "low", enqueuedVhours: 0 },
    ]);

    // 2 个虚拟日（48h）：未到 3 日，三档都不动。
    const q2 = h.knowledge.organizeLearningQueue("agent-stu", [], { virtualHours: 48 });
    expect(q2.find((i) => i.topic === "kn:high")?.priority).toBe("high");
    expect(q2.find((i) => i.topic === "kn:med")?.priority).toBe("medium");
    expect(q2.find((i) => i.topic === "kn:low")?.priority).toBe("low");

    // 3 个虚拟日（72h）：high→medium、medium→low、low→出队。
    const q3 = h.knowledge.organizeLearningQueue("agent-stu", [], { virtualHours: 72 });
    expect(q3.find((i) => i.topic === "kn:high")?.priority).toBe("medium");
    expect(q3.find((i) => i.topic === "kn:med")?.priority).toBe("low");
    expect(q3.find((i) => i.topic === "kn:low")).toBeUndefined();
  });

  it("Q05 taught 双证据：讲者先记 pending，听者迁移后日终回补成立 mastered", () => {
    const h = dbHarness("dif05");
    // 讲者已有 applied 的 kn:topic（applyUpdate 走 applied→mastered 的 taught 边）。
    h.knowledgeDao.seedItem({
      owner: "agent-tea",
      topic: "kn:topic",
      claim: "topic",
      mastery: "applied",
      firstSeenAt: "2026-04-01T00:00:00.000Z",
    });
    // 条件①：讲者自己的双主体情节（person:agent-stu + knowledge:kn:topic）。
    h.memoryDao.insertEpisode({
      episodeId: "ep-teach",
      ownerAgent: "agent-tea",
      kind: "event",
      sceneId: null,
      purposeKind: "teaching_progress",
      sourceMsgId: null,
      sourceSessionId: null,
      sourceEntryId: null,
      gist: "我教了 agent-stu 这个知识点",
      detail: null,
      quote: null,
      emotion: null,
      valence: null,
      arousal: null,
      salience: 0.7,
      confidence: 0.8,
      accuracy: null,
      virtualTs: "W2D1T8",
      virtualHours: 0,
      retention: 0.7,
      status: "active",
      subjects: [
        { ref: { type: "person", id: "agent-stu" } },
        { ref: { type: "knowledge", id: "kn:topic" } },
      ],
    });

    // 讲者自省 taught→mastered：条件②（听者已迁移）不齐，本轮不成立、只记 pending。
    const verdict = h.knowledge.applyUpdate(
      "agent-tea",
      { topic: "kn:topic", toMastery: "mastered", evidenceKind: "taught", evidence: "教过", evidenceEpisode: "ep-teach" },
      { virtualTs: "W2D1T8" },
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.taughtPending?.listener).toBe("person:agent-stu");
    expect(h.knowledgeDao.item("agent-tea", "kn:topic")?.mastery).toBe("applied"); // 未成立 mastered

    // 听者仍未迁移时日终回补：不推广，pending 保持 open。
    expect(h.knowledge.backfillPendingTaught("agent-tea", { virtualTs: "W2D1T12", virtualHours: 4 })).toBe(0);
    expect(h.knowledgeDao.item("agent-tea", "kn:topic")?.mastery).toBe("applied");

    // 听者侧迁移：unseen→heard（mentioned）再 heard→understood（explained，归因讲者）。
    expect(
      h.knowledge.applyUpdate("agent-stu", { topic: "kn:topic", toMastery: "heard", evidenceKind: "mentioned", evidence: "被提到" }, { virtualTs: "W2D1T9" }).ok,
    ).toBe(true);
    const listenerUpd = h.knowledge.applyUpdate(
      "agent-stu",
      { topic: "kn:topic", toMastery: "understood", evidenceKind: "explained", evidence: "老师讲过", taughtBy: "person:agent-tea" },
      { virtualTs: "W2D1T10" },
    );
    expect(listenerUpd.ok).toBe(true);

    // 日终回补：条件②齐 → 讲者条目升 mastered，写一条 taught 事件。
    expect(h.knowledge.backfillPendingTaught("agent-tea", { virtualTs: "W2D1T12", virtualHours: 4 })).toBe(1);
    expect(h.knowledgeDao.item("agent-tea", "kn:topic")?.mastery).toBe("mastered");
    const taughtEvents = h.db
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_events ev
           JOIN knowledge_items ki ON ki.kn_id = ev.kn_id
          WHERE ev.owner_agent = 'agent-tea' AND ki.topic = 'kn:topic' AND ev.evidence_kind = 'taught'`,
      )
      .get() as { n: number };
    expect(taughtEvents.n).toBe(1);

    // 幂等：pending 已 resolved，再回补不重复推广。
    expect(h.knowledge.backfillPendingTaught("agent-tea", { virtualTs: "W2D1T12", virtualHours: 4 })).toBe(0);
    expect(h.knowledgeDao.item("agent-tea", "kn:topic")?.mastery).toBe("mastered");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DIF06 · 通用进度检索：两班两课过滤 / consolidated / 默认至多 3 条 / 最近 5 条
// ═══════════════════════════════════════════════════════════════════════════

describe("DIF06 通用进度（teaching_progress）检索与重复检测", () => {
  it("normalizeAssignablePurpose 三态：合法 / 缺席 / 非法", () => {
    expect(normalizeAssignablePurpose("teaching_progress")).toEqual({ ok: true, purposeKind: "teaching_progress" });
    expect(normalizeAssignablePurpose(undefined)).toEqual({ ok: true, purposeKind: null });
    expect(normalizeAssignablePurpose("made_up")).toEqual({ ok: false });
    expect(normalizeAssignablePurpose(42)).toEqual({ ok: false });
  });

  it("两班两课 curriculum 过滤 + consolidated 纳入 + 默认至多 3 条", () => {
    const h = dbHarness("dif06");
    const seed = (id: string, curriculumId: string, vh: number, status: "active" | "faded" | "consolidated", kns: string[]): void => {
      h.memoryDao.insertEpisode({
        episodeId: id,
        ownerAgent: "agent-stu",
        kind: "event",
        sceneId: null,
        purposeKind: "teaching_progress",
        sourceMsgId: null,
        sourceSessionId: null,
        sourceEntryId: null,
        gist: `进度 ${id}`,
        detail: null,
        quote: null,
        emotion: null,
        valence: null,
        arousal: null,
        salience: 0.7,
        confidence: 0.8,
        accuracy: null,
        virtualTs: "W1D1T8",
        virtualHours: vh,
        retention: 0.7,
        status,
        subjects: [
          { ref: { type: "curriculum", id: curriculumId } },
          ...kns.map((k) => ({ ref: { type: "knowledge" as const, id: k } })),
        ],
      });
    };
    seed("ep1", "cur:mech", 100, "active", ["kn:a", "kn:b"]);
    seed("ep2", "cur:chem", 90, "active", ["kn:c"]);
    seed("ep3", "cur:mech", 80, "consolidated", ["kn:a"]); // 同一知识主体与 ep1 重复
    seed("ep4", "cur:mech", 70, "faded", ["kn:d"]); // faded 不参与注入

    // curriculum 过滤：只看 mech，active/consolidated 纳入，faded 排（ep4 不出）。
    const mech = h.memoryDao.recentByPurpose("agent-stu", "teaching_progress", { curriculumId: "cur:mech" });
    expect(mech.map((c) => c.episodeId)).toEqual(["ep1", "ep3"]);

    // 无 curriculum：跨课程、默认 limit 3（ep1/2/3，ep4 faded 排）。
    const all = h.memoryDao.recentByPurpose("agent-stu", "teaching_progress");
    expect(all.map((c) => c.episodeId)).toEqual(["ep1", "ep2", "ep3"]);
    expect(all.length).toBe(3);
  });

  it("最近 5 条 knowledge 主体（含 faded）供重复集合检出", () => {
    const h = dbHarness("dif06");
    const seed = (id: string, vh: number, kns: string[]): void => {
      h.memoryDao.insertEpisode({
        episodeId: id,
        ownerAgent: "agent-stu",
        kind: "event",
        sceneId: null,
        purposeKind: "teaching_progress",
        sourceMsgId: null,
        sourceSessionId: null,
        sourceEntryId: null,
        gist: `进度 ${id}`,
        detail: null,
        quote: null,
        emotion: null,
        valence: null,
        arousal: null,
        salience: 0.7,
        confidence: 0.8,
        accuracy: null,
        virtualTs: "W1D1T8",
        virtualHours: vh,
        retention: 0.7,
        status: "active",
        subjects: kns.map((k) => ({ ref: { type: "knowledge" as const, id: k } })),
      });
    };
    seed("ep1", 100, ["kn:a", "kn:b"]);
    seed("ep2", 90, ["kn:c"]);
    seed("ep3", 80, ["kn:a"]); // kn:a 重复出现 → 可检出

    const rpk = h.memoryDao.recentPurposeKnowledgeSubjects("agent-stu", "teaching_progress", 5);
    expect(rpk.map((g) => g.episodeId)).toEqual(["ep1", "ep2", "ep3"]); // 时间倒序
    expect(rpk.filter((g) => g.knowledgeIds.includes("kn:a")).length).toBe(2); // 重复集合可检出
  });

  it("Q09 教学进度独立分账：≤200 token / 不占 L1 / 总额 ≤2950 / tokens_purpose 落库", () => {
    // 常量口径：独立配额不吃 L1 的 900 池；总台线 2950 = 2750 + 200。
    expect(RETRIEVAL_BUDGET.teachingProgress).toBe(200);
    expect(RETRIEVAL_BUDGET.totalWithProgress).toBe(2950);
    expect(RETRIEVAL_BUDGET.total + RETRIEVAL_BUDGET.teachingProgress).toBe(RETRIEVAL_BUDGET.totalWithProgress);

    // 空候选 → 不注入。
    expect(renderTeachingProgress([], RETRIEVAL_BUDGET.teachingProgress)).toBeNull();

    // 三条里程碑：PROGRESS 卡 + 绝对虚拟日标签 + 总额不超配额。
    const cands = [
      { gist: "讲完牛顿第二定律", virtualHours: 200 },
      { gist: "讲完动能定理", virtualHours: 272 },
      { gist: "讲完动量守恒", virtualHours: 344 },
    ];
    const card = renderTeachingProgress(cands, RETRIEVAL_BUDGET.teachingProgress);
    expect(card).not.toBeNull();
    expect(card!.text).toContain("<<<PROGRESS");
    expect(card!.text).toContain("[最近讲到哪里]");
    expect(card!.text).toContain("[W1D1]"); // 200 虚拟小时 = ((1*7+1)*24+8)/24 → W1D1
    expect(card!.text).toContain("讲完牛顿第二定律");
    expect(card!.tokens).toBeLessThanOrEqual(RETRIEVAL_BUDGET.teachingProgress);

    // 硬上限截断：极小预算连 header+close 都装不下 → 不注入。
    expect(renderTeachingProgress([{ gist: "A", virtualHours: 200 }], 5)).toBeNull();

    // 预算只够 header+第一行：第二个里程碑被裁掉，token 不超预算。
    const one = renderTeachingProgress(
      [{ gist: "A", virtualHours: 200 }, { gist: "B" + "长".repeat(40), virtualHours: 272 }],
      20,
    );
    expect(one).not.toBeNull();
    expect(one!.text).toContain("[W1D1] A");
    expect(one!.text).not.toContain("长");
    expect(one!.tokens).toBeLessThanOrEqual(20);

    // 分账落库：tokens_purpose 独立列，不进 l1/transient；总额照实求和。
    const h = dbHarness("dif09");
    h.memoryDao.insertRetrievalLog({
      ownerAgent: "agent-stu",
      queryJson: "{}",
      candidates: 0,
      selectedJson: "[]",
      tokensL2: 10,
      tokensL1: 20,
      tokensTransient: 30,
      tokensPurpose: 40,
      tokensTotal: 100,
      clamped: 0,
      renderedCard: "x",
      cardSha256: "y",
    });
    const row = h.db.prepare(`SELECT tokens_purpose, tokens_total FROM retrieval_log`).get() as {
      tokens_purpose: number;
      tokens_total: number;
    };
    expect(row.tokens_purpose).toBe(40);
    expect(row.tokens_total).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DIF07 · 未知第四角色端到端（只经公开 createRuntime）
// ═══════════════════════════════════════════════════════════════════════════

describe("DIF07 未知第四角色端到端（无角色名特例）", () => {
  it("create → 场景 → 记忆 → 自省 → 重启恢复，指纹稳定且非零命中", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-dif07-"));
    const dbPath = join(dir, "role-agent.db");

    // 预置一条要「回忆」的记忆（让记忆/回放非零命中，而非关键词零命中）。
    {
      const roleDb = openRoleDb(dbPath);
      try {
        let t = 0;
        const nowReal = (): string => new Date(Date.UTC(2026, 5, 1) + t++ * 1000).toISOString();
        new MemoryDao(roleDb.db, { nowReal }).insertEpisode({
          episodeId: "ep-seed",
          ownerAgent: "counselor", // 未知第四角色名，不在 teacher/student/principal 封闭集
          kind: "event",
          sceneId: null,
          purposeKind: null,
          sourceMsgId: null,
          sourceSessionId: null,
          sourceEntryId: null,
          gist: "鼻血滴到了练习册上",
          detail: null,
          quote: null,
          emotion: null,
          valence: null,
          arousal: 0,
          salience: 0.8,
          confidence: 0.8,
          accuracy: null,
          virtualTs: "W1D1T8",
          virtualHours: 0,
          retention: 0.8,
          status: "active",
          subjects: [],
        });
      } finally {
        roleDb.close();
      }
    }

    const blueprint = writeRoleBlueprint(dir, "counselor");
    const agentId = "counselor";
    let f1: AgentFingerprint;

    // ① 首次打开：创建 + 场景 + 记忆 + 自省 + 回放指纹。
    {
      const rt = await createRuntime({
        root: dir,
        db: dbPath,
        fake: { streamPort: true, sessions: true, usageForTurn: () => 50 },
      });
      try {
        const created = await rt.agents.create({ blueprint, agentId, displayName: "辅导员" });
        expect(created.blueprintHash).toBeTruthy();
        expect(created.mesh.accountId).toBe(agentId);

        await rt.scenes.create({
          sceneId: "s1",
          participants: [{ agentId, role: "host" }],
          floorMode: "director",
          maxTurns: 2,
        });
        const res = await rt.scenes.run("s1", undefined, { maxTurns: 2 });
        expect(res.stopReason).toBe("max_turns");
        expect(res.turnsCompleted).toBe(2);

        // 记忆：非零命中（预置的情节），owner 门面一致。
        const recall = await rt.memory.recall(agentId, "练习册");
        expect(recall.ownerAgent).toBe(agentId);
        expect(recall.items.length).toBeGreaterThanOrEqual(1);
        const stats = await rt.memory.stats();
        const me = stats.agents.find((a) => a.agentId === agentId);
        expect(me).toBeDefined();
        expect(me?.episodes).toBeGreaterThanOrEqual(1);

        // 自省：manual → full 且 cue 已发（自省流账号对未知角色照常注册）。
        const rr = await rt.reflect.run(agentId, { trigger: "manual" });
        expect(rr.depth).toBe("full");
        expect(rr.sent).toBe(true);

        f1 = (await rt.replay.record(agentId)).fingerprint;
        expect(f1.blueprintHash).toBe(created.blueprintHash);
        expect(f1.specHash).toBeTruthy();
      } finally {
        await rt.close();
      }
    }

    // ② 重启恢复：同一 root/db 重开，指纹不变、记忆仍在。
    {
      const rt = await createRuntime({
        root: dir,
        db: dbPath,
        fake: { streamPort: true, sessions: true },
      });
      try {
        const f2 = (await rt.replay.record(agentId)).fingerprint;
        expect(f2.blueprintHash).toBe(f1.blueprintHash);
        expect(f2.specHash).toBe(f1.specHash);
        const recall = await rt.memory.recall(agentId, "练习册");
        expect(recall.items.length).toBeGreaterThanOrEqual(1);
      } finally {
        await rt.close();
      }
    }

    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});