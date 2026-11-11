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
import { MISCONCEPTION_CORRECTION_SALIENCE_FLOOR } from "../knowledge/types.js";
import type { RoleAccountRegistry } from "../mesh/accounts.js";
import type { Conversation, MeshHost, MeshToolResult } from "../mesh/public-types.js";
import type { DomainToolHandlers, ToolExecute } from "../mesh/tools.js";
import type { MemoryDao } from "../memory/dao.js";
import { parseSubjectRef, serializeSubjectRef, type SubjectRef } from "../memory/subject.js";
import { newId } from "../runtime/id.js";
import type { CostRecord } from "../runtime/types.js";
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
  UsageSnapshot,
} from "./types.js";

/** 虚拟时钟缺失/非法时的兜底起点（与 MemoryService 的默认起点一致）。 */
const DEFAULT_VIRTUAL_START = "W1D1T8";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 情感价限 [-1,1]（A24：valence 是双向的，不能像 0..1 的量那样 clamp01 把 -0.8 抹成 0）。 */
const clampValence = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : x);
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
  /**
   * R34：自省流账号累计用量的回读源（镜像 scene 的 usageTotalFor）。供每次自省往返做差，
   * 量出**纯自省**的模型用量，单独上抛 onCost(source="reflect")，与对话账（dialogue）分开可还原。
   * 缺省（fake/无 LLM）不注入 → 不量、不上抛，维持 P2 无 LLM 语义。
   */
  usageForReflect?: (reflectAccountId: string) => Promise<UsageSnapshot>;
  /** R34 成本出口：自省流生成完成后上抛一条 source="reflect" 记录。 */
  onCost?: (c: CostRecord) => void;
  /** pre_compaction 有界等待 reflect_result 的超时（§15.4/R20，真实毫秒）。默认 30s。 */
  resultTimeoutMs?: number;
}

/** harvest 有界等待的默认超时（§15.4/R20：收敛与压缩等待默认可配置 30 秒）。 */
const DEFAULT_RESULT_TIMEOUT_MS = 30_000;

/** 一次进行中的自省回合（reflect 账号 → 内存态；落库真值在 reflections 行）。 */
interface InFlight {
  reflectionId: string;
  owner: string;
  virtualTs: string;
  virtualHours: number;
  sceneId?: string;
  trigger?: ReflectionTrigger;
  /** 自省流账号 id（R34 成本做差的键）。 */
  reflectAccountId?: string;
  /** R34：发 cue 前自省流账号的累计用量基线（做差得本次自省纯增量）。 */
  usageBaseline?: UsageSnapshot;
  /** pre_compaction 批次携带的「即将被压缩」的原文来源（A23：提炼成功后整批记为已消化）。 */
  sourceMsgIds?: string[];
}

export class ReflectionService {
  private readonly dao: ReflectionDao;
  private readonly memoryDao: MemoryDao;
  private readonly knowledge: KnowledgeService;
  private readonly registry: RoleAccountRegistry;
  private readonly policyOf: (accountId: string) => Promise<MemoryPolicy | undefined>;
  private readonly resultTimeoutMs: number;
  private readonly usageForReflect?: (reflectAccountId: string) => Promise<UsageSnapshot>;
  private readonly onCost?: (c: CostRecord) => void;

  /** reflect accountId → 进行中的自省回合（FIFO：mesh 串行投递自省流，结果按 cue 顺序结算）。 */
  private readonly inFlight = new Map<string, InFlight[]>();
  /** agentId → 自省流会话 id（ensureDirect 幂等，首查后缓存）。 */
  private readonly reflectConv = new Map<string, string>();
  private readonly policyCache = new Map<string, MemoryPolicy>();
  private mesh?: Pick<MeshHost, "send" | "ensureDirect">;
  /**
   * A23/R20：pre_compaction 批次的落地台账（reflectionId → 是否已结算 + 等待者）。
   * 仅 harvest 的 full 批登记；finish/fail 时敲醒，harvest 有界等待（30s 默认）。
   * 结算后/超时即释放，不跨批残留（非 pre_compaction 的 run 维持 fire-and-forget，不登记）。
   */
  private readonly settlements = new Map<string, { settled: boolean; resolve?: (settled: boolean) => void }>();

  constructor(deps: ReflectionServiceDeps) {
    this.dao = deps.dao;
    this.memoryDao = deps.memoryDao;
    this.knowledge = deps.knowledge;
    this.registry = deps.registry;
    this.policyOf = deps.policyOf;
    this.resultTimeoutMs = deps.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS;
    this.usageForReflect = deps.usageForReflect;
    this.onCost = deps.onCost;
  }

  attach(mesh: Pick<MeshHost, "send" | "ensureDirect">): void {
    this.mesh = mesh;
  }

  /**
   * R19 重启恢复：把上次进程崩溃遗留的 `running` reflections 批统一终结为 failed（interrupted）。
   * 不属「伪造 completion」——失败即真相（批根本没收敛），A21 成功游标只认 done，未完成输入的
   * evidence 窗不会被跳过，下次 `maybe()` 会用同一证据窗重新成批。返回终结的批数。
   */
  recoverInterrupted(): number {
    return this.dao.failOrphanedRunning();
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
    // A12：发送前先把批次落库并进 FIFO——即使 reflect_result 在 send 返回前就绪，
    // 处理器也能按队列头命中正确批次，不得到 TOOL_DISABLED。
    this.dao.insertReflection({
      reflectionId,
      ownerAgent: agentId,
      trigger,
      sceneId: opts.sceneId ?? null,
      reflectMsgId: null,
      inputJson: JSON.stringify(input),
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const flight: InFlight = {
      reflectionId,
      owner: agentId,
      virtualTs: input.virtualTs,
      virtualHours: input.virtualHours,
      sceneId: opts.sceneId,
      trigger,
      reflectAccountId: rec.reflectAccountId,
      sourceMsgIds: opts.preCompactMessages?.map((m) => m.msgId),
    };
    // R34：发 cue 前先冻结自省流账号的累计用量基线（自省生成还没开始，此刻是纯历史）。
    if (this.usageForReflect) {
      flight.usageBaseline = await this.usageForReflect(rec.reflectAccountId);
    }
    const queue = this.inFlight.get(rec.reflectAccountId) ?? [];
    queue.push(flight);
    this.inFlight.set(rec.reflectAccountId, queue);

    // A23：pre_compaction 批登记落地台账——harvest 稍后据此有界等待结果；send 失败也会
    // 经 fail() 敲醒它（settled）。非 pre_compaction 不登记，维持 fire-and-forget。
    const waitable = flight.sourceMsgIds !== undefined && flight.sourceMsgIds.length > 0;
    if (waitable) this.settlements.set(reflectionId, { settled: false });

    try {
      const reflectMsgId = await this.send(agentId, rec.accountId, rec.reflectAccountId, input);
      this.dao.recordReflectMsg(reflectionId, reflectMsgId);
    } catch (err) {
      // 发送失败：撤回本批次（按 reflectionId 精确移除，不误删重叠批次）并标记 failed。
      const msg = err instanceof Error ? err.message : String(err);
      const remaining = (this.inFlight.get(rec.reflectAccountId) ?? []).filter(
        (f) => f.reflectionId !== reflectionId,
      );
      if (remaining.length > 0) this.inFlight.set(rec.reflectAccountId, remaining);
      else this.inFlight.delete(rec.reflectAccountId);
      this.fail(reflectionId, msg);
      return { agentId, trigger, depth: "full", sent: false, reflectionId, skipped: `send failed: ${msg}` };
    }

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
    // H2/A23：只提炼尚未入记忆的角色消息。已入记忆 = 「有 source_msg_id 反查的情节」
    // 或「已被某次 pre_compaction 成功提炼」（compact_distilled 台账）。两者皆无才未消化，
    // 否则一次成功提炼后重复 compaction 会再落一遍情节。
    const undigested = opts.messages.filter(
      (m) => !this.memoryDao.hasEpisodeFor(agentId, m.msgId) && !this.memoryDao.hasDistilledSource(agentId, m.msgId),
    );
    if (undigested.length === 0) {
      return {
        agentId,
        trigger: "pre_compaction",
        depth: "skip",
        sent: false,
        skipped: "compaction range already distilled (§15.4 H2)",
      };
    }
    // A23/R20：跑一次 pre_compaction 全档自省后，有界等待自省流回传 reflect_result 并落地，
    // 而不是把「cue 已发（sent=true）」当成「提炼完成」。非 full（无自省流降级 light）或
    // send 失败时 run 已带回结论，直接返回，不做有界等待。
    const res = await this.run(agentId, {
      trigger: "pre_compaction",
      virtualTs: opts.virtualTs,
      preCompactMessages: undigested,
    });
    if (!res.sent || !res.reflectionId) return res;

    const settled = await this.waitSettled(res.reflectionId, this.resultTimeoutMs);
    if (!settled) {
      // 超时降级：cue 仍在途，结果之后仍会异步落地并写 distilled 台账，这里如实留痕不吞错。
      return {
        ...res,
        settled: false,
        skipped: res.skipped ?? `reflect_result timeout after ${this.resultTimeoutMs}ms (cue 在途，稍后异步落地)`,
      };
    }
    return { ...res, settled: true };
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
    // A12：FIFO 队列头结算——mesh 串行投递自省流，结果按 cue 顺序归批；重叠批次不串号。
    const flight = this.shiftFlight(accountId);
    if (!flight) return toolError("TOOL_DISABLED", "当前没有进行中的自省回合，或结论已提交过。");

    const parsed = this.validate(owner, output);
    if (parsed.error) {
      this.fail(flight.reflectionId, parsed.error);
      return toolError("ARG_INVALID", parsed.error);
    }
    // 证据校验通过即结束回合（队列头已移除，一次自省只提交一次）。
    try {
      const applied = await this.applyResult(owner, flight, output);
      await this.reportReflectCost(flight);
      return { content: JSON.stringify({ ok: true, ...applied }) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.fail(flight.reflectionId, msg);
      return { content: JSON.stringify({ error: { code: "ARG_INVALID", message: msg } }) };
    }
  }

  /**
   * R34：自省成本归因——量出自省流账户本次反射的纯增量，单独上抛 onCost(source="reflect")。
   * 纯自省（reflect 流生成）不入对话账（dialogue），角色账 + 自省账据此可还原全账。
   * 无 usageForReflect / onCost（fake/无 LLM）或增量非正时为 no-op，不吞错、不伪造用量。
   */
  private async reportReflectCost(flight: InFlight): Promise<void> {
    if (!this.usageForReflect || !this.onCost || !flight.reflectAccountId || !flight.usageBaseline) return;
    let after: UsageSnapshot;
    try {
      after = await this.usageForReflect(flight.reflectAccountId);
    } catch {
      return; // 读不到用量降级，不上抛（与 scene 一致：不阻断反射落地）。
    }
    const tokensIn = Math.max(0, after.tokensIn - flight.usageBaseline.tokensIn);
    const tokensOut = Math.max(0, after.tokensOut - flight.usageBaseline.tokensOut);
    const totalTokens = tokensIn + tokensOut;
    if (totalTokens <= 0) return;
    this.onCost({
      source: "reflect",
      agentId: flight.owner,
      sceneId: flight.sceneId,
      tokensIn,
      tokensOut,
      at: new Date().toISOString(),
    });
  }

  /** 移出并返回 accountId 队列头；队列空返回 undefined 并清理该键（恰好一次的自然屏障）。 */
  private shiftFlight(accountId: string): InFlight | undefined {
    const queue = this.inFlight.get(accountId);
    if (!queue || queue.length === 0) return undefined;
    const flight = queue.shift();
    if (queue.length === 0) this.inFlight.delete(accountId);
    return flight;
  }

  // ─── A23 有界等待（pre_compaction 落地台账）────────────────────────────────

  /** finish/fail 由这里统一收口：落地/失败后敲醒 harvest 的有界等待（非 pre_compaction 无台账 no-op）。 */
  private finish(reflectionId: string, payload: Parameters<ReflectionDao["finishReflection"]>[1]): void {
    this.dao.finishReflection(reflectionId, payload);
    this.markSettled(reflectionId);
  }

  private fail(reflectionId: string, msg: string): void {
    this.dao.failReflection(reflectionId, msg);
    this.markSettled(reflectionId);
  }

  private markSettled(reflectionId: string): void {
    const s = this.settlements.get(reflectionId);
    if (!s) return;
    s.settled = true;
    s.resolve?.(true);
  }

  /** 有界等待某批次落地。true=已落地（或已结算）；false=超时（结果可能在途，稍后异步落地）。 */
  private waitSettled(reflectionId: string, timeoutMs: number): Promise<boolean> {
    const s = this.settlements.get(reflectionId);
    if (!s) return Promise.resolve(false); // 未登记（非 pre_compaction）或已释放
    if (s.settled) {
      this.settlements.delete(reflectionId);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.settlements.get(reflectionId) === s) this.settlements.delete(reflectionId);
        resolve(false);
      }, timeoutMs);
      s.resolve = (settled: boolean) => {
        clearTimeout(timer);
        this.settlements.delete(reflectionId);
        resolve(settled);
      };
    });
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
        if (merged.valence !== undefined) patch.valence = clampValence(merged.valence);
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
      if (verdict.ok) {
        knowledgeAccepted += 1;
        // §17.4.2 纠正流程第 ④ 步：误区被纠正（is_misconception 1→0）是高价值事件，写一条
        // 系统抬高的高显著节情节，双主体 person:纠正者 + knowledge:topic（关系记忆），不交给
        // Agent 判显著度。
        if (verdict.misconceptionCorrected) {
          const { topic, corrector, wrongBelief } = verdict.misconceptionCorrected;
          const subjects: Array<{ ref: SubjectRef }> = [{ ref: { type: "knowledge", id: topic } }];
          if (corrector !== "self") {
            try {
              subjects.unshift({ ref: parseSubjectRef(corrector) });
            } catch {
              /* 非法归因退化为 self，不挂 person 主体 */
            }
          }
          this.memoryDao.insertEpisode({
            episodeId: newId("ep"),
            ownerAgent: owner,
            kind: "self",
            sceneId: flight.sceneId ?? null,
            purposeKind: "misconception_corrected",
            sourceMsgId: null,
            sourceSessionId: null,
            sourceEntryId: null,
            gist: (wrongBelief ? `我以前以为「${wrongBelief}」，原来不是这样` : `我对「${topic}」的理解被纠正了`).slice(0, 200),
            detail: wrongBelief ? `以前的理解：${wrongBelief}`.slice(0, 400) : null,
            quote: null,
            emotion: null,
            valence: null,
            arousal: null,
            salience: MISCONCEPTION_CORRECTION_SALIENCE_FLOOR,
            confidence: 0.7,
            accuracy: null,
            virtualTs: flight.virtualTs,
            virtualHours: flight.virtualHours,
            retention: MISCONCEPTION_CORRECTION_SALIENCE_FLOOR,
            status: "active",
            modelConfigHash: null,
            subjects,
          });
          episodesWritten += 1;
        }
      } else {
        knowledgeRejected += 1;
      }
    }

    // ⑤ 学习队列整理（§17.5.2 Q4/Q1/Q3 + Q2 时间戳）：模型提议 + 误区自动入队 → 存 output_json。
    output.learningQueue = this.knowledge.organizeLearningQueue(owner, output.learningQueue ?? [], {
      virtualHours: flight.virtualHours,
    });

    // R17 旧问题连续：未澄清问题规整为短文本数组（过滤非法、限条数/长度），随 output_json
    // 持久化供下一轮 lastOpenQuestions 读回重注入 cue，连续自省不丢未解决问题与意图。
    output.openQuestions = (output.openQuestions ?? [])
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim().slice(0, 200))
      .slice(0, 8);

    // A23：pre_compaction 批次写入了情节，才把它的全部来源原文记为已消化（compact_distilled
    // 台账）。只写画像/知识但没落情节时，原文仍未被「记忆」，不能标记已消化——否则下次
    // compaction 会跳过尚未提炼的原文。
    if (episodesWritten > 0 && flight.sourceMsgIds && flight.sourceMsgIds.length > 0) {
      this.memoryDao.markDistilledSources(owner, flight.sourceMsgIds, flight.reflectionId);
    }

    this.finish(flight.reflectionId, {
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

  /** 结构 + owner 证据校验。返回 error 字符串（非空即拒绝整批，绝不先写一半）。 */
  private validate(owner: string, o: ReflectionOutput): { error?: string } {
    if (o == null || typeof o !== "object") return { error: "自省结论须为对象" };
    const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

    // basedOnEpisodes / mergeEpisodeIds：episode_id 字符串数组。
    for (const key of ["basedOnEpisodes", "mergeEpisodeIds"] as const) {
      const arr = o[key];
      if (arr !== undefined && (!Array.isArray(arr) || arr.some((id) => typeof id !== "string"))) {
        return { error: `${key} 须为 episode_id 字符串数组` };
      }
    }

    // profileUpdates 嵌套结构先验（A13：非法条目在写画像前整批拒绝，不留残余 delta）。
    if (o.profileUpdates !== undefined) {
      if (!Array.isArray(o.profileUpdates)) return { error: "profileUpdates 须为数组" };
      for (const d of o.profileUpdates) {
        if (d == null || typeof d !== "object") return { error: "profileUpdates[] 须为对象" };
        if (typeof d.subject !== "string" || d.subject.length === 0) return { error: "profileUpdates[].subject 必填" };
        try {
          parseSubjectRef(d.subject);
        } catch {
          return { error: `profileUpdates[].subject 非法：${d.subject}` };
        }
        if (d.impression !== undefined && typeof d.impression !== "string") return { error: "profileUpdates[].impression 须为字符串" };
        if (d.valence !== undefined && !isFiniteNumber(d.valence)) return { error: "profileUpdates[].valence 须为数字" };
        if (d.closenessDelta !== undefined && !isFiniteNumber(d.closenessDelta)) return { error: "profileUpdates[].closenessDelta 须为数字" };
        if (d.trustDelta !== undefined && !isFiniteNumber(d.trustDelta)) return { error: "profileUpdates[].trustDelta 须为数字" };
      }
    }

    // consolidations：episodeIds / gist / salience 先验。
    if (o.consolidations !== undefined) {
      if (!Array.isArray(o.consolidations)) return { error: "consolidations 须为数组" };
      for (const c of o.consolidations) {
        if (c == null || typeof c !== "object") return { error: "consolidations[] 须为对象" };
        if (!Array.isArray(c.episodeIds) || c.episodeIds.some((id) => typeof id !== "string")) {
          return { error: "consolidations[].episodeIds 须为 id 字符串数组" };
        }
        if (typeof c.gist !== "string" || c.gist.trim().length === 0) return { error: "consolidations[].gist 必填" };
        if (c.salience !== undefined && !isFiniteNumber(c.salience)) return { error: "consolidations[].salience 须为数字" };
      }
    }

    // selfInsights 嵌套结构先验（A13 直接反例：detail={} 会让 slice 抛错）。
    if (o.selfInsights !== undefined) {
      if (!Array.isArray(o.selfInsights)) return { error: "selfInsights 须为数组" };
      for (const s of o.selfInsights) {
        if (s == null || typeof s !== "object") return { error: "selfInsights[] 须为对象" };
        if (typeof s.gist !== "string" || s.gist.trim().length === 0) return { error: "selfInsights[].gist 必填" };
        if (s.detail !== undefined && s.detail !== null && typeof s.detail !== "string") {
          return { error: "selfInsights[].detail 须为字符串或省略" };
        }
        if (s.salience !== undefined && !isFiniteNumber(s.salience)) return { error: "selfInsights[].salience 须为数字" };
      }
    }

    // stateAdjust：mood 字符串、Δ 为有限数。
    if (o.stateAdjust !== undefined) {
      if (o.stateAdjust == null || typeof o.stateAdjust !== "object") return { error: "stateAdjust 须为对象" };
      const a = o.stateAdjust;
      if (a.mood !== undefined && typeof a.mood !== "string") return { error: "stateAdjust.mood 须为字符串" };
      if (a.moodDelta !== undefined && !isFiniteNumber(a.moodDelta)) return { error: "stateAdjust.moodDelta 须为数字" };
      if (a.energyDelta !== undefined && !isFiniteNumber(a.energyDelta)) return { error: "stateAdjust.energyDelta 须为数字" };
    }

    // knowledgeUpdates：topic/claim/evidence 字符串先验（applyUpdate 会对它们 .trim/.slice）。
    if (o.knowledgeUpdates !== undefined) {
      if (!Array.isArray(o.knowledgeUpdates)) return { error: "knowledgeUpdates 须为数组" };
      for (const ku of o.knowledgeUpdates) {
        if (ku == null || typeof ku !== "object") return { error: "knowledgeUpdates[] 须为对象" };
        if (typeof ku.topic !== "string" || ku.topic.trim().length === 0) return { error: "knowledgeUpdates[].topic 必填" };
        if (ku.evidence !== undefined && typeof ku.evidence !== "string") return { error: "knowledgeUpdates[].evidence 须为字符串" };
        if (ku.claim !== undefined && typeof ku.claim !== "string") return { error: "knowledgeUpdates[].claim 须为字符串" };
      }
    }

    // openQuestions：未澄清问题须为短文本数组（R17 旧问题连续；非法整批拒绝）。
    if (o.openQuestions !== undefined) {
      if (!Array.isArray(o.openQuestions)) return { error: "openQuestions 须为字符串数组" };
      for (const q of o.openQuestions) {
        if (typeof q !== "string") return { error: "openQuestions[] 须为字符串" };
      }
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
      (o.learningQueue?.length ?? 0) > 0 ||
      (o.openQuestions?.length ?? 0) > 0;
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
      learningQueue: this.knowledge.learningQueue(owner),
      openQuestions: this.dao.lastOpenQuestions(owner),
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
      // A04：kind 用 "task" 而非 "system"——普通角色 initiate 只有 chat/task/event，没有 system。
      // 用 "system" 会让 mesh gate ② 以 CANNOT_INITIATE 拒绝合法自省 cue（角色不能发起 system）。
      // 自省 cue 本质是「给自省流派一项提炼任务」，用 task 既合法又保留自省流隔离（from==主账号本人）。
      kind: "task",
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

    // A22：模型能看到的证据必须「真的在 cue 里」，不能躲进 input_json 背书。逐条给出
    // episodeId + gist（可读性 + 可锚定），在字符预算内尽量给全；需要锚定巩固时用 episodeIds。
    const { block: episodeBlock, truncated } = this.renderEpisodes(input.episodes);
    if (episodeBlock) lines.push(`可引用情节（用 episodeIds 锚定）：\n${episodeBlock}`);
    if (truncated > 0) lines.push(`（为控制长度，省略其余 ${truncated} 条；优先锚定上面已列出的。）`);

    if (input.knowledgeSummary.trim()) lines.push(`当前掌握度与误区摘要：\n${input.knowledgeSummary.trim()}`);
    const queue = input.learningQueue ?? [];
    if (queue.length > 0) {
      lines.push(
        `上一轮学习队列（继续处理）：\n` +
          queue.map((q) => `- ${q.topic}（${q.priority}）：${q.motivation}`).join("\n"),
      );
    }

    // R17 旧问题连续：上一轮未澄清的问题随 cue 重注入，模型按需在本轮给出结论或继续挂起。
    const openQuestions = input.openQuestions ?? [];
    if (openQuestions.length > 0) {
      lines.push(
        `上一轮未澄清的问题（继续思考或在本轮作答）：\n` +
          openQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
      );
    }

    // R17 预算内画像：把已沉淀的主要对象印象（画像）写进 cue，而非只藏在 input_json 里。
    const { block: profileBlock, truncated: profileTruncated } = this.renderProfiles(input.profiles);
    if (profileBlock) lines.push(`当前对主要对象的印象（画像）：\n${profileBlock}`);
    if (profileTruncated > 0) lines.push(`（为控制长度，省略其余 ${profileTruncated} 条画像。）`);

    // 抢救提炼（§15.4）：即将被压缩覆盖、尚未入记忆的角色消息原文，交给自省流一次性提炼。
    // A23：逐条带 source_msg_id 锚点（模型在 selfInsights 里按锚点引用来源、便于溯源）。
    if (input.preCompactMessages && input.preCompactMessages.length > 0) {
      const raw = input.preCompactMessages
        .map((m, i) => `${i + 1}. [${m.msgId}] ${m.text}`)
        .join("\n");
      lines.push(`以下内容即将被上下文压缩覆盖，且尚未写入记忆（§15.4 抢救提炼）。请逐条提炼为 selfInsights（每值得记的一条一条 gist，可用上面的 [来源 id] 引用原文），再用 profileUpdates / consolidations 沉淀印象：\n${raw}`);
    }
    lines.push("把结论用 reflect_result 提交：trustDelta / closenessDelta 是增量且会被限幅；合并多条情节用 consolidations；对自己的新认识用 selfInsights；仍未澄清、想留给下一轮的问题写进 openQuestions。");
    return lines.join("\n");
  }

  /** 在字符预算内把情节渲染成「id + gist」的可引用清单；返回被省略的条数。 */
  private renderEpisodes(
    episodes: ReflectionInput["episodes"],
  ): { block: string; truncated: number } {
    const BUDGET = 4000; // 字符预算：模型 cue 长度与可锚定证据的折中
    const out: string[] = [];
    let used = 0;
    let included = 0;
    for (const e of episodes) {
      const line = `- [${e.episodeId}] ${e.gist}`;
      if (used + line.length > BUDGET && included > 0) break;
      out.push(line);
      used += line.length;
      included += 1;
    }
    return { block: out.join("\n"), truncated: episodes.length - included };
  }

  /** 在字符预算内把主体画像渲染成「主体 + 印象」的清单（R17 预算内画像）；返回被省略的条数。 */
  private renderProfiles(
    profiles: ReflectionInput["profiles"],
  ): { block: string; truncated: number } {
    const BUDGET = 1200; // 画像只是辅助上下文，预算低于情节
    const out: string[] = [];
    let used = 0;
    let included = 0;
    for (const p of profiles) {
      // 无印象且从未出现（情节数 0）的画像是空行，不占预算也不渲染。
      if (!p.impression && (p.episodeCount ?? 0) <= 0) continue;
      const impression = p.impression && p.impression.trim() ? p.impression.trim() : "（尚未形成明确印象）";
      const numbers =
        p.valence == null && p.closeness == null && p.trust == null
          ? ""
          : `（价 ${p.valence ?? "—"} / 亲近 ${p.closeness ?? "—"} / 信任 ${p.trust ?? "—"} / 情节 ${p.episodeCount ?? 0}）`;
      const line = `- ${p.subject}：${impression}${numbers}`;
      if (used + line.length > BUDGET && included > 0) break;
      out.push(line);
      used += line.length;
      included += 1;
    }
    return { block: out.join("\n"), truncated: profiles.length - included };
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