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
import type { EpisodeCandidate, MemoryDao } from "./dao.js";
import { Fts5Backend, type RetrievalBackend } from "./backend.js";
import { estimateTokens, renderMemoryBlocks, renderTeachingProgress } from "./render.js";
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
import { parseSubjectRef, type SubjectRef } from "./subject.js";
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
 * 设施事件的观察 gist（§16.3.2）：按接收方 `narrative_voice.sensory.dominant_channel`
 * 从 renderHints 挑通道——视觉型记「板书很乱」，听觉型记「后排窃窃私语」。未指定通道或该
 * 通道无片段时退化为串接全部通道；renderHints 全空时退回中性 text。
 */
function facilityGist(
  fe: FacilityEventPayload,
  text: string,
  dominantChannel?: "visual" | "auditory" | "tactile" | "olfactory",
): string {
  const rh = fe.renderHints;
  if (rh && dominantChannel) {
    const parts = rh[dominantChannel];
    if (parts && parts.length > 0) return parts.join("；");
  }
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
  /** R31 内部健康保护：fail-closed 时（invariant 违反 / accessControl 降级）返回 false，
   *  记忆写入（情节 / 判定 / 观察）一律停写。缺省恒 true（无健康哨兵）。 */
  writesAllowed?: () => boolean;
  /** O03 可替换检索后端（缺省 FTS5）。向量后端在此注入，自动注入与 recall 共用。 */
  backend?: RetrievalBackend;
}

export class MemoryService {
  private readonly dao: MemoryDao;
  private readonly registry: RoleAccountRegistry;
  private readonly knowledge: KnowledgeService;
  private readonly policyOf: (accountId: string) => Promise<MemoryPolicy | undefined>;
  /** R31 内部健康保护：fail-closed 停写门（缺省放行）。 */
  private readonly writesAllowed: () => boolean;
  /** O03 可替换检索后端（缺省 FTS5）。 */
  private readonly backend: RetrievalBackend;

  /** accountId → 当前活动轮（一个 owner 一轮；message_consumed 结算清除）。 */
  private readonly turns = new Map<string, TurnState>();
  /** A11：sourceMsgId → 活动轮——同账号多 delivery 时 consumed 按来源消息精确结算，不串来源。 */
  private readonly turnsByMsg = new Map<string, TurnState>();
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
    this.writesAllowed = deps.writesAllowed ?? (() => true);
    this.backend = deps.backend ?? new Fts5Backend(deps.dao);
  }

  // ─── 装配 ────────────────────────────────────────────────────────────────

  /** 订阅三类事件（§12.1.4 / §12.5 / §16.3）。 */
  attach(mesh: Pick<MeshHost, "on" | "nudge">): void {
    this.mesh = mesh;
    mesh.on("message_routed", (p) => this.handleRouted(p.envelope));
    mesh.on("message_delivered", (p) => this.handleDelivered(p));
    mesh.on("message_consumed", (p) => this.handleConsumed(p));
  }

  /** P2 context 钩子：把 L2 画像/知识、L1 记忆卡片、瞬时状态 + 学习队列注入 LLM 上下文
   *  （§14.1.2 / §18.4.4 / §17.5.2；R23 分层预算 L2≤500 / L1≤900 / 瞬时≤150，L2 优先于 L1）。 */
  contextHookFor(accountId: string): ContextHook {
    const self = this;
    return async (event, _ctx) => {
      const turn = self.turns.get(accountId);
      if (!turn) return undefined;
      await turn.ready;
      const r = turn.retrieval;

      // ── L2（§14.1.2 / R23）：本人画像 + 知识摘要 + 发送者印象；无 L1 命中也可注入。 ──
      const selfProfile = self.dao.profileOf(turn.ownerAgent, { type: "self", id: "self" });
      const knowledgeSummary = self.knowledge.summary(turn.ownerAgent);
      const senderRec = turn.senderAccountId ? self.registry.byAccountId(turn.senderAccountId) : undefined;
      const senderRef: SubjectRef | undefined = senderRec
        ? senderRec.agentType === "facility"
          ? { type: "facility", id: senderRec.agentId }
          : { type: "person", id: senderRec.agentId }
        : undefined;
      const senderProfile = senderRef ? self.dao.profileOf(turn.ownerAgent, senderRef) : undefined;
      const l2Card = self.renderL2Card(
        selfProfile?.impression ?? null,
        knowledgeSummary,
        senderRef ? self.labelOf(senderRef) : null,
        senderProfile?.impression ?? null,
        RETRIEVAL_BUDGET.l2,
      );

      // ── 瞬时（§14.1.2 / R23）：实时状态（情绪/精力）+ 学习队列，共享 150 额度。 ──
      const state = self.dao.currentState(turn.ownerAgent);
      const stateCard = self.renderStateCard(state, RETRIEVAL_BUDGET.transient);
      const lq = self.knowledge.learningQueue(turn.ownerAgent);
      const lqCard = self.renderLearningQueue(
        lq,
        Math.max(0, RETRIEVAL_BUDGET.transient - (stateCard?.tokens ?? 0)),
      );

      // ── 教学进度（§17.6 / Q09）：最近教学里程碑，独立配额 ≤200 / 3 条（不占 L1/L2/瞬时）。 ──
      const progressCandidates = self.dao.recentByPurpose(turn.ownerAgent, "teaching_progress");
      const progressCard = renderTeachingProgress(progressCandidates, RETRIEVAL_BUDGET.teachingProgress);

      const hasL2 = l2Card !== null;
      const hasMemory = (r?.cards?.length ?? 0) > 0;
      const hasTransient = stateCard !== null || lqCard !== null;
      const hasPurpose = progressCard !== null;

      // 四层皆空 → 无注入（no-op，不写 retrieval_log、不返回额外 messages）。
      if (!hasL2 && !hasMemory && !hasTransient && !hasPurpose) return undefined;

      const l2Tokens = l2Card?.tokens ?? 0;
      const l1Tokens = r?.tokensL1 ?? 0;
      const transientTokens = (stateCard?.tokens ?? 0) + (lqCard?.tokens ?? 0);
      const purposeTokens = progressCard?.tokens ?? 0;

      // 幂等（§18.4.4 上下文钩子每个 LLM 调用都会重跑）：同一 trigger_msg 只落一次
      // retrieval_log + 强化一次。hasRetrievalFor 是这个副作用的守门。
      if (turn.sourceMsgId && !self.dao.hasRetrievalFor(turn.ownerAgent, turn.sourceMsgId)) {
        const combinedText = [l2Card?.text ?? "", r?.cardsText ?? "", stateCard?.text ?? "", lqCard?.text ?? "", progressCard?.text ?? ""]
          .filter(Boolean)
          .join("\n\n");
        self.dao.insertRetrievalLog({
          ownerAgent: turn.ownerAgent,
          sceneId: turn.sceneId,
          turn: turn.turn,
          triggerMsgId: turn.sourceMsgId,
          queryJson: r?.queryJson ?? "{}",
          candidates: r?.candidateCount ?? 0,
          selectedJson: r?.selectedJson ?? "[]",
          tokensL2: l2Tokens,
          tokensL1: l1Tokens,
          tokensTransient: transientTokens,
          tokensPurpose: purposeTokens,
          tokensTotal: l2Tokens + l1Tokens + transientTokens + purposeTokens,
          clamped: r?.clamped ?? 0,
          renderedCard: combinedText,
          cardSha256: sha256Hex(combinedText ?? ""),
        });
        if (r?.selectedIds?.length) {
          self.dao.reinforce(turn.ownerAgent, r.selectedIds);
        }
      }

      // R3（§10.3）：只追加、不整体替换。次序 L2 → L1 → 瞬时（§14.1.2 L2 优先于 L1）。
      const msgs = [...((event.messages as unknown[]) ?? [])];
      if (l2Card) msgs.push(self.l2ContextCard(l2Card.text));
      if (hasMemory) msgs.push(self.memoryCard(r!.cardsText));
      if (stateCard) msgs.push(self.transientCard(stateCard.text));
      if (lqCard) msgs.push(self.transientCard(lqCard.text));
      if (progressCard) msgs.push(self.transientCard(progressCard.text));

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
      backend: this.backend,
      ownerAgent: rec.agentId,
      currentTurn: () => this.turns.get(accountId),
      // 每次装配取实时快照（新建 Agent 后仍能通过 N2 已知 person 校验，不落在构造期旧快照）。
      knownAgents: new Set(this.registry.allAgentIds()),
      labelOf: (ref) => this.labelOf(ref),
      // R31：fail-closed 时 remember / note_self 拒写（健康哨兵与事件处理共用同一门）。
      writesAllowed: () => this.writesAllowed(),
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

  /**
   * 瞬时上下文块的注入形态。M02：durable 端 pi-ai `Message` 只认 `role:"user"|"assistant"|"system"`
   * + 字符串 content，故记忆/学习队列卡片按 `UserMessage = {role:"user", content, timestamp}` 注入，
   * 不再用旧 coding-agent 的 `{role:"custom", content:[{type:"text"}]}` 形状（afterGeneration 钩子注入）。
   */
  private transientCard(text: string): unknown {
    return { role: "user", content: text, timestamp: Date.now() };
  }

  private memoryCard(cardsText: string): unknown {
    return { role: "user", content: cardsText, timestamp: Date.now() };
  }

  /**
   * R23 L2 卡（§14.1.2 ≤500）：本人自我印象 + 知识摘要 + 发送者印象。印象短句优先；
   * 知识摘要逐行加入、超出硬上限即停（可截断，§14.1.2 dropped 不虚扣）。全部为空返回 null。
   */
  private renderL2Card(
    selfImpression: string | null,
    knowledge: string,
    senderLabel: string | null,
    senderImpression: string | null,
    budgetTokens: number,
  ): { text: string; tokens: number } | null {
    const header = "<<<SELF\n[我的画像与知识]\n";
    const close = "SELF>>>";
    let budget = budgetTokens - estimateTokens(header) - estimateTokens(close);
    if (budget <= 0) return null;

    const lines: string[] = [];
    let any = false;
    const push = (line: string): boolean => {
      const cost = estimateTokens(line + "\n");
      if (cost > budget) return false;
      lines.push(line);
      budget -= cost;
      return true;
    };
    const clean = (s: string | null): string | null => (s && s.trim().length > 0 ? s.trim() : null);

    const selfClean = clean(selfImpression);
    if (selfClean && push(`- 自我印象：${selfClean}`)) any = true;

    const senderClean = clean(senderImpression);
    if (senderLabel && senderClean && push(`- 对${senderLabel}的印象：${senderClean}`)) any = true;

    const knowledgeLines = knowledge.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const k of knowledgeLines) {
      if (push(`- ${k}`)) any = true;
    }

    if (!any) return null;
    const text = `${header}${lines.join("\n")}\n${close}`;
    return { text, tokens: budgetTokens - budget };
  }

  /** R23 L2 画像/知识卡片的注入形态（与 memoryCard/transientCard 同构的 UserMessage）。 */
  private l2ContextCard(text: string): unknown {
    return { role: "user", content: text, timestamp: Date.now() };
  }

  /**
   * R23 实时状态卡（§14.1.2 瞬时档）：情绪 + 精力。默认状态（中性 / 0.5 / 0.5）不注入，
   * 避免每轮噪音——只在自省 stateAdjust 改变状态后才进上下文。超瞬时额度宁可省略。
   */
  private renderStateCard(
    state: { mood: string; moodIntensity: number; energy: number },
    budgetTokens: number,
  ): { text: string; tokens: number } | null {
    const isDefault =
      state.mood === "中性" && state.moodIntensity === 0.5 && state.energy === 0.5;
    if (isDefault) return null;
    const text = [
      "<<<STATE",
      "[当前状态]",
      `- 情绪：${state.mood}（强度 ${state.moodIntensity.toFixed(2)}）`,
      `- 精力：${state.energy.toFixed(2)}`,
      "STATE>>>",
    ].join("\n");
    const tokens = estimateTokens(text);
    if (tokens > budgetTokens) return null; // 固定字段不该超，超了宁可省略
    return { text, tokens };
  }

  // ─── 事件处理 ────────────────────────────────────────────────────────────

  /** 发送方自我记忆（§12.5）：message_routed 每条消息只发一次，天然满足扇出 1 条。 */
  private handleRouted(envelope: Envelope): void {
    const rec = this.registry.byAccountId(envelope.from);
    if (!rec || rec.agentType !== "role") return; // 设施/系统无情节记忆
    // 发给自身 reflect 流的提示不构成记忆（§12.5 边界 2）。
    if (rec.reflectAccountId && envelope.to?.length === 1 && envelope.to[0] === rec.reflectAccountId) return;
    // R31：fail-closed 时停写（发送方自我记忆的判定行也是记忆写入）。
    if (!this.writesAllowed()) return;
    void this.rememberSender(envelope, rec.agentId);
  }

  /** 起轮 + 设施观察（§12.1.1 / §16.3）。woke 且非 P3 才有轮；观察独立于是否唤醒。 */
  private handleDelivered(p: MeshEvents["message_delivered"]): void {
    const rec = this.registry.byAccountId(p.accountId);
    if (!rec || rec.agentType !== "role") return;
    const re = roleExtOf(p.envelope);

    // P3（静默档）零对话情节：先于任何观察写入判定资格（§16.3 / R21）。
    if (p.path === "P3") return;

    // 设施事件观察：ambient event（expect:none）不会唤醒角色，但仍在 delivered 侧落 observation。
    if (p.envelope.kind === "event" && re.facilityEvent) {
      // R31：fail-closed 时观察也不落库（观察是记忆写入）。
      if (this.writesAllowed()) void this.observeFacility(p.accountId, rec.agentId, p.envelope, re.facilityEvent);
    }

    if (!p.woke) return;
    const virtualTs = safeVirtualTs(re.virtualTs);
    const turn = freshTurnState({
      accountId: p.accountId,
      ownerAgent: rec.agentId,
      senderAccountId: p.envelope.from,
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
    this.turnsByMsg.set(p.envelope.id, turn);
  }

  /** 轮终结算（§12.4）：落 memory_decisions + B 模式兜底 nudge；partial（abort）不结算。 */
  private handleConsumed(p: MeshEvents["message_consumed"]): void {
    if (p.partial) return;
    // A11：按来源消息 id 结算，而非 accountId——同账号 D1/D2 乱序消费不串来源、不删错轮。
    const turn = this.turnsByMsg.get(p.envelope.id);
    if (!turn) return;
    this.turnsByMsg.delete(p.envelope.id);
    // 只有当该消息仍是「当前活动轮」时才清掉 accountId 入口，避免误删更新的轮。
    if (this.turns.get(p.accountId) === turn) this.turns.delete(p.accountId);
    void this.finalizeTurn(turn, p.envelope);
  }

  // ─── 异步内部（不阻塞事件派发）──────────────────────────────────────────

  private async initializeTurn(turn: TurnState, envelope: Envelope): Promise<void> {
    try {
      const policy = await this.policyFor(turn.accountId);
      turn.policy = policy;

      const trigger = this.memoryTrigger(envelope, turn.accountId, turn.path);
      const senderRef = this.subjectRefOfAccount(envelope.from);
      // R22：发送方角色取 agents.role（真实角色名），不用 agentType（"role"/"facility"）
      // 充当社会角色——authorityWeights 的键是角色名（teacher/student…），agentType 命中不了。
      const senderRec = this.registry.byAccountId(envelope.from);
      turn.score = scoreMemorability(trigger, policy, {
        currentAccountId: turn.accountId,
        senderRole: senderRec
          ? (this.dao.roleOfAgent(senderRec.agentId) ?? senderRec.agentType)
          : "other",
        trustOfSender: senderRef
          ? (this.dao.profileOf(turn.ownerAgent, senderRef)?.trust ?? policy.defaultTrust)
          : policy.defaultTrust,
        recentGists: this.dao.recentGists(turn.ownerAgent, WRITE.recentGistLimit),
      });

      // 衰减节拍（§15.1）：先衰减再检索，retention 是新鲜导出量。
      this.dao.decaySweep(turn.ownerAgent, turn.virtualHours, policy);

      const text = envelopeText(envelope);
      const ftsCandidates = this.backend.searchCandidates({ owner: turn.ownerAgent, query: text, includeFaded: false });
      // A29：主体候选补充——整条自然语言进 FTS 被当精确短语时，措辞不同的旧 gist 无候选；
      // 在场主体在 episode_subjects 里可反查，把「同一人物/场所」的情节捞回候选面。
      // self 是 owner 自聚焦兜底、范围过宽，DAO 内部已排除。
      const subjectRefs = [...turn.presentSubjects]
        .map((k) => {
          try {
            return parseSubjectRef(k);
          } catch {
            return undefined;
          }
        })
        .filter((s): s is SubjectRef => s !== undefined && s.type !== "self");
      const subjectCandidates = this.dao.searchCandidatesBySubjects(turn.ownerAgent, subjectRefs, false);
      // 合并去重：FTS 候选优先保留其 bm25 相关性；同 id 的主体候选只在 FTS 缺席时补位。
      const merged = new Map<string, EpisodeCandidate>();
      for (const c of ftsCandidates) merged.set(c.episodeId, c);
      for (const c of subjectCandidates) if (!merged.has(c.episodeId)) merged.set(c.episodeId, c);
      const candidates = [...merged.values()];
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
            queryJson: JSON.stringify({ query: text, backend: this.backend.id }),
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
    // R31：fail-closed 时停写判定行（B 模式兜底 nudge 一并跳过，不追写）。
    if (!this.writesAllowed()) return;
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
    try {
      // H04/R16 teardown 竞态：close 后迟到的 turn_end 仍可能走到这里，mesh 已关时 nudge
      // 的 assertOpen 会**同步**抛出（不会被下方的 .catch 接住），故先包一层同步 try。
      void this.mesh
        .nudge(rec.endpointId, NUDGE_TEXT, { deliverAs: "followUp", triggerTurn: false })
        .then(() => this.dao.markNudged(owner, target.sourceMsgId))
        .catch(() => {});
    } catch {
      // mesh 已关闭：best-effort 追问无从投递，静默丢弃（B 模式兜底本就是可丢失路径）。
    }
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
      const gist = facilityGist(fe, text, policy.dominantChannel);
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