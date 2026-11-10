// ═══════════════════════════════════════════════════════════════════════════
// remember / recall 工具处理器（§12.3 / §14.5）—— 角色侧 6 个领域工具里记忆/注解的三个
//
// 处理器由 MemoryService 按 Account 装配（makeMemoryTools），闭包持有 owner 分区键与实时
// TurnState 入口。工具写读只经 MemoryDao（DB-A），不碰 mesh 侧写接口；错误走结构化 JSON
// （复用 mesh 既有码 ARG_INVALID / TOOL_DISABLED），不 throw（工具错误语义 §12.3）。
//
// 纪律：本文件不出现环境字段 `ext` 的点访问（R3）；不出现 mesh_ 表名（R2）；不 import @pi/agent-mesh（R1）。
// ═══════════════════════════════════════════════════════════════════════════

import type { MeshToolResult } from "../mesh/public-types.js";
import type { ToolExecute } from "../mesh/tools.js";
import type { EpisodeWrite, MemoryDao } from "./dao.js";
import { RECALL_QUOTA, WRITE } from "./constants.js";
import { normalizeAssignablePurpose, SALIENCE_FLOOR_BY_KIND, TEACHING_PROGRESS_DUP_WINDOW } from "./purpose.js";
import {
  makeRankedCardRenderer,
  rankCandidatesWithSubjects,
  selectCards,
  strongCueFilter,
  type RankedCandidate,
} from "./retrieve.js";
import { parseSubjectRefs, serializeSubjectRef, unknownPersons, type SubjectRef } from "./subject.js";
import type { TurnState } from "./turn.js";
import { newId } from "../runtime/id.js";
import { sha256Hex } from "../compile/fingerprint.js";

/** remember 写卡片的 confidence 来源（§15.3 失真裁剪只在 confidence<0.6 时标注不确定）。 */
const CONFIDENCE = {
  /** P1 直接在场（firsthand）。 */
  p1: 0.8,
  /** P2 未读摘要（summary view）。 */
  p2: 0.5,
  /** 兜底（无路径信息时）。 */
  fallback: 0.5,
} as const;

/** 工具闭包所需依赖。ownerAgent / knownAgents / dao 是装配期稳定值；currentTurn 是实时入口。 */
export interface MemoryToolDeps {
  dao: MemoryDao;
  /** 分区键 = agentId（不是 accountId）。 */
  ownerAgent: string;
  /** 当前 owner 的实时轮状态（无活动轮时 undefined）。 */
  currentTurn: () => TurnState | undefined;
  /** 已知 agent_id 全集（N2 未知 person 降权）。 */
  knownAgents: ReadonlySet<string>;
  /** 主体显示名解析（渲染卡片「关于」子句）。 */
  labelOf?: (ref: SubjectRef) => string;
  /** R31 内部健康保护：fail-closed 时返回 false，remember/note_self 拒写。缺省放行。 */
  writesAllowed?: () => boolean;
}

/** 结构化工具错误（§12.3 失败语义）；code 复用 mesh 既有码。 */
function toolError(code: "ARG_INVALID" | "TOOL_DISABLED", message: string): MeshToolResult {
  return { content: JSON.stringify({ error: { code, message } }) };
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function clampRecallLimit(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : RECALL_QUOTA.defaultCards;
  return Math.max(1, Math.min(RECALL_QUOTA.maxCards, n));
}

/** 把入选 ids 按 active / faded 拆分做强化（faded 走强线索复活，§15.2）。 */
function reinforceSelected(
  dao: MemoryDao,
  owner: string,
  ranked: RankedCandidate[],
  selectedIds: string[],
  includeFaded: boolean,
): void {
  const picked = new Set(selectedIds);
  const active: string[] = [];
  const faded: string[] = [];
  for (const r of ranked) {
    if (!picked.has(r.candidate.episodeId)) continue;
    if (r.candidate.status === "faded") faded.push(r.candidate.episodeId);
    else active.push(r.candidate.episodeId);
  }
  dao.reinforce(owner, active);
  if (includeFaded) dao.reviveStrongCue(owner, faded);
}

function makeRemember(deps: MemoryToolDeps): ToolExecute {
  return async (_toolCallId, params) => {
    const turn = deps.currentTurn();
    if (!turn) return toolError("TOOL_DISABLED", "当前没有进行中的轮次，无法写入记忆。");
    if (deps.writesAllowed && !deps.writesAllowed()) {
      return toolError("TOOL_DISABLED", "记忆写入已被健康哨兵阻断（invariant 违反 / accessControl 降级），等人工介入。");
    }
    await turn.ready;

    const gist = params.gist;
    if (typeof gist !== "string" || gist.trim().length === 0) {
      return toolError("ARG_INVALID", "gist 必填（一句话要点）。");
    }
    if (gist.length > 200) return toolError("ARG_INVALID", "gist 超长（≤200 字）。");

    // 通用用途（§17.6）：purpose 白名单内 → purposeKind；越界 → ARG_INVALID（不静默降级）。
    const purpose = normalizeAssignablePurpose(params.purpose);
    if (!purpose.ok) {
      return toolError("ARG_INVALID", "purpose 仅支持封闭白名单：teaching_progress（或省略）。");
    }
    const purposeKind = purpose.purposeKind;

    if (turn.writesThisTurn >= turn.policy.maxWritesPerTurn) {
      return toolError(
        "TOOL_DISABLED",
        `本轮记忆配额已用尽（maxWritesPerTurn=${turn.policy.maxWritesPerTurn}）。`,
      );
    }

    // 主体解析（N1 内部校验）+ N2 未知 person 降权（§12.3 / §16.1.2）。
    let subjects: SubjectRef[];
    try {
      subjects = parseSubjectRefs(stringArray(params.subjectRefs));
    } catch (e) {
      return toolError("ARG_INVALID", e instanceof Error ? e.message : "subjectRefs 非法。");
    }
    const unknown = new Set(unknownPersons(subjects, deps.knownAgents).map(serializeSubjectRef));

    const detail = typeof params.detail === "string" && params.detail.length > 0 ? params.detail : undefined;
    const quote = typeof params.quote === "string" && params.quote.length > 0 ? params.quote : undefined;

    // R22：emotion / valence / arousal 从工具参数保真落情节（§12.3 表；越界 → ARG_INVALID）。
    const emotion =
      typeof params.emotion === "string" && params.emotion.trim().length > 0 ? params.emotion.trim() : undefined;
    if (params.emotion !== undefined && (typeof params.emotion !== "string" || params.emotion.trim().length === 0)) {
      return toolError("ARG_INVALID", "emotion 非法（非空字符串，≤40 字）。");
    }
    if (emotion !== undefined && emotion.length > 40) return toolError("ARG_INVALID", "emotion 超长（≤40 字）。");

    const valence = typeof params.valence === "number" ? params.valence : undefined;
    if (params.valence !== undefined && (typeof params.valence !== "number" || params.valence < -1 || params.valence > 1)) {
      return toolError("ARG_INVALID", "valence 越界（-1..1）。");
    }
    const arousal = typeof params.arousal === "number" ? params.arousal : undefined;
    if (params.arousal !== undefined && (typeof params.arousal !== "number" || params.arousal < 0 || params.arousal > 1)) {
      return toolError("ARG_INVALID", "arousal 越界（0..1）。");
    }

    // 教学进度重复检测（§17.6）：与最近 5 条同用途情节的 knowledge 主体求交，命中 N 条则
    // 在 detail 末尾追加「（已重复 N 次）」。只呈现重复事实，不承诺模型绝不重复。
    let finalDetail = detail;
    if (purposeKind === "teaching_progress") {
      const knowledgeIds = subjects.filter((s) => s.type === "knowledge").map((s) => s.id);
      if (knowledgeIds.length > 0) {
        const recent = deps.dao.recentPurposeKnowledgeSubjects(
          deps.ownerAgent,
          "teaching_progress",
          TEACHING_PROGRESS_DUP_WINDOW,
        );
        const dupCount = recent.filter((r) => r.knowledgeIds.some((id) => knowledgeIds.includes(id))).length;
        if (dupCount > 0) {
          finalDetail = `${detail ?? ""}${detail ? " " : ""}（已重复 ${dupCount} 次）`;
        }
      }
    }

    // A30：P2 摘要唤醒只有 INBOX 摘要、看不到原文，不能产出「精确 quote」。
    // 拒绝而非降级存储——否则落库 quote 会被时间线误当 L1 引文证据（§18.6.4 / R36）。
    if (quote !== undefined && turn.path !== "P1") {
      return toolError("ARG_INVALID", "当前是摘要唤醒（P2），没有原文可摘录，不能写入 quote。");
    }

    // salience / owner / virtualTs / sourceMsgId / retention 由执行上下文注入（§12.3 表）。
    // 用途地板（§17.6）：教学进度等「高价值事件」系统抬高显著度；Math.max 保留 Agent 主观打高。
    let salience = turn.score?.salience ?? 0.5;
    const floor = purposeKind === null ? undefined : SALIENCE_FLOOR_BY_KIND[purposeKind];
    if (floor !== undefined) salience = Math.max(salience, floor);
    const write: EpisodeWrite = {
      episodeId: newId("ep"),
      ownerAgent: deps.ownerAgent,
      kind: "event",
      sceneId: turn.sceneId ?? null,
      purposeKind,
      sourceMsgId: turn.sourceMsgId ?? null,
      sourceSessionId: null,
      sourceEntryId: null,
      gist,
      detail: finalDetail ?? null,
      quote: quote ?? null,
      emotion: emotion ?? null,
      valence: valence ?? null,
      arousal: arousal ?? null,
      salience,
      confidence: turn.path === "P1" ? CONFIDENCE.p1 : turn.path === "P2" ? CONFIDENCE.p2 : CONFIDENCE.fallback,
      accuracy: null,
      virtualTs: turn.virtualTs,
      virtualHours: turn.virtualHours,
      retention: salience,
      status: "active",
      modelConfigHash: null,
      subjects: subjects.map((s) => {
        const key = serializeSubjectRef(s);
        return {
          ref: s,
          roleInEpisode: undefined,
          weight: unknown.has(key) ? WRITE.unknownSubjectWeight : undefined,
        };
      }),
    };

    deps.dao.insertEpisode(write);
    turn.writesThisTurn += 1;

    // 返回值极短：回显 gist 前 20 字，不回显 salience / episode_id（§12.3）。
    return { content: JSON.stringify({ ok: true, remembered: gist.slice(0, 20) }) };
  };
}

function makeRecall(deps: MemoryToolDeps): ToolExecute {
  return async (_toolCallId, params) => {
    const query = params.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      return toolError("ARG_INVALID", "query 必填（非空）。");
    }

    const turn = deps.currentTurn();
    if (!turn) {
      // count=0 是正常返回，不是错误（§14.5.4）。
      return { content: "", details: { count: 0, quotaRemaining: 0, note: "现在没有回想的需要。" } };
    }
    if (!turn.ledger.tryRecall()) {
      return {
        content: "",
        details: { count: 0, quotaRemaining: 0, note: "这一轮已经回想过两次了。" },
      };
    }
    await turn.ready;

    const trimmed = query.trim();
    const limit = clampRecallLimit(params.limit);
    const candidates = deps.dao.searchCandidates(deps.ownerAgent, trimmed, true);
    const subjectsByEpisode = deps.dao.subjectsOf(
      deps.ownerAgent,
      candidates.map((c) => c.episodeId),
    );
    const ranked = rankCandidatesWithSubjects(candidates, subjectsByEpisode, {
      nowHours: turn.virtualHours,
      tau0Hours: turn.policy.tau0Hours,
      presentSubjects: turn.presentSubjects,
    });
    const filtered = strongCueFilter(ranked, true).slice(0, limit);
    const render = makeRankedCardRenderer({ subjectsByEpisode, nowHours: turn.virtualHours, labelOf: deps.labelOf });
    const selected = selectCards(filtered, render, turn.ledger, true, RECALL_QUOTA.perCallTokenCap);

    // 回想是复述，强化被想起的记忆（§14.4；faded 走强线索复活）。
    reinforceSelected(deps.dao, deps.ownerAgent, filtered, selected.selectedIds, true);

    const cardsText = selected.cards.join("\n\n");

    // R25：显式 recall 留痕（含空结果）——记录查询、候选数、入选卡片与 token 账。
    // 与自动注入的 (owner_agent, trigger_msg_id) 幂等键分离：显式 recall 用 null，每次调用独立一行，
    // 空结果也落行（candidates/selected 可为 0），供成本/观测视图对账。
    deps.dao.insertRetrievalLog({
      ownerAgent: deps.ownerAgent,
      sceneId: turn.sceneId,
      turn: turn.turn,
      triggerMsgId: null,
      queryJson: JSON.stringify({ query: trimmed, channel: "recall" }),
      candidates: candidates.length,
      selectedJson: JSON.stringify(selected.selectedIds),
      tokensL2: 0,
      tokensL1: selected.tokens,
      tokensTransient: 0,
      tokensTotal: selected.tokens,
      clamped: selected.clamped,
      renderedCard: cardsText,
      cardSha256: sha256Hex(cardsText),
    });

    let note = selected.cards.length === 0 ? "关于这件事我想不起什么。" : "";
    if (selected.clamped > 0) note += (note ? " " : "") + "（还有一些相关的事，但想不清了）";
    const quotaRemaining = Math.max(0, RECALL_QUOTA.callsPerTurn - turn.ledger.callCount());

    return {
      content: cardsText,
      details: { count: selected.cards.length, quotaRemaining, note },
    };
  };
}

/** note_self 的固定 salience：刻意留给自己、不与他评混淆的自我注解（§12.3 表 / R08）。 */
const NOTE_SALIENCE = 0.6;
/** note_self 文本长度上限。 */
const NOTE_MAX_TEXT = 1000;

/**
 * note_self（R08）：给自己留一条不进对话的笔记——写一条 kind='self' 的 self 情节并计入
 * 本轮写配额（P3 账），**不把全文注回上下文**（返回值只给 { ok }，P3 语义：持久化但不进
 * LLM 上下文）。与 remember 的区别：固定 self 主体、无他评打分、不摘 quote。
 */
function makeNoteSelf(deps: MemoryToolDeps): ToolExecute {
  return async (_toolCallId, params) => {
    const turn = deps.currentTurn();
    if (!turn) return toolError("TOOL_DISABLED", "当前没有进行中的轮次，无法留笔记。");
    if (deps.writesAllowed && !deps.writesAllowed()) {
      return toolError("TOOL_DISABLED", "记忆写入已被健康哨兵阻断（invariant 违反 / accessControl 降级），等人工介入。");
    }
    await turn.ready;

    const text = params.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return toolError("ARG_INVALID", "text 必填（非空）。");
    }
    if (text.length > NOTE_MAX_TEXT) return toolError("ARG_INVALID", `text 超长（≤${NOTE_MAX_TEXT} 字）。`);

    if (turn.writesThisTurn >= turn.policy.maxWritesPerTurn) {
      return toolError(
        "TOOL_DISABLED",
        `本轮记忆配额已用尽（maxWritesPerTurn=${turn.policy.maxWritesPerTurn}）。`,
      );
    }

    const write: EpisodeWrite = {
      episodeId: newId("ep"),
      ownerAgent: deps.ownerAgent,
      kind: "self",
      sceneId: turn.sceneId ?? null,
      purposeKind: null,
      sourceMsgId: turn.sourceMsgId ?? null,
      sourceSessionId: null,
      sourceEntryId: null,
      gist: text.trim().slice(0, 200),
      detail: text.trim(),
      quote: null,
      emotion: null,
      valence: null,
      arousal: null,
      salience: NOTE_SALIENCE,
      confidence: CONFIDENCE.p1,
      accuracy: null,
      virtualTs: turn.virtualTs,
      virtualHours: turn.virtualHours,
      retention: NOTE_SALIENCE,
      status: "active",
      subjects: [{ ref: { type: "self", id: "self" } }],
    };

    deps.dao.insertEpisode(write);
    turn.writesThisTurn += 1;

    // 返回值极短：不把全文注回上下文（R08「不额外注入全文」）。
    return { content: JSON.stringify({ ok: true }) };
  };
}

/** 装配 role 侧 remember / recall / note_self 三个工具处理器（§12.3 / §14.5 / R08）。 */
export function makeMemoryTools(deps: MemoryToolDeps): {
  remember: ToolExecute;
  recall: ToolExecute;
  note_self: ToolExecute;
} {
  return { remember: makeRemember(deps), recall: makeRecall(deps), note_self: makeNoteSelf(deps) };
}