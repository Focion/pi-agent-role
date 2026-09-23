// ═══════════════════════════════════════════════════════════════════════════
// ReflectionService（§13 自省 / §15.2 巩固）—— 触发器分级 + 自省往返 + 结论落地
//
// 三件事：
//   1. `run`　　—— 按触发器分级（skip/light/full），light 只做衰减 sweep，full 组装输入、
//      注册 reflections 行、经 mesh.request(expect:"ack") 把 cue 发给自省流（§13.4.1）。
//   2. `reflect_result` 处理器 —— 自省流唯一的领域工具，落地结构化结论（画像回写 + 巩固 +
//      自我洞察 + 状态微调），一趟自省恰好一次（二次调用 TOOL_DISABLED）。
//   3. `applyResult` —— 落地不变量：delta 限幅（K3）、同主体合并、owner 证据校验、全量审计。
//
// 分层纪律：本文件属于 `src/reflect/**`，不 import @pi/agent-mesh（R1，mesh 类型经
// public-types 再出口）、不出现 mesh_ 表名（R2）、不出现环境字段 ext 的点访问（R3）。
// ═══════════════════════════════════════════════════════════════════════════

import { defaultMemoryPolicy, type MemoryPolicy } from "../compile/types.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { RoleAccountRegistry } from "../mesh/accounts.js";
import type { Conversation, MeshHost, MeshToolResult } from "../mesh/public-types.js";
import type { DomainToolHandlers, ToolExecute } from "../mesh/tools.js";
import type { MemoryDao } from "../memory/dao.js";
import { parseSubjectRef, serializeSubjectRef, type SubjectRef } from "../memory/subject.js";
import { newId } from "../runtime/id.js";
import { virtualHoursOf } from "../runtime/virtual-clock.js";
import { ReflectionDao, type EpisodeBrief } from "./dao.js";
import type {
  ProfileDelta,
  ReflectionApplyResult,
  ReflectionDepth,
  ReflectionInput,
  ReflectionOutput,
  ReflectionRunResult,
  ReflectSnapshot,
  ReflectionTrigger,
} from "./types.js";

/** 虚拟时钟缺失/非法时的兜底起点（与 MemoryService 的默认起点一致）。 */
const DEFAULT_VIRTUAL_START = "W1D1T8";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 限幅一个 Δ 到 ±cap（K3）。 */
const clampDelta = (x: number, cap: number): number => Math.max(-cap, Math.min(cap, x));

function toolError(code: "ARG_INVALID" | "TOOL_DISABLED", message: string): MeshToolResult {
  return { content: JSON.stringify({ error: { code, message } }) };
}

export interface ReflectionServiceDeps {
  dao: ReflectionDao;
  /** 复用记忆写入（巩固/自我洞察的新情节 + 衰减 sweep）。 */
  memoryDao: MemoryDao;
  /** 知识迁移校验与落库（§17.2）—— applyResult 第 ④ 步的裁决者。 */
  knowledge: KnowledgeService;
  registry: RoleAccountRegistry;
  /** 逐主账号解析记忆策略（反射限幅四个 cap 的来源）。 */
  policyOf: (accountId: string) => Promise<MemoryPolicy | undefined>;
}

/** 一次进行中的自省回合（reflect 账号 → 内存态；落库真值在 reflections 行）。 */
interface InFlight {
  reflectionId: string;
  owner: string;
  virtualTs: string;
  virtualHours: number;
  sceneId?: string;
}

export class ReflectionService {
  private readonly dao: ReflectionDao;
  private readonly memoryDao: MemoryDao;
  private readonly knowledge: KnowledgeService;
  private readonly registry: RoleAccountRegistry;
  private readonly policyOf: (accountId: string) => Promise<MemoryPolicy | undefined>;

  /** reflect accountId → 进行中的自省回合。落地即删（恰好一次的自然屏障）。 */
  private readonly inFlight = new Map<string, InFlight>();
  /** agentId → 自省流会话 id（ensureDirect 幂等，首查后缓存）。 */
  private readonly reflectConv = new Map<string, string>();
  private readonly policyCache = new Map<string, MemoryPolicy>();
  private mesh?: Pick<MeshHost, "send" | "ensureDirect">;

  constructor(deps: ReflectionServiceDeps) {
    this.dao = deps.dao;
    this.memoryDao = deps.memoryDao;
    this.knowledge = deps.knowledge;
    this.registry = deps.registry;
    this.policyOf = deps.policyOf;
  }

  attach(mesh: Pick<MeshHost, "send" | "ensureDirect">): void {
    this.mesh = mesh;
  }

  private async policyFor(accountId: string): Promise<MemoryPolicy> {
    const hit = this.policyCache.get(accountId);
    if (hit) return hit;
    const policy = (await this.policyOf(accountId)) ?? defaultMemoryPolicy();
    this.policyCache.set(accountId, policy);
    return policy;
  }

  // ─── 触发器入口 ───────────────────────────────────────────────────────────

  /** 按触发器跑一次分级自省（§13.2/§13.3）。缺省 trigger=manual，virtualTs 取上次残余或默认起点。 */
  async run(
    agentId: string,
    opts: {
      trigger?: ReflectionTrigger;
      sceneId?: string;
      virtualTs?: string;
      preCompactMessages?: Array<{ msgId: string; text: string }>;
    } = {},
  ): Promise<ReflectionRunResult> {
    const trigger = opts.trigger ?? "manual";
    const rec = this.registry.byAgentId(agentId);
    if (!rec || rec.agentType !== "role") {
      return { agentId, trigger, depth: "skip", sent: false, skipped: "not a role agent" };
    }
    const policy = await this.policyFor(rec.accountId);
    const since = this.dao.lastReflectionAt(agentId);
    const { count, entries, maxArousal } = this.dao.episodesSince(agentId, since ?? "");
    const depth = this.grade(agentId, trigger, count, maxArousal, policy);

    const result: ReflectionRunResult = { agentId, trigger, depth, sent: false };
    if (depth === "skip") {
      result.skipped = `episodes_since=${count} < ${policy.reflection.episodesPerReflection}`;
      return result;
    }

    const virtualTs = opts.virtualTs ?? DEFAULT_VIRTUAL_START;
    if (depth === "light") {
      const sweep = this.memoryDao.decaySweep(agentId, virtualHoursOf(virtualTs), policy);
      result.decayed = sweep.scanned;
      return result;
    }

    // full：组装输入 + 发 cue。没有自省流（P4 注册失败/旧数据）时降级为 light。
    if (!rec.reflectAccountId) {
      const sweep = this.memoryDao.decaySweep(agentId, virtualHoursOf(virtualTs), policy);
      result.decayed = sweep.scanned;
      result.skipped = "no reflect account";
      return result;
    }

    const input = this.assembleInput(agentId, trigger, {
      count,
      entries,
      maxArousal,
      since,
      virtualTs,
      sceneId: opts.sceneId,
      preCompactMessages: opts.preCompactMessages,
    });
    const reflectionId = newId("rf");
    const reflectMsgId = await this.send(agentId, rec.accountId, rec.reflectAccountId, input);
    this.dao.insertReflection({
      reflectionId,
      ownerAgent: agentId,
      trigger,
      sceneId: opts.sceneId ?? null,
      reflectMsgId,
      inputJson: JSON.stringify(input),
      status: "running",
      startedAt: new Date().toISOString(),
    });
    this.inFlight.set(rec.reflectAccountId, {
      reflectionId,
      owner: agentId,
      virtualTs: input.virtualTs,
      virtualHours: input.virtualHours,
      sceneId: opts.sceneId,
    });
    result.sent = true;
    result.reflectionId = reflectionId;
    return result;
  }

  /** 阈值触发器（episodes_since / daily）：未达阈值返回 undefined，达阈值返回 run 结果。 */
  async maybe(
    agentId: string,
    trigger: ReflectionTrigger,
    opts: { sceneId?: string; virtualTs?: string } = {},
  ): Promise<ReflectionRunResult | undefined> {
    const rec = this.registry.byAgentId(agentId);
    if (!rec || rec.agentType !== "role") return undefined;
    const policy = await this.policyFor(rec.accountId);
    const since = this.dao.lastReflectionAt(agentId);
    const { count } = this.dao.episodesSince(agentId, since ?? "");
    if (trigger === "episodes_since" && count < policy.reflection.episodesPerReflection) return undefined;
    if (trigger === "daily" && count === 0) return undefined;
    return this.run(agentId, { trigger, ...opts });
  }

  /** 对全部 role agent 逐个跑一次（scene_end / daily 等广播触发器）。 */
  async runAll(opts: { trigger: ReflectionTrigger; sceneId?: string; virtualTs?: string }): Promise<ReflectionRunResult[]> {
    const out: ReflectionRunResult[] = [];
    for (const agentId of this.registry.allAgentIds()) {
      const rec = this.registry.byAgentId(agentId);
      if (!rec || rec.agentType !== "role") continue;
      out.push(await this.run(agentId, opts));
    }
    return out;
  }

  /**
   * 压缩前提炼（§15.4 抢救提炼 / §10.5）：session_before_compact 钩子的业务入口。
   * 只处理即将被压缩覆盖、尚未入记忆的角色消息（H1 已由调用方在 pi 侧过滤
   * `custom_message` + `customType === "mesh.msg"`；H2 在这里用 source_msg_id 反查去重）。
   * 全部已被提炼过则跳过（不发 LLM、不写 reflections 行）；否则走一次 pre_compaction
   * 全档自省，把原文交给自省流提炼。
   */
  async harvest(
    agentId: string,
    opts: { messages: Array<{ msgId: string; text: string }>; virtualTs?: string },
  ): Promise<ReflectionRunResult> {
    const rec = this.registry.byAgentId(agentId);
    if (!rec || rec.agentType !== "role") {
      return { agentId, trigger: "pre_compaction", depth: "skip", sent: false, skipped: "not a role agent" };
    }
    // H2：只提炼尚无对应 episode 的角色消息（source_msg_id 反查，无外键）。
    const undigested = opts.messages.filter((m) => !this.memoryDao.hasEpisodeFor(agentId, m.msgId));
    if (undigested.length === 0) {
      return {
        agentId,
        trigger: "pre_compaction",
        depth: "skip",
        sent: false,
        skipped: "compaction range already distilled (§15.4 H2)",
      };
    }
    return this.run(agentId, { trigger: "pre_compaction", virtualTs: opts.virtualTs, preCompactMessages: undigested });
  }

  // ─── 读接口 ────────────────────────────────────────────────────────────────

  async read(agentId: string): Promise<ReflectSnapshot> {
    return {
      profiles: this.dao.profiles(agentId),
      reflections: this.dao.latestReflections(agentId, 20),
      state: this.dao.currentState(agentId),
    };
  }

  // ─── 领域工具：reflect_result（只挂自省流）──────────────────────────────────

  async reflectResultHandlerFor(accountId: string): Promise<DomainToolHandlers> {
    const rec = this.registry.byAccountId(accountId);
    if (!rec || rec.reflectAccountId !== accountId) return {};
    const owner = rec.agentId;
    const handler: ToolExecute = async (_toolCallId, params) => {
      const updates = params.updates;
      if (updates === undefined || updates === null || typeof updates !== "object") {
        return toolError("ARG_INVALID", "updates 必填（结构化的自省结论）。");
      }
      return this.applyAsHandler(accountId, owner, updates as ReflectionOutput);
    };
    return { reflect_result: handler };
  }

  // ─── 落地 ──────────────────────────────────────────────────────────────────

  private async applyAsHandler(
    accountId: string,
    owner: string,
    output: ReflectionOutput,
  ): Promise<MeshToolResult> {
    const flight = this.inFlight.get(accountId);
    if (!flight) return toolError("TOOL_DISABLED", "当前没有进行中的自省回合，或结论已提交过。");

    const parsed = this.validate(owner, output);
    if (parsed.error) {
      this.dao.failReflection(flight.reflectionId, parsed.error);
      this.inFlight.delete(accountId);
      return toolError("ARG_INVALID", parsed.error);
    }
    // 证据校验失败也一并结束回合（一次自省只提交一次）。
    this.inFlight.delete(accountId);
    try {
      const applied = await this.applyResult(owner, flight, output);
      return { content: JSON.stringify({ ok: true, ...applied }) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.dao.failReflection(flight.reflectionId, msg);
      return { content: JSON.stringify({ error: { code: "ARG_INVALID", message: msg } }) };
    }
  }

  /**
   * 落地一次自省结论（§13.4.3 / §15.2 / §18.4.3）。供测试直接调用；工具处理器把它包成
   * MeshToolResult。不变量：owner 证据、同主体合并、delta 限幅（K3）、全量 state_writes 审计。
   */
  async applyResult(owner: string, flight: InFlight, output: ReflectionOutput): Promise<ReflectionApplyResult> {
    const rec = this.registry.byAgentId(owner);
    const policy = rec ? await this.policyFor(rec.accountId) : defaultMemoryPolicy();

    let profilesTouched = 0;
    let episodesWritten = 0;
    let knowledgeAccepted = 0;
    let knowledgeRejected = 0;
    let clamped = false;

    // ① 主体画像：同主体合并 → 一次限幅 → 绝对终值回写。
    if (output.profileUpdates?.length) {
      for (const merged of mergeProfileDeltas(output.profileUpdates)) {
        const before = this.dao.profileRow(owner, merged.ref) ?? { impression: null, valence: null, closeness: null, trust: null };
        const closenessRaw = merged.closenessDelta ?? 0;
        const trustRaw = merged.trustDelta ?? 0;
        const closenessClamped = clampDelta(closenessRaw, policy.reflection.closenessDeltaCap);
        const trustClamped = clampDelta(trustRaw, policy.reflection.trustDeltaCap);
        if (closenessClamped !== closenessRaw || trustClamped !== trustRaw) clamped = true;

        const patch: {
          impression?: string;
          valence?: number;
          closeness?: number;
          trust?: number;
          traits?: unknown;
        } = {};
        if (merged.impression !== undefined) patch.impression = merged.impression;
        if (merged.valence !== undefined) patch.valence = clamp01(merged.valence);
        // 无既有画像时以 defaultTrust 为中性基线（与 scoreMemorability 的 trustOfSender 约定一致，§12.3.3）。
        if (merged.closenessDelta !== undefined) patch.closeness = clamp01((before.closeness ?? policy.defaultTrust) + closenessClamped);
        if (merged.trustDelta !== undefined && merged.ref.type !== "facility" && merged.ref.type !== "self") {
          patch.trust = clamp01((before.trust ?? policy.defaultTrust) + trustClamped);
        }
        if (merged.traits !== undefined) patch.traits = merged.traits;
        if (Object.keys(patch).length > 0) {
          this.dao.applyProfile(owner, merged.ref, patch, {
            reflectionId: flight.reflectionId,
            reason: clamped ? "k3_clamp" : undefined,
          });
          profilesTouched += 1;
        }
      }
    }

    // ② 巩固 L1→L2：原情节折旧 + 一条新 impression 摘要。
    for (const c of output.consolidations ?? []) {
      const gist = c.gist.trim();
      if (!gist) continue;
      this.dao.markConsolidated(owner, c.episodeIds);
      this.memoryDao.insertEpisode({
        episodeId: newId("ep"),
        ownerAgent: owner,
        kind: "impression",
        sceneId: null,
        purposeKind: null,
        sourceMsgId: null,
        sourceSessionId: null,
        sourceEntryId: null,
        gist: gist.slice(0, 200),
        detail: null,
        quote: null,
        emotion: null,
        valence: null,
        arousal: null,
        salience: clamp01(c.salience ?? 0.7),
        confidence: 0.7,
        accuracy: null,
        virtualTs: flight.virtualTs,
        virtualHours: flight.virtualHours,
        retention: clamp01(c.salience ?? 0.7),
        status: "active",
        modelConfigHash: null,
        subjects: [],
      });
      episodesWritten += 1;
    }

    // ③ 自我洞察（kind 'self'）。
    for (const s of output.selfInsights ?? []) {
      const gist = s.gist.trim();
      if (!gist) continue;
      this.memoryDao.insertEpisode({
        episodeId: newId("ep"),
        ownerAgent: owner,
        kind: "self",
        sceneId: null,
        purposeKind: null,
        sourceMsgId: null,
        sourceSessionId: null,
        sourceEntryId: null,
        gist: gist.slice(0, 200),
        detail: s.detail ? s.detail.slice(0, 400) : null,
        quote: null,
        emotion: null,
        valence: null,
        arousal: null,
        salience: clamp01(s.salience ?? 0.6),
        confidence: 0.7,
        accuracy: null,
        virtualTs: flight.virtualTs,
        virtualHours: flight.virtualHours,
        retention: clamp01(s.salience ?? 0.6),
        status: "active",
        modelConfigHash: null,
        subjects: [{ ref: { type: "self", id: "self" } }],
      });
      episodesWritten += 1;
    }

    // ④ 状态微调（mood + intensity/energy Δ，K3 限幅）。
    if (output.stateAdjust) {
      const before = this.dao.currentState(owner);
      const a = output.stateAdjust;
      const moodDelta = clampDelta(a.moodDelta ?? 0, policy.reflection.moodDeltaCap);
      const energyDelta = clampDelta(a.energyDelta ?? 0, policy.reflection.moodDeltaCap);
      if (a.moodDelta !== undefined && moodDelta !== (a.moodDelta ?? 0)) clamped = true;
      if (a.energyDelta !== undefined && energyDelta !== (a.energyDelta ?? 0)) clamped = true;

      const next: { mood?: string; moodIntensity?: number; energy?: number } = {};
      if (a.mood !== undefined) next.mood = a.mood;
      if (a.moodDelta !== undefined) next.moodIntensity = clamp01(before.moodIntensity + moodDelta);
      if (a.energyDelta !== undefined) next.energy = clamp01(before.energy + energyDelta);
      if (Object.keys(next).length > 0) {
        this.dao.applyState(owner, next, {
          reflectionId: flight.reflectionId,
          reason: clamped ? "k3_clamp" : undefined,
          before,
        });
      }
    }

    // ④ 知识迁移（§17）：逐条走 KnowledgeService，状态机/证据门槛失败只弃该条（§13.4.3 ④）。
    for (const ku of output.knowledgeUpdates ?? []) {
      const verdict = this.knowledge.applyUpdate(owner, ku, {
        reflectionId: flight.reflectionId,
        virtualTs: flight.virtualTs,
        virtualHours: flight.virtualHours,
      });
      if (verdict.ok) knowledgeAccepted += 1;
      else knowledgeRejected += 1;
    }

    // ⑤ 学习队列整理（§17.5.2 Q4/Q1/Q3）：模型提议 + 误区自动入队 → 存 output_json。
    output.learningQueue = this.knowledge.organizeLearningQueue(owner, output.learningQueue ?? []);

    this.dao.finishReflection(flight.reflectionId, {
      outputJson: JSON.stringify(output),
      episodesWritten,
      profilesTouched,
    });
    return {
      reflectionId: flight.reflectionId,
      episodesWritten,
      profilesTouched,
      knowledgeAccepted,
      knowledgeRejected,
    };
  }

  // ─── 校验与组装 ────────────────────────────────────────────────────────────

  /** 结构 + owner 证据校验。返回 error 字符串（非空即拒绝整次）。 */
  private validate(owner: string, o: ReflectionOutput): { error?: string } {
    for (const id of [...(o.basedOnEpisodes ?? []), ...(o.mergeEpisodeIds ?? [])]) {
      if (typeof id !== "string") return { error: "basedOnEpisodes/mergeEpisodeIds 须为 episode_id 字符串数组" };
    }
    for (const c of o.consolidations ?? []) {
      if (!Array.isArray(c.episodeIds)) return { error: "consolidations[].episodeIds 须为数组" };
      if (typeof c.gist !== "string" || c.gist.trim().length === 0) return { error: "consolidations[].gist 必填" };
    }
    for (const s of o.selfInsights ?? []) {
      if (typeof s.gist !== "string" || s.gist.trim().length === 0) return { error: "selfInsights[].gist 必填" };
    }
    // 证据所有权（§13.4.3）：声明的 merge/consolidate 情节必须全属 owner。
    const claimed = [
      ...(o.mergeEpisodeIds ?? []),
      ...(o.consolidations ?? []).flatMap((c) => c.episodeIds),
    ];
    for (const id of claimed) {
      if (!this.dao.ownsEpisode(owner, id)) return { error: `episode 不属于 owner（或不存在）：${id}` };
    }
    // 非空结论。
    const nonEmpty =
      (o.profileUpdates?.length ?? 0) > 0 ||
      (o.consolidations?.length ?? 0) > 0 ||
      (o.selfInsights?.length ?? 0) > 0 ||
      o.stateAdjust !== undefined ||
      (o.knowledgeUpdates?.length ?? 0) > 0 ||
      (o.learningQueue?.length ?? 0) > 0;
    if (!nonEmpty) return { error: "自省结论为空：须至少给出 profileUpdates / consolidations / selfInsights / stateAdjust / knowledgeUpdates 之一" };
    return {};
  }

  private grade(
    _agentId: string,
    trigger: ReflectionTrigger,
    count: number,
    _maxArousal: number,
    policy: MemoryPolicy,
  ): ReflectionDepth {
    switch (trigger) {
      case "pre_compaction":
      case "arousal_spike":
      case "manual":
        return "full";
      case "scene_end":
        return count > 0 ? "full" : "light";
      case "episodes_since":
        return count >= policy.reflection.episodesPerReflection ? "full" : "skip";
      case "daily":
        return "light";
    }
  }

  private assembleInput(
    owner: string,
    trigger: ReflectionTrigger,
    ctx: {
      count: number;
      entries: EpisodeBrief[];
      maxArousal: number;
      since: string | null;
      virtualTs: string;
      sceneId?: string;
      preCompactMessages?: Array<{ msgId: string; text: string }>;
    },
  ): ReflectionInput {
    return {
      trigger,
      sceneId: ctx.sceneId,
      virtualTs: ctx.virtualTs,
      virtualHours: virtualHoursOf(ctx.virtualTs),
      episodesSinceCount: ctx.count,
      sinceStartedAt: ctx.since ?? "",
      maxArousal: ctx.maxArousal,
      episodes: ctx.entries,
      profiles: this.dao.profiles(owner),
      knowledgeSummary: this.knowledge.summary(owner),
      currentState: this.dao.currentState(owner),
      preCompactMessages: ctx.preCompactMessages,
    };
  }

  /** 建/复用自省流会话并发 cue（§13.4.1 / §20.2.4：用 send 的 cue 触发，非 request/ack，成本两段拼接排除）。 */
  private async send(
    agentId: string,
    mainAccountId: string,
    reflectAccountId: string,
    input: ReflectionInput,
  ): Promise<string> {
    if (!this.mesh) throw new Error("ReflectionService 未 attach mesh");
    const conv = await this.reflectConversationOf(agentId, mainAccountId, reflectAccountId);
    const cue = this.buildCue(input);
    const res = await this.mesh.send({
      from: mainAccountId,
      to: [reflectAccountId],
      conversationId: conv.id,
      kind: "system",
      expect: "none",
      text: cue,
      ext: { virtualTs: input.virtualTs, sceneId: input.sceneId, turn: input.episodesSinceCount },
    });
    return res.messageId;
  }

  private async reflectConversationOf(
    agentId: string,
    mainAccountId: string,
    reflectAccountId: string,
  ): Promise<Conversation> {
    const cached = this.reflectConv.get(agentId);
    if (cached && this.mesh) {
      return { id: cached } as Conversation;
    }
    if (!this.mesh) throw new Error("ReflectionService 未 attach mesh");
    const conv = await this.mesh.ensureDirect(mainAccountId, reflectAccountId);
    this.reflectConv.set(agentId, conv.id);
    return conv;
  }

  /** cue 正文（§13.4.1）：自然语言提示 + 结构化要点。 */
  private buildCue(input: ReflectionInput): string {
    const lines: string[] = [];
    lines.push(`请对上一轮经历做一次自省（触发：${input.trigger}，虚拟时间 ${input.virtualTs}）。`);
    lines.push(`待回顾情节 ${input.episodesSinceCount} 条，当前状态：${input.currentState.mood}（强度 ${input.currentState.moodIntensity}）/ 精力 ${input.currentState.energy}。`);
    const top = input.episodes.slice(0, 8).map((e) => `- ${e.gist}`).join("\n");
    if (top) lines.push(`要点：\n${top}`);
    // 抢救提炼（§15.4）：即将被压缩覆盖、尚未入记忆的角色消息原文，交给自省流一次性提炼。
    if (input.preCompactMessages && input.preCompactMessages.length > 0) {
      const raw = input.preCompactMessages
        .map((m, i) => `${i + 1}. ${m.text}`)
        .join("\n");
      lines.push(`以下内容即将被上下文压缩覆盖，且尚未写入记忆（§15.4 抢救提炼）。请逐条提炼为 selfInsights（每值得记的一条一条 gist），再用 profileUpdates / consolidations 沉淀印象：\n${raw}`);
    }
    lines.push("把结论用 reflect_result 提交：trustDelta / closenessDelta 是增量且会被限幅；合并多条情节用 consolidations；对自己的新认识用 selfInsights。");
    return lines.join("\n");
  }
}

/** 同主体合并 profileUpdates（§13.5：先合并，后限幅）。 */
function mergeProfileDeltas(deltas: ProfileDelta[]): Array<{ ref: SubjectRef } & ProfileDelta> {
  const map = new Map<string, { ref: SubjectRef } & ProfileDelta>();
  for (const d of deltas) {
    let ref: SubjectRef;
    try {
      ref = parseSubjectRef(d.subject);
    } catch {
      continue; // 非法 subject 跳过（validate 不拦，落库沉默丢弃）
    }
    const key = serializeSubjectRef(ref);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ref, ...d });
    } else {
      if (d.impression !== undefined) cur.impression = d.impression;
      if (d.valence !== undefined) cur.valence = d.valence;
      cur.closenessDelta = (cur.closenessDelta ?? 0) + (d.closenessDelta ?? 0);
      cur.trustDelta = (cur.trustDelta ?? 0) + (d.trustDelta ?? 0);
      if (d.traits !== undefined) cur.traits = d.traits;
    }
  }
  return [...map.values()];
}