// ═══════════════════════════════════════════════════════════════════════════
// remember / recall 工具处理器（§12.3 / §14.5）—— 角色侧 6 个领域工具里记忆章的两个
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
    await turn.ready;

    const gist = params.gist;
    if (typeof gist !== "string" || gist.trim().length === 0) {
      return toolError("ARG_INVALID", "gist 必填（一句话要点）。");
    }
    if (gist.length > 200) return toolError("ARG_INVALID", "gist 超长（≤200 字）。");

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

    // salience / owner / virtualTs / sourceMsgId / retention 由执行上下文注入（§12.3 表）。
    const salience = turn.score?.salience ?? 0.5;
    const write: EpisodeWrite = {
      episodeId: newId("ep"),
      ownerAgent: deps.ownerAgent,
      kind: "event",
      sceneId: turn.sceneId ?? null,
      purposeKind: null,
      sourceMsgId: turn.sourceMsgId ?? null,
      sourceSessionId: null,
      sourceEntryId: null,
      gist,
      detail: detail ?? null,
      quote: quote ?? null,
      emotion: null,
      valence: null,
      arousal: null,
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
    let note = selected.cards.length === 0 ? "关于这件事我想不起什么。" : "";
    if (selected.clamped > 0) note += (note ? " " : "") + "（还有一些相关的事，但想不清了）";
    const quotaRemaining = Math.max(0, RECALL_QUOTA.callsPerTurn - turn.ledger.callCount());

    return {
      content: cardsText,
      details: { count: selected.cards.length, quotaRemaining, note },
    };
  };
}

/** 装配 role 侧 remember / recall 两个工具处理器（§12.3 / §14.5）。 */
export function makeMemoryTools(deps: MemoryToolDeps): { remember: ToolExecute; recall: ToolExecute } {
  return { remember: makeRemember(deps), recall: makeRecall(deps) };
}