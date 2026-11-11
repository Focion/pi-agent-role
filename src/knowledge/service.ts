// ═══════════════════════════════════════════════════════════════════════════
// KnowledgeService（§17）—— 知识状态机的校验与落库装配点
//
// 一件事：把「自省提议的知识迁移」变成「有证据链的知识状态变更」，或驳回并记审计。
//   · applyUpdate —— 校验封闭迁移集（T1–T11）+ 证据门槛（§17.2）+ T4 mastered 查库
//                    （跨 2 虚拟日 / 2 次 solved）+ evidenceEpisode 归属 + taught_by 归因。
//   · seedFromTemplate —— 模板种入（§17.4 来源 1，academic.yaml 薄弱项 → knowledge_items）。
//   · decay —— 知识衰减（§17.5.1，T7/T8，纯 SQL 环路）。
//   · summary —— 供反射输入的现有掌握度摘要（§13.4.1）。
//
// 与 mesh 边界：不 import @pi/agent-mesh（R1）、不出现 mesh_ 表名（R2）、不出现 ext 字段（R3）。
// ═══════════════════════════════════════════════════════════════════════════

import type { KnowledgeItem } from "../compile/types.js";
import { parseSubjectRef, serializeSubjectRef, unknownPersons } from "../memory/subject.js";
import { newId } from "../runtime/id.js";
import { virtualHoursOf } from "../runtime/virtual-clock.js";
import type { KnowledgeDao, KnowledgeChange, KnowledgeEventWrite } from "./dao.js";
import { EVIDENCE_KINDS, classifyUpdate, CONFIDENCE_DELTA_CAP, type KnowledgeUpdateProposal, type KnowledgeVerdict, type Mastery, type LearningQueueItem } from "./types.js";

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

const PRIORITY_RANK: Record<LearningQueueItem["priority"], number> = { high: 3, medium: 2, low: 1 };

export interface KnowledgeServiceDeps {
  dao: KnowledgeDao;
  /** 已知 person 主体集合快照（N2 校验 taught_by 的 person 归因，§17.3）。 */
  knownAgents: () => ReadonlySet<string>;
}

/** applyUpdate 的来源上下文（§17.2 source）。 */
export interface KnowledgeApplySource {
  reflectionId?: string;
  episodeId?: string;
  virtualTs: string;
  /** 缺省由 virtualTs 推导。 */
  virtualHours?: number;
}

export class KnowledgeService {
  private readonly dao: KnowledgeDao;
  private readonly knownAgents: () => ReadonlySet<string>;

  constructor(deps: KnowledgeServiceDeps) {
    this.dao = deps.dao;
    this.knownAgents = deps.knownAgents;
  }

  // ─── 校验 + 落库（§17.2）───────────────────────────────────────────────────

  applyUpdate(owner: string, p: KnowledgeUpdateProposal, source: KnowledgeApplySource): KnowledgeVerdict {
    const topic = (p.topic ?? "").trim();
    if (topic.length === 0) {
      return { ok: false, reason: "ILLEGAL_TRANSITION" };
    }
    const kind = p.evidenceKind;
    if (!EVIDENCE_KINDS.includes(kind)) return { ok: false, reason: "EVIDENCE_MISSING" };
    if (kind === "decay") return { ok: false, reason: "ILLEGAL_TRANSITION" }; // decay 只由衰减任务写（§17.5）

    const existing = this.dao.item(owner, topic);
    const current = existing?.mastery ?? null;
    // A14：fading 恢复的晋级上限 = 衰减前状态（decay_from 透传进 classifyUpdate）。
    const plan = classifyUpdate(current, p.toMastery, kind, existing?.decayFrom ?? null);
    if (!plan.ok) {
      this.audit(owner, topic, plan.reason, existing, null, source);
      return { ok: false, reason: plan.reason };
    }

    // 证据情节：声明的 evidenceEpisode 必须存在且属于 owner（§17.2）。
    if (p.evidenceEpisode) {
      if (!this.dao.episodeExists(p.evidenceEpisode)) {
        this.audit(owner, topic, "EVIDENCE_NOT_FOUND", existing, null, source);
        return { ok: false, reason: "EVIDENCE_NOT_FOUND" };
      }
      if (!this.dao.episodeOwnedBy(owner, p.evidenceEpisode)) {
        this.audit(owner, topic, "EVIDENCE_NOT_OWNED", existing, null, source);
        return { ok: false, reason: "EVIDENCE_NOT_OWNED" };
      }
    }

    const virtualHours = source.virtualHours ?? virtualHoursOf(source.virtualTs);
    const knId = existing?.knId ?? newId("kn");
    const final = this.resolveFinalState(existing, p, plan.to, plan.events === "none", plan.markMisconception);

    // T4 mastered-via-solved：≥2 solved 且跨 ≥2 虚拟日（查库，不能信自述）。
    if (plan.events !== "none" && final.to === "mastered" && kind === "solved") {
      const se = this.dao.solvedEvidence(owner, knId);
      const totalCount = se.count + 1;
      const totalDays = new Set([...se.days, Math.floor(virtualHours / 24)]).size;
      if (totalCount < 2) {
        this.audit(owner, topic, "MASTERED_COUNT_TOO_FEW", existing, null, source);
        return { ok: false, reason: "MASTERED_COUNT_TOO_FEW" };
      }
      if (totalDays < 2) {
        this.audit(owner, topic, "MASTERED_SPAN_TOO_SHORT", existing, null, source);
        return { ok: false, reason: "MASTERED_SPAN_TOO_SHORT" };
      }
    }

    // §17.2 Q05：taught 是「教会别人」的最强证据，成立需双证据——① 讲者双主体情节（存在且
    // owner=讲者，主体含 person:听者 + knowledge:topic）② 听者侧已迁移（≥understood 且
    // taught_by=讲者）。①不齐则拒绝；②未落地则记 pending_taught，日终回补，本轮不成立 mastered。
    if (plan.events !== "none" && final.to === "mastered" && kind === "taught") {
      if (!p.evidenceEpisode) {
        this.audit(owner, topic, "EVIDENCE_MISSING", existing, null, source);
        return { ok: false, reason: "EVIDENCE_MISSING" };
      }
      const subjects = this.dao.episodeSubjects(p.evidenceEpisode);
      const knowledgeHit = subjects.some((s) => s.type === "knowledge" && s.id === topic);
      const listener = subjects.find((s) => s.type === "person");
      if (!knowledgeHit || !listener) {
        this.audit(owner, topic, "EVIDENCE_MISSING", existing, null, source);
        return { ok: false, reason: "EVIDENCE_MISSING" };
      }
      const listenerRef = serializeSubjectRef({ type: "person", id: listener.id });
      const speakerRef = serializeSubjectRef({ type: "person", id: owner });
      if (!this.dao.listenerProgress(listener.id, topic, speakerRef)) {
        // 讲者先记 pending，等听者迁移后由日终回补（§17.2）；本轮保持 applied，不写 taught 事件。
        const pendingId = newId("pt");
        this.dao.insertPendingTaught({
          pendingId,
          ownerAgent: owner,
          knId,
          topic,
          listenerRef,
          evidence: p.evidence?.slice(0, 400) ?? null,
          episodeId: p.evidenceEpisode,
          virtualTs: source.virtualTs,
          virtualHours,
        });
        this.audit(owner, topic, null, existing, final.to, source);
        const pendingFrom: Mastery = existing?.mastery ?? "applied";
        return { ok: true, knId, from: pendingFrom, to: pendingFrom, eventIds: [], practiced: false, taughtPending: { pendingId, listener: listenerRef } };
      }
    }

    // 构造事件链。T5 跳级补中间 understood 事件（§17.1.2）。
    const events: KnowledgeEventWrite[] = [];
    if (plan.events === "skip") {
      // 中间 understood 事件用 self_explained 标记（「想明白了」），末段 applied 才是真的
      // solved——否则补写事件会被 T4 门槛计成第二次 solved（§17.2）。
      events.push(this.event(knId, owner, plan.from, "understood", "self_explained", p.evidence, p.evidenceEpisode ?? source.episodeId ?? null, source.virtualTs, virtualHours));
      events.push(this.event(knId, owner, "understood", "applied", kind, p.evidence, p.evidenceEpisode ?? source.episodeId ?? null, source.virtualTs, virtualHours));
    } else if (plan.events === "one") {
      events.push(this.event(knId, owner, plan.from, plan.to, kind, p.evidence, p.evidenceEpisode ?? source.episodeId ?? null, source.virtualTs, virtualHours));
    }

    const change: KnowledgeChange = {
      owner,
      knId,
      topic,
      claim: (p.claim ?? existing?.claim ?? topic).slice(0, 200),
      isNew: existing === undefined,
      mastery: final.to,
      confidence: final.confidence,
      practiceCount: final.practiceCount,
      lastPracticedVhours: virtualHours,
      lastPracticedAt: source.virtualTs,
      retention: 1.0, // 每次 practice 重置（§17.5.1：用对一次就拉满）
      isMisconception: final.isMisconception,
      wrongBelief: final.wrongBelief,
      taughtBy: final.taughtBy,
      sourceKind: "inferred",
      firstSeenAt: existing?.firstSeenAt ?? source.virtualTs,
      events,
    };
    this.dao.applyChange(change);
    this.audit(owner, topic, null, existing, final.to, source);

    // §17.4.2 纠正流程：误区从 1 → 0 是高价值事件，调用方据此写系统抬高的高显著节情节。
    const misconceptionCorrected =
      existing !== undefined && existing.isMisconception === 1 && final.isMisconception === 0
        ? { topic, corrector: final.taughtBy, wrongBelief: existing.wrongBelief }
        : undefined;

    return {
      ok: true,
      knId,
      from: plan.from,
      to: plan.to,
      eventIds: events.map((e) => e.evId),
      practiced: plan.events === "none",
      ...(misconceptionCorrected ? { misconceptionCorrected } : {}),
    };
  }

  // ─── 模板种入（§17.4 来源 1）───────────────────────────────────────────────

  /** 把 initialState.knowledgeSeed（academic.yaml 薄弱项）种入 knowledge_items。幂等。 */
  seedFromTemplate(
    owner: string,
    items: KnowledgeItem[],
    opts?: { firstSeenAt?: string; nowReal?: () => string },
  ): number {
    let seeded = 0;
    const firstSeenAt = opts?.firstSeenAt ?? new Date().toISOString();
    for (const it of items) {
      const topic = (it.topic ?? "").trim();
      if (!topic) continue;
      if (this.dao.item(owner, topic)) continue; // 幂等：已存在不覆盖
      // 薄弱项 = 听过但未掌握，种出一条 heard。误解内容由 claim 承载（保留给后续编译层细化）。
      this.dao.seedItem({ owner, topic, claim: it.claim ?? topic, mastery: "heard", firstSeenAt });
      seeded += 1;
    }
    return seeded;
  }

  // ─── 衰减（§17.5.1）────────────────────────────────────────────────────────

  decay(owner: string, virtualHours: number, tau0Hours: number) {
    return this.dao.decay(owner, virtualHours, tau0Hours);
  }

  /**
   * 日终回补（§17.2 Q05「日终回补」）：扫讲者的 open pending_taught，听者一旦迁移到
   * ≥understood 且归因讲者，就把 pending 的 `taught` 证据落地为 mastered 成立（写一条
   * taught 事件 + 升 mastered）。已 mastered 的幂等跳过、不重复写事件；畸行/非法听者标
   * rejected。返回本轮确认条数。跨分区读只在服务层发生，Agent 只拿到成立与否。
   */
  backfillPendingTaught(owner: string, opts?: { virtualTs?: string; virtualHours?: number }): number {
    let confirmed = 0;
    const speakerRef = serializeSubjectRef({ type: "person", id: owner });
    for (const p of this.dao.openPendingTaught(owner)) {
      let listenerId: string;
      try {
        const ref = parseSubjectRef(p.listenerRef);
        listenerId = ref.type === "person" ? ref.id : "";
      } catch {
        listenerId = "";
      }
      if (listenerId === "") {
        this.dao.markPendingSettled(p.pendingId, "rejected");
        continue;
      }
      if (!this.dao.listenerProgress(listenerId, p.topic, speakerRef)) continue; // 听者未迁移，等下一个日终。
      const item = this.dao.item(owner, p.topic);
      if (item && item.mastery === "applied") {
        this.dao.applyTaughtPromotion({
          evId: newId("ke"),
          knId: p.knId,
          owner,
          from: "applied",
          evidence: p.evidence,
          episodeId: p.episodeId,
          virtualTs: opts?.virtualTs ?? p.virtualTs,
          virtualHours: opts?.virtualHours ?? p.virtualHours,
        });
      }
      this.dao.markPendingSettled(p.pendingId, "resolved");
      confirmed += 1;
    }
    return confirmed;
  }

  /** 供反射输入的掌握度摘要（§13.4.1 knowledgeSummary）。 */
  summary(owner: string): string {
    return this.dao.knowledgeSummary(owner);
  }

  /** 最近一次自省留下的学习队列（§17.5.2）；供场景 open 注入瞬时上下文读取。 */
  learningQueue(owner: string): LearningQueueItem[] {
    return this.dao.lastLearningQueue(owner);
  }

  /**
   * 学习队列整理（§17.5.2 Q1/Q2/Q3/Q4）。入参 `proposed` 是本次自省模型给出的新意图，
   * 返回整理后的队列（去重、按优先级排序、封顶 7）。
   *   · Q4：is_misconception=1 的 topic 自动入队（priority=high，motivation 写系统模糊语，
   *     绝不把 wrong_belief 文本带入——否则误区会自我消解）；
   *   · A34：继承上一轮队列（模型省略 learningQueue 时，未完成的非误区项不消失）；
   *   · Q1：mastery 已达 applied+ 且非误区的 topic 出队（A33：仍有误区的 applied/mastered
   *     项保持 high，不因掌握度高而连带出队）；
   *   · Q2：连续 3 个虚拟日未被任何场景触及 ⇒ priority 降一档；降到 low 之下则出队。
   *     「触及」= 该 topic 的 knowledge_items.last_practiced_vhours，或入队虚拟小时
   *     （后者对尚无 knowledge 行的 unseen 意图起算）。仅当 opts.virtualHours 提供
   *     （日终任务，§15.5）时执行——非日终的自省应用不触发降档。
   *   · Q3：上限 7，稳定排序后从尾部（low 优先）淘汰。
   */
  organizeLearningQueue(owner: string, proposed: LearningQueueItem[], opts?: { virtualHours?: number }): LearningQueueItem[] {
    const items = this.dao.listItems(owner);
    const mastery = new Map(items.map((i) => [i.topic, i.mastery]));
    const practiced = new Map(items.map((i) => [i.topic, i.lastPracticedVhours]));
    const misconceptions = new Set(items.filter((i) => i.isMisconception === 1).map((i) => i.topic));
    const nowHours = opts?.virtualHours;

    const byTopic = new Map<string, LearningQueueItem>();
    // 合并：topic 首次出现直接放；再次出现只在优先级更高时覆盖 priority/motivation，
    // enqueuedVhours 保留最早那一次（「入队」起算一次，不因反复重提而重置）。
    const merge = (item: LearningQueueItem): void => {
      const cur = byTopic.get(item.topic);
      if (!cur) {
        byTopic.set(item.topic, item);
        return;
      }
      if (PRIORITY_RANK[item.priority] > PRIORITY_RANK[cur.priority]) {
        byTopic.set(item.topic, { ...item, enqueuedVhours: cur.enqueuedVhours ?? item.enqueuedVhours });
      }
    };

    // Q4：误区自动入队。
    for (const topic of misconceptions) {
      merge({ topic, priority: "high", motivation: "我好像哪里没搞对", ...(nowHours !== undefined ? { enqueuedVhours: nowHours } : {}) });
    }
    // A34：继承上一轮队列（优先级较低的「待办」不因本轮模型省略而丢失）。
    for (const raw of this.dao.lastLearningQueue(owner)) {
      const topic = (raw?.topic ?? "").trim();
      if (!topic) continue;
      const priority: LearningQueueItem["priority"] =
        raw.priority === "high" || raw.priority === "medium" || raw.priority === "low" ? raw.priority : "medium";
      const motivation = typeof raw.motivation === "string" ? raw.motivation.slice(0, 200) : "";
      merge({
        topic,
        priority,
        motivation,
        ...(raw.enqueuedVhours !== undefined ? { enqueuedVhours: raw.enqueuedVhours } : {}),
      });
    }
    // 合并模型提议（同 topic 保留更高优先级；Q4 的 high 优先于模型的 medium/low）。
    for (const raw of proposed) {
      const topic = (raw?.topic ?? "").trim();
      if (!topic) continue;
      const priority: LearningQueueItem["priority"] =
        raw?.priority === "high" || raw?.priority === "medium" || raw?.priority === "low" ? raw.priority : "medium";
      const motivation = typeof raw?.motivation === "string" ? raw.motivation.slice(0, 200) : "";
      merge({ topic, priority, motivation, ...(nowHours !== undefined ? { enqueuedVhours: nowHours } : {}) });
    }
    // Q1：已掌握到 applied+ 且非误区（A33）的自动出队。
    for (const topic of byTopic.keys()) {
      const m = mastery.get(topic);
      if ((m === "applied" || m === "mastered") && !misconceptions.has(topic)) byTopic.delete(topic);
    }
    // Q2：连续 3 虚拟日未触及 ⇒ 降档 / 出队（仅日终）。
    if (nowHours !== undefined) {
      for (const [topic, item] of [...byTopic]) {
        const lastTouch = Math.max(item.enqueuedVhours ?? nowHours, practiced.get(topic) ?? Number.NEGATIVE_INFINITY);
        const untouchedDays = Math.floor((nowHours - lastTouch) / 24);
        if (untouchedDays < 3) continue;
        if (item.priority === "high") item.priority = "medium";
        else if (item.priority === "medium") item.priority = "low";
        else byTopic.delete(topic);
      }
    }
    // Q3：稳定排序（高优先在前），封顶 7，从尾部淘汰 low。
    return [...byTopic.values()]
      .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority])
      .slice(0, 7);
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────────

  /** 事件载荷（evidence 截断防御超长文本）。 */
  private event(
    knId: string, owner: string, from: Mastery | null, to: Mastery, kind: KnowledgeUpdateProposal["evidenceKind"],
    evidence: string | undefined, episodeId: string | null, virtualTs: string, virtualHours: number,
  ): KnowledgeEventWrite {
    return {
      evId: newId("ke"),
      knId,
      owner,
      from,
      to,
      kind,
      evidence: evidence ? evidence.slice(0, 400) : null,
      episodeId,
      virtualTs,
      virtualHours,
    };
  }

  /** 结算终态：mastery / confidence 限幅 / practice 计数 / 误区旗标 / wrong_belief 保留 / taught_by。 */
  private resolveFinalState(
    existing: ReturnType<KnowledgeDao["item"]>,
    p: KnowledgeUpdateProposal,
    to: Mastery,
    practiced: boolean,
    markMisconception: boolean,
  ): { to: Mastery; confidence: number; practiceCount: number; isMisconception: 0 | 1; wrongBelief: string | null; taughtBy: string } {
    const base = existing?.confidence ?? 0.5;
    const delta = clamp(p.confidenceDelta ?? 0, -CONFIDENCE_DELTA_CAP, CONFIDENCE_DELTA_CAP);
    const confidence = clamp(base + delta, 0, 1); // confidence 可自由调（§17.1.3），只限幅

    const practiceCount = (existing?.practiceCount ?? 0) + 1;

    // 误区（§17.4）：corrected/failed 默认置 1，显式 isMisconception:false 表「纠正已澄清」。
    let isMisconception: 0 | 1;
    if (markMisconception) {
      isMisconception = p.isMisconception === false ? 0 : 1;
    } else if (p.isMisconception !== undefined) {
      isMisconception = p.isMisconception ? 1 : 0;
    } else {
      isMisconception = existing?.isMisconception ?? 0;
    }

    // wrong_belief 纠正后不清空（§17.4.2）：无新值则保留原文，作为「我以前那样理解」的历史。
    const wrongBelief =
      p.wrongBelief !== undefined && p.wrongBelief !== ""
        ? p.wrongBelief.slice(0, 400)
        : (existing?.wrongBelief ?? null);

    // taught_by（§17.3）：迁移 / 纠错时由提议给出，默认 self；practice 保持原归因。
    const taughtBy = practiced && !markMisconception
      ? (existing?.taughtBy ?? "self")
      : this.resolveTaughtBy(p.taughtBy);

    return { to, confidence, practiceCount, isMisconception, wrongBelief, taughtBy };
  }

  /** taughtBy 归因解析：N1（无 <x>:reflect）+ N2（person 须为已知 Agent 或 npc:）。非法→self。 */
  private resolveTaughtBy(taughtBy: string | undefined): string {
    if (!taughtBy) return "self";
    try {
      const ref = parseSubjectRef(taughtBy);
      const unknown = unknownPersons([ref], this.knownAgents());
      if (unknown.length > 0) return "self"; // N2：解析不到的主体归因退回 self（归因非授权）
      return serializeSubjectRef(ref);
    } catch {
      return "self";
    }
  }

  private audit(
    owner: string, topic: string, verdictReason: string | null,
    existing: ReturnType<KnowledgeDao["item"]> | undefined | null,
    afterMastery: Mastery | null,
    source: KnowledgeApplySource,
  ): void {
    this.dao.stateWrite({
      ownerAgent: owner,
      targetId: topic,
      // §17.1.2 / §18.4.3：知识迁移的拒绝在 state_writes.reason 上统一记封闭取值域里的
      // `illegal_mastery_transition`（六种裁决原因只在 KnowledgeVerdict 里回给 Agent，不进审计）。
      reason: verdictReason ? "illegal_mastery_transition" : null,
      beforeJson: existing ? JSON.stringify({ mastery: existing.mastery, isMisconception: existing.isMisconception }) : "null",
      afterJson: afterMastery ? JSON.stringify({ mastery: afterMastery }) : "null",
      source: source.reflectionId ?? null,
    });
  }
}