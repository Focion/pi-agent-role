// ═══════════════════════════════════════════════════════════════════════════
// 轮级状态（§12.1 / §14）—— 一个 owner 一轮对话期间的可变状态
//
// MemoryService 在 `message_delivered{woke:true}` 起轮时创建 TurnState，供 remember / recall
// 工具与 context 钩子共享同一份账本与打分结果；`message_consumed` 时结算并清除。
// 独立小文件是为了断开 service ↔ tools 的循环 import（tools 需要类型，service 需要工具工厂）。
// ═══════════════════════════════════════════════════════════════════════════

import type { MemoryPolicy } from "../compile/types.js";
import { TurnRetrievalLedger } from "./retrieve.js";
import type { Score } from "./score.js";

/** 自动检索在起轮时算好、供 context 钩子注入/审计的缓存快照。 */
export interface StashedRetrieval {
  /** 已渲染好的卡片文本（每条一段 `<<<MEMORY … MEMORY>>>`）。 */
  cards: string[];
  /** 拼成块的卡片文本（context 钩子实际注入的内容）。 */
  cardsText: string;
  /** 入选卡片的 episode_id（强化用）。 */
  selectedIds: string[];
  /** 检索 query 的 JSON 原文（审计快照，§18.4.4）。 */
  queryJson: string;
  /** FTS 候选数。 */
  candidateCount: number;
  /** 入选卡片元信息的 JSON（审计快照）。 */
  selectedJson: string;
  /** 自动注入实际耗用的 L1 token。 */
  tokensL1: number;
  tokensTotal: number;
  /** 因预算被丢弃/截断的卡片数。 */
  clamped: number;
  /** 渲染卡片全文（审计快照，与 cardsText 同源）。 */
  renderedCard: string;
}

export interface TurnState {
  /** 接收方 accountId（mesh Account）。 */
  accountId: string;
  /** 分区键 = agentId。 */
  ownerAgent: string;
  policy: MemoryPolicy;
  /** 当前进上下文路径（决定 remember 的 confidence 与打分折扣）。 */
  path: "P1" | "P2" | "P3";
  virtualTs: string;
  virtualHours: number;
  sceneId?: string;
  /** 场景虚拟轮次号（来自 roleExt 的 turn 字段）。 */
  turn?: number;
  /** 触发本轮的消息 id（remember 的 source_msg_id 与检索 trigger_msg_id）。 */
  sourceMsgId?: string;
  /** 接收方记忆判定结果（起轮时算好；remember 用其 salience）。 */
  score?: Score;
  ledger: TurnRetrievalLedger;
  /** 当前在场主体 id 集合（person:agent_id / facility:id）。 */
  presentSubjects: ReadonlySet<string>;
  /** 本轮已写入的情节记忆条数（maxWritesPerTurn 计数）。 */
  writesThisTurn: number;
  /** 自动检索缓存（起轮时算好，context 钩子消费；无卡时仍可能为 undefined）。 */
  retrieval?: StashedRetrieval;
  /** 策略 + 打分 + 检索已就绪（异步初始化完成）的信号，消费方须 `await` 再读字段。 */
  ready: Promise<void>;
}

export interface TurnStateInit {
  accountId: string;
  ownerAgent: string;
  policy: MemoryPolicy;
  path: "P1" | "P2" | "P3";
  virtualTs: string;
  virtualHours: number;
  sceneId?: string;
  turn?: number;
  sourceMsgId?: string;
  presentSubjects?: ReadonlySet<string>;
}

export function freshTurnState(init: TurnStateInit): TurnState {
  return {
    accountId: init.accountId,
    ownerAgent: init.ownerAgent,
    policy: init.policy,
    path: init.path,
    virtualTs: init.virtualTs,
    virtualHours: init.virtualHours,
    sceneId: init.sceneId,
    turn: init.turn,
    sourceMsgId: init.sourceMsgId,
    presentSubjects: init.presentSubjects ?? new Set<string>(),
    ledger: new TurnRetrievalLedger(),
    writesThisTurn: 0,
    ready: Promise.resolve(),
  };
}