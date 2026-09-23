// ═══════════════════════════════════════════════════════════════════════════
// 场景编曲器（P2 · §7）—— scenes.create/run/resume/close/get 的实现
//
// 一行 scenes = 一个 group Conversation（mesh 侧）+ 虚拟时钟 + 轮次 + 预算。
// 本文件是「把领域层粘到 mesh」的唯一地方（值经 MeshHost 触达，类型经 public-types）：
//   create() 写 scenes 行 → 建/复用 group 会话 → 按角色授权 caps（§3.3）
//   run()/resume() 驱动点名循环：点名 → 发 cue → 推进虚拟时钟 → 轮次/预算/abort 熔断
//   close()  收尾 status='ended'，不解散会话（一个会话可承载多周次，C10）
//
// 发言权（§3.7 末尾）：每轮把 SceneFloorState 经 FloorStateController.set() 注入
// floor 策略槽；策略槽在 mesh 投递事务内同步 get()。快照从不持久化（§13.2）。
//
// 分层纪律（§22.4）：不 import `@pi/agent-mesh`、不写 mesh_ SQL、不写领域层 dot
// 字面量（`ext` 只作为整值经 SendInput.ext 传出，策略槽/本目录不拆读）。
// ═══════════════════════════════════════════════════════════════════════════

import type { AccountId, Cap, ConversationId } from "../mesh/public-types.js";
import { ValidationError } from "../runtime/errors.js";
import { advanceVirtualTs } from "./clock.js";
import { buildCue, sendCue } from "./cue.js";
import { decodeParticipants } from "./scenes-dao.js";
import {
  buildRoleStateLookup,
  buildSceneFloorState,
  pickNextSpeaker,
} from "./state-snapshot.js";
import type {
  CueAudit,
  FloorMode,
  RoleStateLookup,
  SceneEstablished,
  SceneOrchestrator,
  SceneOrchestratorDeps,
  SceneOrchestratorFactory,
  SceneParticipant,
  SceneParticipantRole,
  SceneRow,
  SceneRunResult,
  SceneSpec,
} from "./types.js";

/** mesh 的 @system 账号（由 mesh 迁移种子，sink 类，initiate=["system"]，C16）。 */
const SYSTEM_ACCOUNT = "@system";

/** 虚拟时钟起点（§8.1）：缺省第 1 周周一上午 8 点。 */
const DEFAULT_VIRTUAL_START = "W1D1T8";

/** 每轮推进的虚拟分钟默认值（§8.2.1：60 分钟 = 1 虚拟小时，与虚拟时钟粒度一致）。 */
const DEFAULT_TURN_DURATION_MINUTES = 60;

/** 最近发言者的回溯窗口（与 mesh 的 lastSpeakers 窗口一致，§13）。 */
const LAST_SPEAKER_WINDOW = 5;

const SPEAK_READ: Cap[] = ["speak", "read"];
const READ_ONLY: Cap[] = ["read"];

// ─── 纯助手（不 import mesh、不碰 DB）──────────────────────────────────────

/** 角色 → caps（§3.3 caps 表：observer 只读，其余可发言）。 */
function capsFor(role: SceneParticipantRole): Cap[] {
  return role === "observer" ? READ_ONLY : SPEAK_READ;
}

/**
 * 会话创建者（moderator，拿 ALL_CAPS）：role='host' → 'teacher' → 首个可发言者 →
 * 首个参与者（兜底，理论上不出现——见 create 的校验）。
 */
function resolveModerator(participants: SceneParticipant[]): SceneParticipant {
  const first =
    participants.find((p) => p.role === "host") ??
    participants.find((p) => p.role === "teacher") ??
    participants.find((p) => p.role !== "observer") ??
    participants[0];
  if (!first) throw new ValidationError("scene requires at least one participant");
  return first;
}

/**
 * cue 发出者（SceneFloorState.host，floor 恒放行）：显式 hostAccountId → role='host'
 * 参与者 → deps.hostAccountId → @system。run/resume 无 spec.hostAccountId（未落库），
 * 取后两档。
 */
function resolveHost(
  participants: SceneParticipant[],
  specHost: AccountId | undefined,
  depsHost: AccountId | undefined,
): AccountId {
  if (specHost) return specHost;
  const hostRole = participants.find((p) => p.role === "host");
  if (hostRole) return hostRole.meshAccountId;
  if (depsHost) return depsHost;
  return SYSTEM_ACCOUNT;
}

/**
 * 有 speak 权的候选座次：moderator 居首（与 mesh 成员表插入序同源），其余按 spec 序，
 * 排除 observer。此序即 round_robin 轮转与 floor 策略槽共用的唯一座次。
 */
function speakerCandidates(
  participants: SceneParticipant[],
  moderator: SceneParticipant,
): AccountId[] {
  const ordered = [moderator, ...participants.filter((p) => p !== moderator)];
  return ordered.filter((p) => p.role !== "observer").map((p) => p.meshAccountId);
}

// ─── turn_policy 序列化（scenes.turn_policy 无独立列，maxTurns/turnDurationMinutes 折叠进 JSON）──

interface TurnPolicy {
  maxTurns?: number;
  turnDurationMinutes?: number;
}

function serializeTurnPolicy(maxTurns: number | undefined, turnDurationMinutes: number): string {
  return JSON.stringify({ maxTurns, turnDurationMinutes });
}

function parseTurnPolicy(json: string | null): TurnPolicy {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    return {
      maxTurns: typeof v.maxTurns === "number" ? v.maxTurns : undefined,
      turnDurationMinutes:
        typeof v.turnDurationMinutes === "number" ? v.turnDurationMinutes : undefined,
    };
  } catch {
    return {}; // 损坏的 turn_policy 视为未配置（宁可从宽，别让场景打不开）
  }
}

// ─── 点名选人（与 floor 策略槽同一套打分口径，§7.2）───────────────────────

/** reactive 模式：取 score 最高的未沉默者；tie-break 取座次靠前者（与 floor.ts 严格 `>` 一致）。 */
function topScoreAccount(
  candidates: readonly AccountId[],
  lookup: RoleStateLookup,
): AccountId | null {
  let best: AccountId | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const c of candidates) {
    const s = lookup.byAccount(c);
    const score = s
      ? s.turnsSinceLastSpoke + (s.wasAddressed ? 2 : 0) + s.arousal + s.engagement
      : 0;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function pickAddressee(
  floorMode: FloorMode | "free_for_all",
  candidates: readonly AccountId[],
  speakerOrder: readonly AccountId[],
  silenced: ReadonlySet<AccountId>,
  lookup: RoleStateLookup,
): AccountId | null {
  switch (floorMode) {
    case "round_robin":
    case "director": // director 的默认「脚本」= 轮转；director 靠 floor 只放行被点名者来约束
      return pickNextSpeaker(candidates, speakerOrder, silenced);
    case "reactive":
      return topScoreAccount(candidates, lookup);
    default:
      return null; // free_for_all：不点名，全员自由
  }
}

function cueAuditFor(floorMode: FloorMode | "free_for_all"): CueAudit {
  const reason =
    floorMode === "director"
      ? "director_script"
      : floorMode === "round_robin"
        ? "round_robin"
        : "reactive_score";
  return { reason, policyDegraded: false };
}

function cueText(sceneId: string, turn: number, virtualTs: string): string {
  return `【点名】${sceneId} 第 ${turn} 轮 · ${virtualTs}`;
}

// ─── 实现 ──────────────────────────────────────────────────────────────────

export const createSceneOrchestrator: SceneOrchestratorFactory = (deps: SceneOrchestratorDeps): SceneOrchestrator => {
  const { mesh, dao, floorState } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  async function queueCleared(): Promise<boolean> {
    const c = await mesh.observer.counters(["queue_cleared_detected"]);
    return (c["queue_cleared_detected"] ?? 0) > 0;
  }

  function establishedFromRow(row: SceneRow): SceneEstablished {
    if (!row.conversationId) {
      throw new ValidationError(`scene not bound to a conversation: ${row.sceneId}`);
    }
    return {
      sceneId: row.sceneId,
      conversationId: row.conversationId,
      participants: decodeParticipants(row.participantsJson),
      virtualStart: row.virtualStart ?? DEFAULT_VIRTUAL_START,
      floorMode: (row.floorMode as FloorMode) ?? "director",
    };
  }

  async function create(spec: SceneSpec): Promise<SceneEstablished> {
    // 幂等 by sceneId（§7.1）：已建档直接返回现况，不重建会话。
    const existing = dao.get(spec.sceneId);
    if (existing) return establishedFromRow(existing);

    const participants = spec.participants.map((p) => ({ ...p, caps: capsFor(p.role) }));
    if (participants.length === 0) {
      throw new ValidationError(`scene requires at least one participant: ${spec.sceneId}`);
    }

    const moderator = resolveModerator(participants);
    const floorMode = spec.floorMode ?? "director";
    const virtualStart = spec.virtualStart ?? DEFAULT_VIRTUAL_START;
    const createdAt = now();

    // 建 group 会话：creator = moderator（拿 ALL_CAPS），members = 全部参与者（含 observer）。
    // mesh 会去重 creator，故成员序 = [moderator, ...participants]（与 speakerCandidates 同源）。
    const conversation = await mesh.createConversation({
      type: "group",
      creator: moderator.meshAccountId,
      members: participants.map((p) => p.meshAccountId),
      topic: spec.name,
    });

    // observer 收窄为 read-only（§3.3）；by = moderator（creator 持 setCaps）。
    for (const p of participants) {
      if (p.role === "observer") {
        await mesh.setCaps(conversation.id, p.meshAccountId, READ_ONLY, moderator.meshAccountId);
      }
    }

    dao.insert({
      sceneId: spec.sceneId,
      name: spec.name ?? null,
      facilityId: spec.facilityId ?? null,
      facilityJson: spec.facilityJson !== undefined ? JSON.stringify(spec.facilityJson) : null,
      conversationId: conversation.id,
      floorMode,
      convBoundAt: createdAt,
      virtualStart,
      virtualNow: virtualStart,
      participants,
      turnPolicy: serializeTurnPolicy(spec.maxTurns, spec.turnDurationMinutes ?? DEFAULT_TURN_DURATION_MINUTES),
      tokenBudget: spec.tokenBudget ?? null,
      createdAt,
    });

    const row = dao.get(spec.sceneId);
    if (!row) throw new ValidationError(`scene insert failed: ${spec.sceneId}`);
    return establishedFromRow(row);
  }

  async function drive(sceneId: string, opts?: { signal?: AbortSignal; maxTurns?: number; tokenBudget?: number }): Promise<SceneRunResult> {
    const row = dao.get(sceneId);
    if (!row) throw new ValidationError(`scene not found: ${sceneId}`);
    if (row.status !== "active") {
      return { sceneId, stopReason: "closed", turnsCompleted: row.turnCount, queueClearedDetected: await queueCleared() };
    }
    const conversationId = row.conversationId;
    if (!conversationId) throw new ValidationError(`scene not bound to a conversation: ${sceneId}`);

    const participants = decodeParticipants(row.participantsJson);
    const policy = parseTurnPolicy(row.turnPolicy);
    const maxTurns = opts?.maxTurns ?? policy.maxTurns;
    const tokenBudget = opts?.tokenBudget ?? row.tokenBudget;
    const turnDurationMinutes = policy.turnDurationMinutes ?? DEFAULT_TURN_DURATION_MINUTES;
    const floorMode = (row.floorMode as FloorMode | undefined) ?? "director";
    const moderator = resolveModerator(participants);
    const cueFrom = resolveHost(participants, undefined, deps.hostAccountId);
    const candidates = speakerCandidates(participants, moderator);
    const deltaHours = turnDurationMinutes / 60;

    // 本轮账本（内存，§7.2 三条契约：只读快照、不 I/O、纯函数由 build* 承担；此处仅持状态）。
    const lastSpoke = new Map<AccountId, number>();
    let speakerOrder: AccountId[] = [];
    const silenced: ReadonlySet<AccountId> = new Set(); // P2 无沉默机制，恒空（§7.4 P3 落）

    let virtualNow = row.virtualNow ?? row.virtualStart ?? DEFAULT_VIRTUAL_START;
    let tokenSpent = row.tokenSpent;
    let completed = 0;
    let prevAddressee: AccountId | null = null;
    let lastAddressee: AccountId | null = null;
    let stopReason: SceneRunResult["stopReason"] = "idle";

    try {
      for (;;) {
        // ① abort（run/resume 也只在这一处响应 AbortSignal）
        if (opts?.signal?.aborted) {
          stopReason = "aborted";
          break;
        }
        // ② 轮次预算（§7.6：领域预算，mesh Limits 无此概念）
        if (maxTurns !== undefined && completed >= maxTurns) {
          stopReason = "max_turns";
          break;
        }
        // ③ token 预算熔断
        if (tokenBudget !== null && tokenSpent >= tokenBudget) {
          stopReason = "budget";
          break;
        }

        const turn = row.turnCount + completed + 1;
        const addressed = prevAddressee ? new Set<AccountId>([prevAddressee]) : new Set<AccountId>();
        const lookup = buildRoleStateLookup({
          sceneId,
          conversationId,
          turn,
          participants,
          lastSpoke,
          silenced,
          addressed,
        });

        // ④ 点名（free_for_all 不点名，只推进时钟）
        let addressee: AccountId | null = null;
        if (floorMode !== "free_for_all") {
          addressee = pickAddressee(floorMode, candidates, speakerOrder, silenced, lookup);
          if (addressee === null) {
            stopReason = "idle"; // 无可点名者（无 speak 候选）
            break;
          }
        }
        lastAddressee = addressee;

        // ⑤ 快照注入（cue 前）：floor 策略槽读它决定「这条消息的发送者能不能说话」。
        floorState.set(
          buildSceneFloorState({
            conversationId,
            floorMode,
            addressee,
            host: cueFrom,
            candidates,
            lastSpeakers: speakerOrder,
            lookup,
            silenced,
          }),
        );

        // ⑥ 发 cue（kind:"system" + expect:"reply"，§7.3）；记账。
        if (addressee !== null) {
          const cue = buildCue({
            conversationId,
            from: cueFrom,
            target: addressee,
            sceneId,
            turn,
            virtualTs: virtualNow,
            text: cueText(sceneId, turn, virtualNow),
            audit: cueAuditFor(floorMode),
          });
          await sendCue(mesh, {
            from: cueFrom,
            conversationId,
            to: addressee,
            text: cue.text,
            ext: cue.ext,
            logicalTs: virtualNow,
          });
          lastSpoke.set(addressee, turn);
          speakerOrder = [addressee, ...speakerOrder.filter((x) => x !== addressee)].slice(0, LAST_SPEAKER_WINDOW);
          prevAddressee = addressee;
        }

        floorState.clear();

        // ⑦ 推进虚拟时钟 + 落库（turn_count 递增；token 在 P2 无 LLM，恒 0 增量）。
        virtualNow = advanceVirtualTs(virtualNow, deltaHours);
        const adv = dao.advance(sceneId, virtualNow, 0);
        tokenSpent = adv.tokenSpent;
        completed += 1;

        // 让出事件循环，给 mesh 投递/回放派发余地（FakeStreamPort 同步回吐 entry）。
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      floorState.clear();
    }

    // abort 无损（I22）：把当前被点名者端点「delivered 未 consumed」回退 queued，绝不清队列。
    // 场景状态**保持 active**：signal abort 是宿主「干净停在轮次边界」，不是场景异常——§7.6 的
    // 'aborted' 状态留给 policy_degraded/participant unavailable 等真实异常（配 dissolve）。
    // 只有保持 active，resume 才能从 turn_count 无损续上（P2 验收「abort→resume 无损」）。
    if (stopReason === "aborted") {
      const target = lastAddressee ?? candidates[0];
      const endpointId = target ? deps.endpointOf?.(target) : undefined;
      if (endpointId) {
        try {
          await mesh.beforeClearQueue(endpointId);
        } catch {
          // 端点已 evict/不存在：忽略，无损不变量不受影响。
        }
      }
    }

    return { sceneId, stopReason, turnsCompleted: completed, queueClearedDetected: await queueCleared() };
  }

  async function close(sceneId: string): Promise<SceneRunResult> {
    const row = dao.get(sceneId);
    if (!row) throw new ValidationError(`scene not found: ${sceneId}`);
    const turnsCompleted = row.turnCount;
    if (row.status === "active") {
      dao.end(sceneId, "ended", now());
    }
    floorState.clear();
    return { sceneId, stopReason: "closed", turnsCompleted, queueClearedDetected: await queueCleared() };
  }

  const orchestrator: SceneOrchestrator = {
    create,
    run: (sceneId, opts) => drive(sceneId, opts),
    resume: (sceneId, opts) => drive(sceneId, opts),
    close,
    get: (sceneId) => dao.get(sceneId),
  };
  return orchestrator;
};