// ═══════════════════════════════════════════════════════════════════════════
// 发言权瞬时快照（§7.2）——把 scenes 行 + 每账号账本变成策略槽只读内存视图
//
// 编曲器每轮 cue 前调用 build*，产出 RoleStateLookup + SceneFloorState，经
// FloorStateController 注入 floor 策略槽。三条契约（§7.2）：同步返回、只读
// 内存快照不 I/O、纯函数（账本由编曲器持有并传入，本模块不持状态）。
//
// P2 打分中性：arousal/engagement 取 0.5（P3 接 agent_state）；唯一真实信号是
// turnsSinceLastSpoke（距上次发言轮数）与 wasAddressed（是否本轮被点名）。
//
// 分层纪律：不 import `@pi/agent-mesh`、不对领域层 `ext` 做成员访问、不写 mesh_ SQL。
// ═══════════════════════════════════════════════════════════════════════════

import type { AccountId, ConversationId } from "../mesh/public-types.js";
import type {
  FloorMode,
  RoleStateLookup,
  RoleTurnState,
  SceneFloorState,
  SceneParticipant,
} from "./types.js";

/** 编曲器持有的每账号账本（内存，不落库；崩溃后恢复重排）。 */
export interface TurnBookkeeping {
  /** accountId → 上次发言轮次（未发言则无此键）。 */
  lastSpoke: ReadonlyMap<AccountId, number>;
  /** 本轮应沉默者。 */
  silenced: ReadonlySet<AccountId>;
}

/**
 * 由场景行 + 账本构建 RoleStateLookup。`addressed` = 本轮被点名的账号集合
 * （cue 的 to 集 ∪ mentions）。
 */
export function buildRoleStateLookup(opts: {
  sceneId: string;
  conversationId: ConversationId;
  turn: number;
  participants: SceneParticipant[];
  lastSpoke: ReadonlyMap<AccountId, number>;
  silenced: ReadonlySet<AccountId>;
  addressed: ReadonlySet<AccountId>;
}): RoleStateLookup {
  const byAccount = new Map<AccountId, RoleTurnState>();
  for (const p of opts.participants) {
    const acct = p.meshAccountId;
    const last = opts.lastSpoke.get(acct);
    byAccount.set(acct, {
      agentId: p.agentId,
      sceneId: opts.sceneId,
      arousal: 0.5, // P2 中性；P3 接 agent_state
      engagement: 0.5,
      turnsSinceLastSpoke: last === undefined ? opts.turn : opts.turn - last,
      wasAddressed: opts.addressed.has(acct),
      silencedUntilTurn: opts.silenced.has(acct) ? opts.turn : null,
    });
  }

  return {
    byAccount(accountId: AccountId): RoleTurnState | undefined {
      return byAccount.get(accountId);
    },
    byAccounts(accountIds: readonly AccountId[]): Map<AccountId, RoleTurnState> {
      const out = new Map<AccountId, RoleTurnState>();
      for (const id of accountIds) {
        const s = byAccount.get(id);
        if (s) out.set(id, s);
      }
      return out;
    },
    sceneOfConversation(): { sceneId: string; sceneTurn: number } {
      return { sceneId: opts.sceneId, sceneTurn: opts.turn };
    },
  };
}

/** 组装 SceneFloorState（纯数据结构；round_robin/reactive 的选人在 pickNextSpeaker）。 */
export function buildSceneFloorState(opts: {
  conversationId: ConversationId;
  floorMode: FloorMode | "free_for_all";
  addressee: AccountId | null;
  host: AccountId | null;
  candidates: AccountId[];
  lastSpeakers: AccountId[];
  lookup: RoleStateLookup;
  silenced: ReadonlySet<AccountId>;
}): SceneFloorState {
  return {
    conversationId: opts.conversationId,
    floorMode: opts.floorMode,
    addressee: opts.addressee,
    host: opts.host,
    candidates: opts.candidates,
    lastSpeakers: opts.lastSpeakers,
    lookup: opts.lookup,
    silenced: opts.silenced,
  };
}

/**
 * round_robin 选下一个发言者：按座次在 `lastSpeakers[0]` 之后取下一个未沉默者
 * （老师常驻 = 成人候选一律在候选集内，不因沉默出列）。无候选返回 null。
 */
export function pickNextSpeaker(
  candidates: readonly AccountId[],
  lastSpeakers: readonly AccountId[],
  silenced: ReadonlySet<AccountId>,
): AccountId | null {
  const eligible = candidates.filter((c) => !silenced.has(c));
  if (eligible.length === 0) return null;
  const last = lastSpeakers[0];
  if (last === undefined) return eligible[0] ?? null;
  const idx = eligible.indexOf(last);
  return idx < 0 ? (eligible[0] ?? null) : (eligible[(idx + 1) % eligible.length] ?? eligible[0] ?? null);
}