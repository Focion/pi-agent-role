// ═══════════════════════════════════════════════════════════════════════════
// MemoryService（§12 / §14 / §16.3）—— 记忆子系统的事件驱动装配点
//
// 订阅 mesh 的三类事件，把「判定 → 写入 → 检索 → 注入 → 兜底」串成一条闭环：
//   · message_routed      发送方自我记忆（§12.5）：说话的人也要记住自己说了什么
//   · message_delivered   起轮（woke 且非 P3）+ 设施事件观察（§16.3，ambient event 不唤醒也记）
//   · message_consumed    轮终结算：落 memory_decisions + B 模式兜底 nudge（§12.4）
//
// 本文件是记忆子系统的「壳」：策略加载是异步的（pi-bindings 恢复期要重编译），但事件处理
// 器是同步签名（mesh.on 回调不 await）。解决：TurnState.ready 是一个延迟兑现的 Promise——
// 起轮时先同步建轮（默认策略占位），异步 resolve 真实策略 + 打分 + 检索后兑现 ready；
// context 钩子与 remember/recall 消费前先 `await turn.ready`。
//
// 纪律：本文件不 import @pi/agent-mesh（R1）；不出现 mesh_ 表名（R2）；不出现环境字段
// `ext` 的点访问（R3）——领域字段一律经 roleExtOf / envelopeText 取。
// ═══════════════════════════════════════════════════════════════════════════

import { sha256Hex } from "../compile/fingerprint.js";
import { defaultMemoryPolicy, type MemoryPolicy } from "../compile/types.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { LearningQueueItem } from "../knowledge/types.js";
import type { RoleAccountRegistry } from "../mesh/accounts.js";
import { roleExtOf, envelopeText, type FacilityEventPayload } from "../mesh/ext-role.js";
import type { Envelope, MeshEvents, MeshHost } from "../mesh/public-types.js";
import type { ContextHook } from "../mesh/session-factory.js";
import type { DomainToolHandlers } from "../mesh/tools.js";
import { newId } from "../runtime/id.js";
import { parseVirtualTs, virtualHoursOf } from "../runtime/virtual-clock.js";
import { OBSERVATION_CONFIDENCE, RETRIEVAL_BUDGET, WRITE } from "./constants.js";
import type { MemoryDao } from "./dao.js";
import { estimateTokens, renderMemoryBlocks } from "./render.js";
import {
  makeRankedCardRenderer,
  rankCandidatesWithSubjects,
  selectCards,
  strongCueFilter,
} from "./retrieve.js";
import {
  emotionalArousal,
  maxSimilarity,
  scoreMemorability,
  scoreSenderMemorability,
  trigramSimilarity,
  type MemoryPath,
  type MemoryTrigger,
} from "./score.js";
import type { SubjectRef } from "./subject.js";
import { makeMemoryTools } from "./tools.js";
import { freshTurnState, type TurnState } from "./turn.js";

/** 虚拟时钟缺失/非法时的兜底起点（与 scene/orchestrator 的默认起点一致）。 */
const DEFAULT_VIRTUAL_START = "W1D1T8";

/** B 模式兜底追问的措辞（§12.4）。triggerTurn:false ⇒ 在 Agent 下次自然醒来时被消费。 */
const NUDGE_TEXT =
  "刚才那件事你没记。如果它值得记住，用 remember 记一条；如果不值得，就不用管。";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 解析虚拟时间，缺失/非法时回退到默认起点（不抛，事件处理不能因脏数据中断）。 */
function safeVirtualTs(ts: string | undefined): string {
  if (!ts) return DEFAULT_VIRTUAL_START;
  try {
    parseVirtualTs(ts);
    return ts;
  } catch {
    return DEFAULT_VIRTUAL_START;
  }
}

/**
 * 设施事件的观察 gist：优先用 renderHints 的各感官通道片段。理想下应按接收方的
 * narrative_voice.sensory.dominant_channel 挑通道（§16.3.2），但该偏好未进 MemoryPolicy；
 * 这里退化为串接全部通道——同一个客观事件仍由「是否写 + 写什么」两处受策略控制。
 */
function facilityGist(fe: FacilityEventPayload, text: string): string {
  const rh = fe.renderHints;
  if (rh) {
    const parts = [
      ...(rh.visual ?? []),
      ...(rh.auditory ?? []),
      ...(rh.tactile ?? []),
      ...(rh.olfactory ?? []),
    ];
    if (parts.length > 0) return parts.join("；");
  }
  return text;
}

export interface MemoryServiceDeps {
  dao: MemoryDao;
  registry: RoleAccountRegistry;
  /** §17.5.2 学习队列上下文注入：把最近一次自省产出的 learningQueue 注入瞬时上下文。 */
  knowledge: KnowledgeService;
  /** 逐账号解析记忆策略（异步：恢复期要重编译 identity）。返回 undefined 用默认策略。 */
  policyOf: (accountId: string) => Promise<MemoryPolicy | undefined>;
}

export class MemoryService {
  private readonly dao: MemoryDao;
  private readonly registry: RoleAccountRegistry;
  private readonly knowledge: KnowledgeService;
  private readonly policyOf: (accountId: string) => Promise<MemoryPolicy | undefined>;

  /** accountId → 当前活动轮（一个 owner 一轮；message_consumed 结算清除）。 */
  private readonly turns = new Map<string, TurnState>();
  /** accountId → 已解析策略（成分稳定，缓存避免每轮重编译）。 */
  private readonly policyCache = new Map<string, MemoryPolicy>();
  /** owner → 连续「nudge 后仍 written=0」计数（B 模式熔断 §12.4）。 */
  private readonly nudgeFailures = new Map<string, number>();
  private mesh?: Pick<MeshHost, "nudge">;

  constructor(deps: MemoryServiceDeps) {
    this.dao = deps.dao;
    this.registry = deps.registry;
    this.knowledge = deps.knowledge;
    this.policyOf = deps.policyOf;
  }

  // ─── 装配 ────────────────────────────────────────────────────────────────

  /** 订阅三类事件（§12.1.4 / §12.5 / §16.3）。 */
  attach(mesh: Pick<MeshHost, "on" | "nudge">): void {
    this.mesh = mesh;
    mesh.on("message_routed", (p) => this.handleRouted(p.envelope));
    mesh.on("message_delivered", (p) => this.handleDelivered(p));
    mesh.on("message_consumed", (p) => this.handleConsumed(p));
  }

  /** P2 context 钩子：把本轮自动检索的卡片 + 学习队列注入 LLM 上下文（§14.4 / §18.4.4 / §17.5.2）。 */
  contextHookFor(accountId: string): ContextHook {
    const self = this;
    return async (event, _ctx) => {
      const turn = self.turns.get(accountId);
      if (!turn) return undefined;
      await turn.ready;
      const r = turn.retrieval;
      const lq = self.knowledge.learningQueue(turn.ownerAgent);
      const lqCard = self.renderLearningQueue(lq, RETRIEVAL_BUDGET.transient);

      const hasMemory = (r?.cards?.length ?? 0) > 0;
      const hasLq = lqCard !== null;

      // 两边都空 → 无注入（no-op，不写 retrieval_log、不返回额外 messages）。
      if (!hasMemory && !hasLq) return undefined;

      // 幂等（§18.4.4 上下文钩子每个 LLM 调用都会重跑）：同一 trigger_msg 只落一次
      // retrieval_log + 强化一次。hasRetrievalFor 是这个副作用的守门。
      if (turn.sourceMsgId && !self.dao.hasRetrievalFor(turn.ownerAgent, turn.sourceMsgId)) {
        const combinedText = [r?.cardsText ?? "", lqCard?.text ?? ""].filter(Boolean).join("\n\n");
        self.dao.insertRetrievalLog({
          ownerAgent: turn.ownerAgent,
          sceneId: turn.sceneId,
          turn: turn.turn,
          triggerMsgId: turn.sourceMsgId,
          queryJson: r?.queryJson ?? "{}",
          candidates: r?.candidateCount ?? 0,
          selectedJson: r?.selectedJson ?? "[]",
          tokensL2: 0,
          tokensL1: r?.tokensL1 ?? 0,
          tokensTransient: lqCard?.tokens ?? 0,
          tokensTotal: (r?.tokensL1 ?? 0) + (lqCard?.tokens ?? 0),
          clamped: r?.clamped ?? 0,
          renderedCard: combinedText,
          cardSha256: sha256Hex(combinedText ?? ""),
        });
        if (r?.selectedIds?.length) {
          self.dao.reinforce(turn.ownerAgent, r.selectedIds);
        }
      }

      // R3（§10.3）：只追加、不整体替换。
      const msgs = [...((event.messages as unknown[]) ?? [])];
      if (hasMemory) msgs.push(self.memoryCard(r!.cardsText));
      if (lqCard) msgs.push(self.transientCard(lqCard.text));

      return { messages: msgs };
    };
  }

  /** 逐账号领域工具（remember / recall）：闭包持有 owner 分区键与实时轮入口。 */
  async domainHandlersFor(accountId: string): Promise<DomainToolHandlers> {
    const rec = this.registry.byAccountId(accountId);
    if (!rec || rec.agentType !== "role") return {};
    await this.policyFor(accountId); // 预热策略缓存（会话装配即触发，起轮不再冷启动）
    return makeMemoryTools({
      dao: this.dao,
      ownerAgent: rec.agentId,
      currentTurn: () => this.turns.get(accountId),
      // 每次装配取实时快照（新建 Agent 后仍能通过 N2 已知 person 校验，不落在构造期旧快照）。
      knownAgents: new Set(this.registry.allAgentIds()),
      labelOf: (ref) => this.labelOf(ref),
    });
  }

  // ─── 策略 / 标签 ─────────────────────────────────────────────────────────

  private async policyFor(accountId: string): Promise<MemoryPolicy> {
    const hit = this.policyCache.get(accountId);
    if (hit) return hit;
    const policy = (await this.policyOf(accountId)) ?? defaultMemoryPolicy();
    this.policyCache.set(accountId, policy);
    return policy;
  }

  /** 主体显示名：person + 已知 agent → displayName；其余退化为 subject_id。 */
  private labelOf(ref: SubjectRef): string {
    if (ref.type === "person") {
      const rec = this.registry.byAgentId(ref.id);
      if (rec?.displayName) return rec.displayName;
    }
    return ref.id;
  }

  /** accountId → 主体引用（person:<agentId> / facility:<agentId>；未知账号 undefined）。 */
  private subjectRefOfAccount(accountId: string | undefined): SubjectRef | undefined {
    if (!accountId) return undefined;
    const rec = this.registry.byAccountId(accountId);
    if (!rec) return undefined;
    return rec.agentType === "facility" ? { type: "facility", id: rec.agentId } : { type: "person", id: rec.agentId };
  }

  /** 当前在场主体 id 集合（self + 发送方 + to/mentions 中可归属的账号）。 */
  private presentSubjectsOf(envelope: Envelope, receiverAccountId: string): ReadonlySet<string> {
    const set = new Set<string>(["self"]);
    const add = (acc: string | undefined): void => {
      if (!acc || acc === receiverAccountId) return;
      const rec = this.registry.byAccountId(acc);
      if (!rec) return;
      set.add(rec.agentType === "facility" ? `facility:${rec.agentId}` : `person:${rec.agentId}`);
    };
    add(envelope.from);
    envelope.to?.forEach(add);
    envelope.mentions?.forEach(add);
    return set;
  }

  private memoryTrigger(envelope: Envelope, accountId: string, path: MemoryPath): MemoryTrigger {
    return {
      messageId: envelope.id,
      from: envelope.from,
      text: envelopeText(envelope),
      path,
      roleExt: roleExtOf(envelope),
      kind: envelope.kind,
      to: envelope.to,
      mentions: envelope.mentions,
    };
  }

  /**
   * §17.5.2 → §14.1 瞬时上下文块：把学习队列渲染为 `<<<INTENT … INTENT>>>` 卡片。
   * `budgetTokens` 硬上限（§14.1.2），超出截断低优先项（队列已按优先级排序）。
   * 返回 null 表示无所注入。
   */
  private renderLearningQueue(
    items: LearningQueueItem[],
    budgetTokens: number,
  ): { text: string; tokens: number } | null {
    if (items.length === 0) return null;
    const PRIORITY_ZH: Record<LearningQueueItem["priority"], string> = { high: "高", medium: "中", low: "低" };
    const header = "<<<INTENT\n[学习意图]\n";
    const close = "INTENT>>>";
    let budget = budgetTokens - estimateTokens(header) - estimateTokens(close);
    if (budget <= 0) return null;

    const lines: string[] = [];
    for (const item of items) {
      const mot = item.motivation ? `：${item.motivation}` : "";
      const line = `- [${PRIORITY_ZH[item.priority]}] ${item.topic}${mot}`;
      const cost = estimateTokens(line + "\n");
      if (budget < cost) break; // 硬上限截断
      lines.push(line);
      budget -= cost;
    }
    if (lines.length === 0) return null;

    const text = `${header}${lines.join("\n")}\n${close}`;
    return { text, tokens: budgetTokens - budget };
  }

  /** 瞬时上下文块的 mesh 注入形态（customType: "transient" ↔ §14.3.1 三种 ContextBlock kind）。 */
  private transientCard(text: string): unknown {
    return {
      role: "custom",
      customType: "transient",
      content: [{ type: "text", text }],
      display: false,
      timestamp: Date.now(),
    };
  }

  private memoryCard(cardsText: string): unknown {
    return {
      role: "custom",
      customType: "memory",
      content: [{ type: "text", text: cardsText }],
      display: false,
      timestamp: Date.now(),
    };
  }

  // ─── 事件处理 ────────────────────────────────────────────────────────────

  /** 发送方自我记忆（§12.5）：message_routed 每条消息只发一次，天然满足扇出 1 条。 */
  private handleRouted(envelope: Envelope): void {
    const rec = this.registry.byAccountId(envelope.from);
    if (!rec || rec.agentType !== "role") return; // 设施/系统无情节记忆
    // 发给自身 reflect 流的提示不构成记忆（§12.5 边界 2）。
    if (rec.reflectAccountId && envelope.to?.length === 1 && envelope.to[0] === rec.reflectAccountId) return;
    void this.rememberSender(envelope, rec.agentId);
  }

  /** 起轮 + 设施观察（§12.1.1 / §16.3）。woke 且非 P3 才有轮；观察独立于是否唤醒。 */
  private handleDelivered(p: MeshEvents["message_delivered"]): void {
    const rec = this.registry.byAccountId(p.accountId);
    if (!rec || rec.agentType !== "role") return;
    const re = roleExtOf(p.envelope);

    // 设施事件观察：ambient event（expect:none）不会唤醒角色，但仍在 delivered 侧落 observation。
    if (p.envelope.kind === "event" && re.facilityEvent) {
      void this.observeFacility(p.accountId, rec.agentId, p.envelope, re.facilityEvent);
    }

    if (!p.woke || p.path === "P3") return;
    const virtualTs = safeVirtualTs(re.virtualTs);
    const turn = freshTurnState({
      accountId: p.accountId,
      ownerAgent: rec.agentId,
      policy: defaultMemoryPolicy(),
      path: p.path,
      virtualTs,
      virtualHours: virtualHoursOf(virtualTs),
      sceneId: re.sceneId,
      turn: re.turn,
      sourceMsgId: p.envelope.id,
      presentSubjects: this.presentSubjectsOf(p.envelope, p.accountId),
    });
    turn.ready = this.initializeTurn(turn, p.envelope);
    this.turns.set(p.accountId, turn);
  }

  /** 轮终结算（§12.4）：落 memory_decisions + B 模式兜底 nudge；partial（abort）不结算。 */
  private handleConsumed(p: MeshEvents["message_consumed"]): void {
    if (p.partial) return;
    const turn = this.turns.get(p.accountId);
    if (!turn) return;
    this.turns.delete(p.accountId);
    void this.finalizeTurn(turn, p.envelope);
  }

  // ─── 异步内部（不阻塞事件派发）──────────────────────────────────────────

  private async initializeTurn(turn: TurnState, envelope: Envelope): Promise<void> {
    try {
      const policy = await this.policyFor(turn.accountId);
      turn.policy = policy;

      const trigger = this.memoryTrigger(envelope, turn.accountId, turn.path);
      const senderRef = this.subjectRefOfAccount(envelope.from);
      turn.score = scoreMemorability(trigger, policy, {
        currentAccountId: turn.accountId,
        senderRole: this.registry.byAccountId(envelope.from)?.agentType ?? "other",
        trustOfSender: senderRef
          ? (this.dao.profileOf(turn.ownerAgent, senderRef)?.trust ?? policy.defaultTrust)
          : policy.defaultTrust,
        recentGists: this.dao.recentGists(turn.ownerAgent, WRITE.recentGistLimit),
      });

      // 衰减节拍（§15.1）：先衰减再检索，retention 是新鲜导出量。
      this.dao.decaySweep(turn.ownerAgent, turn.virtualHours, policy);

      const text = envelopeText(envelope);
      const candidates = this.dao.searchCandidates(turn.ownerAgent, text, false);
      if (candidates.length > 0) {
        const subjectsByEpisode = this.dao.subjectsOf(
          turn.ownerAgent,
          candidates.map((c) => c.episodeId),
        );
        const ranked = rankCandidatesWithSubjects(candidates, subjectsByEpisode, {
          nowHours: turn.virtualHours,
          tau0Hours: policy.tau0Hours,
          presentSubjects: turn.presentSubjects,
        });
        const filtered = strongCueFilter(ranked, false);
        const render = makeRankedCardRenderer({
          subjectsByEpisode,
          nowHours: turn.virtualHours,
          labelOf: (ref) => this.labelOf(ref),
        });
        const selected = selectCards(filtered, render, turn.ledger, false);
        if (selected.cards.length > 0) {
          const cardsText = renderMemoryBlocks(selected.cards);
          turn.retrieval = {
            cards: selected.cards,
            cardsText,
            selectedIds: selected.selectedIds,
            queryJson: JSON.stringify({ query: text }),
            candidateCount: candidates.length,
            selectedJson: JSON.stringify(selected.selectedIds),
            tokensL1: selected.tokens,
            tokensTotal: selected.tokens,
            clamped: selected.clamped,
            renderedCard: cardsText,
          };
        }
      }
    } catch {
      // 初始化失败不阻断轮次：策略保持默认，检索缺席，remember / recall 仍可用。
    }
  }

  private async finalizeTurn(turn: TurnState, envelope: Envelope): Promise<void> {
    await turn.ready;
    const owner = turn.ownerAgent;
    const sourceMsgId = turn.sourceMsgId ?? envelope.id;
    const written = this.dao.hasEpisodeFor(owner, sourceMsgId);
    this.dao.insertDecision({
      ownerAgent: owner,
      sourceMsgId,
      path: turn.path,
      score: turn.score?.salience ?? 0,
      writeDecided: turn.score?.write ?? false,
      written,
      nudged: false,
      componentsJson: JSON.stringify(turn.score?.components ?? {}),
      virtualTs: turn.virtualTs,
    });
    this.maybeNudge(owner, written);
  }

  /** B 模式兜底（§12.4）：write_decided=1 且未写且未 nudge 的行，补一次 followUp 追问。 */
  private maybeNudge(owner: string, wroteThisTurn: boolean): void {
    if (!this.mesh) return;
    if (wroteThisTurn) {
      this.nudgeFailures.set(owner, 0);
      return;
    }
    const pending = this.dao.pendingNudges(owner).filter((n) => !n.nudged);
    if (pending.length === 0) return;
    const failed = this.nudgeFailures.get(owner) ?? 0;
    if (failed >= WRITE.nudgeCircuitBreaker) return;
    const rec = this.registry.byAgentId(owner);
    if (!rec) return;

    const target = pending[0];
    if (!target) return;
    this.nudgeFailures.set(owner, failed + 1);
    void this.mesh
      .nudge(rec.endpointId, NUDGE_TEXT, { deliverAs: "followUp", triggerTurn: false })
      .then(() => this.dao.markNudged(owner, target.sourceMsgId))
      .catch(() => {});
  }

  private async rememberSender(envelope: Envelope, owner: string): Promise<void> {
    try {
      const policy = await this.policyFor(envelope.from);
      const trigger = this.memoryTrigger(envelope, envelope.from, "P1");
      const score = scoreSenderMemorability(trigger, policy, {
        currentAccountId: envelope.from,
        recentGists: this.dao.recentGists(owner, WRITE.recentGistLimit),
      });
      if (!score.write) return;
      // 发送方自我记忆只落「判定行」：真正的写走 B 模式兜底（发送方没有自己的 turns 来 A 主动写）。
      this.dao.insertDecision({
        ownerAgent: owner,
        sourceMsgId: envelope.id,
        path: "P1",
        score: score.salience,
        writeDecided: true,
        written: false,
        nudged: false,
        componentsJson: JSON.stringify(score.components),
        virtualTs: safeVirtualTs(roleExtOf(envelope).virtualTs),
      });
    } catch {
      // 发送方记忆失败静默（不阻断路由事件派发）。
    }
  }

  private async observeFacility(
    accountId: string,
    owner: string,
    envelope: Envelope,
    fe: FacilityEventPayload,
  ): Promise<void> {
    try {
      const policy = await this.policyFor(accountId);
      const re = roleExtOf(envelope);
      const text = envelopeText(envelope);
      const gist = facilityGist(fe, text);
      if (!gist) return;
      const recent = this.dao.recentGists(owner, WRITE.recentGistLimit);
      const novelty = fe.anomalous ? 1 : 1 - maxSimilarity(gist, recent);
      const arousal = clamp01(emotionalArousal(text) * policy.arousalGain);
      const selfRelevance = 0.3; // 设施事件不针对 self（§16.3 ③）
      const repetition = recent.filter((g) => trigramSimilarity(gist, g) >= 0.5).length > 1 ? 0.6 : 0;
      const raw =
        policy.w.novelty * novelty +
        policy.w.arousal * arousal +
        policy.w.selfRelevance * selfRelevance +
        policy.w.repetition * repetition;
      const salience = clamp01(raw);
      if (raw < policy.writeThreshold) return;

      const virtualTs = safeVirtualTs(re.virtualTs);
      const subjects: SubjectRef[] = fe.facilities.map((fid) => ({ type: "facility", id: fid }));
      subjects.push({ type: "self", id: "self" });
      this.dao.insertEpisode({
        episodeId: newId("ep"),
        ownerAgent: owner,
        kind: "event",
        sceneId: re.sceneId ?? null,
        purposeKind: null,
        sourceMsgId: envelope.id,
        sourceSessionId: null,
        sourceEntryId: null,
        gist: gist.slice(0, 200),
        detail: text ? text.slice(0, 400) : null,
        quote: null,
        emotion: null,
        valence: null,
        arousal: null,
        salience,
        confidence: OBSERVATION_CONFIDENCE,
        accuracy: null,
        virtualTs,
        virtualHours: virtualHoursOf(virtualTs),
        retention: salience,
        status: "active",
        modelConfigHash: null,
        subjects: subjects.map((s) => ({ ref: s })),
      });
    } catch {
      // 观察写入失败静默（不阻断投递事件派发）。
    }
  }
}