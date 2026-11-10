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
import type { UsageBreakdown } from "../mesh/pi-backend.js";
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
  SceneInvariantViolation,
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
 * cue 发出者（SceneFloorState.host 与 SendInput.from，floor 恒放行 host）。
 *
 * 权威 from 只能是**有能力发 system 的账号**（mesh gate ② 要求 kind ∈ from.initiate；
 * 普通角色 initiate 只有 chat/task/event，@system 才有 system）。故 cue 的发送身份：
 *   · 建档者显式声明的 hostAccountId（建档时是 spec.hostAccountId，run/resume 读落库的
 *     scenes.host_account_id —— A18 不再静默丢弃）；
 *   · 缺省退 deps.hostAccountId（宿主自有 system 账号）；
 *   · 再退 @system。
 *
 * 注意（A04）：不再把 role:'host' 参与者当 system 发送者——那会把普通角色推上 from，
 * mesh 以 CANNOT_INITIATE 拒绝合法 cue。role:'host' 只在 resolveModerator 里起
 * 「会话创建者（creator 拿 ALL_CAPS）」的作用，与 cue 发送身份解耦。
 */
function resolveHost(
  declaredHost: AccountId | undefined,
  depsHost: AccountId | undefined,
): AccountId {
  if (declaredHost) return declaredHost;
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
  const { mesh, dao, floorState, extRegistry, usageForTurn, usageTotalFor, onCost, dayEnd, invariantCheck } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  // A06（E03）：一轮收敛等待上限（真实时间）。发送成功 ≠ 一轮完成——等被点名者把 cue
  // consumed（turn_end）后才计发言/推进。等不到（迟回复/沉默/后端不可达）在超时后照常推进，
  // 迟到的 consumed 由 mesh 自身的投递/对账收敛，不在编曲器里补账。
  // R16（Q01）：同一上限也用作 close 的「收敛在途」有界等待——close 先停新 cue、等本场景
  // drive 循环退出（或超时降级），再解散群会话，绝不在 drive 还在发 cue 时 dissolve。
  const turnSettledMs = deps.turnSettledMs ?? 30000;

  // R16/Q01：本场景在途 drive 计数 + 等待者，供 close 有界等「收敛在途」。
  const driveCount = new Map<string, number>();
  const driveWaiters = new Map<string, Set<() => void>>();

  function enterDrive(sceneId: string): void {
    driveCount.set(sceneId, (driveCount.get(sceneId) ?? 0) + 1);
  }

  function exitDrive(sceneId: string): void {
    const n = (driveCount.get(sceneId) ?? 1) - 1;
    if (n <= 0) {
      driveCount.delete(sceneId);
      const ws = driveWaiters.get(sceneId);
      if (ws) {
        driveWaiters.delete(sceneId);
        for (const w of ws) w();
      }
    } else {
      driveCount.set(sceneId, n);
    }
  }

  /** 有界等「本场景没有任何在途 drive 循环」。true=已收敛，false=超时（调用方降级留痕）。 */
  function waitDriveConvergence(sceneId: string, timeoutMs: number): Promise<boolean> {
    if (!driveCount.has(sceneId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const ws = driveWaiters.get(sceneId) ?? new Set<() => void>();
      ws.add(() => finish(true));
      driveWaiters.set(sceneId, ws);
    });
  }

  async function queueCleared(): Promise<boolean> {
    const c = await mesh.observer.counters(["queue_cleared_detected"]);
    return (c["queue_cleared_detected"] ?? 0) > 0;
  }

  /**
   * A06：等「某账号消费了指定 cue」或超时 / abort。订阅 message_consumed，按 envelope.id +
   * accountId 精确关联（不按时间/顺序猜）。resolve 只保证「这一轮不再提前于 turn_end 推进」。
   */
  function waitForConsumption(
    accountId: AccountId,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsub: () => void = () => {};
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        unsub();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      timer = setTimeout(finish, turnSettledMs);
      unsub = mesh.on("message_consumed", (p) => {
        if (!settled && p.accountId === accountId && p.envelope.id === messageId) finish();
      });
      signal?.addEventListener("abort", finish, { once: true });
    });
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
    const hostAccountId = spec.hostAccountId ?? null;

    // A18：尊重 spec.conversationId（复用已有 group 而非始终新建），但一个会话恰绑定一个
    // 场景（ux_scenes_conversation）。已绑定另一场景时明确拒绝，不静默丢参数也不撞唯一索引。
    let conversationId: ConversationId;
    if (spec.conversationId) {
      const bound = dao.getByConversation(spec.conversationId);
      if (bound && bound.sceneId !== spec.sceneId) {
        throw new ValidationError(
          `conversation already bound to another scene: ${spec.conversationId} → ${bound.sceneId}`,
        );
      }
      conversationId = spec.conversationId;
      // 复用会话仍要落成员与 caps（memberCaps 缺省 speak/read，observer 收窄 read-only）。
      for (const p of participants) {
        await mesh.addMember(conversationId, p.meshAccountId, {
          caps: p.caps,
          by: moderator.meshAccountId,
        });
      }
    } else {
      // 建 group 会话：creator = moderator（拿 ALL_CAPS），members = 全部参与者（含 observer）。
      // mesh 会去重 creator，故成员序 = [moderator, ...participants]（与 speakerCandidates 同源）。
      const conversation = await mesh.createConversation({
        type: "group",
        creator: moderator.meshAccountId,
        members: participants.map((p) => p.meshAccountId),
        topic: spec.name,
      });
      conversationId = conversation.id;
    }

    // observer 收窄为 read-only（§3.3）；by = moderator（creator 持 setCaps）。
    for (const p of participants) {
      if (p.role === "observer") {
        await mesh.setCaps(conversationId, p.meshAccountId, READ_ONLY, moderator.meshAccountId);
      }
    }

    dao.insert({
      sceneId: spec.sceneId,
      name: spec.name ?? null,
      facilityId: spec.facilityId ?? null,
      facilityJson: spec.facilityJson !== undefined ? JSON.stringify(spec.facilityJson) : null,
      conversationId,
      hostAccountId,
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

    // A19：建档即把全员纳入账本（turn 0、虚拟起点），非场景账号仍 extFor→undefined。
    if (extRegistry) {
      for (const p of participants) {
        extRegistry.setExt(p.meshAccountId, { sceneId: spec.sceneId, turn: 0, virtualTs: virtualStart });
      }
    }

    return establishedFromRow(row);
  }

  async function drive(sceneId: string, opts?: { signal?: AbortSignal; maxTurns?: number; tokenBudget?: number }): Promise<SceneRunResult> {
    // R16/Q01：登记在途 drive，close 借此有界等「收敛在途」后再解散（见 exitDrive）。
    enterDrive(sceneId);
    try {
      return await driveOnce(sceneId, opts);
    } finally {
      exitDrive(sceneId);
    }
  }

  async function driveOnce(sceneId: string, opts?: { signal?: AbortSignal; maxTurns?: number; tokenBudget?: number }): Promise<SceneRunResult> {
    const row = dao.get(sceneId);
    if (!row) throw new ValidationError(`scene not found: ${sceneId}`);
    if (row.status !== "active") {
      return { sceneId, stopReason: "closed", turnsCompleted: row.turnCount, tokensThisRun: 0, tokensCumulative: row.tokenSpent, queueClearedDetected: await queueCleared(), dissolved: false, degradeTrace: [], invariantViolations: [] };
    }
    const conversationId = row.conversationId;
    if (!conversationId) throw new ValidationError(`scene not bound to a conversation: ${sceneId}`);

    const participants = decodeParticipants(row.participantsJson);
    const policy = parseTurnPolicy(row.turnPolicy);
    const maxTurns = opts?.maxTurns ?? policy.maxTurns;
    const turnDurationMinutes = policy.turnDurationMinutes ?? DEFAULT_TURN_DURATION_MINUTES;
    const floorMode = (row.floorMode as FloorMode | undefined) ?? "director";
    const moderator = resolveModerator(participants);
    const cueFrom = resolveHost(row.hostAccountId ?? undefined, deps.hostAccountId);
    const candidates = speakerCandidates(participants, moderator);
    const deltaMinutes = Math.round(turnDurationMinutes);

    // A07：真实用量基线（每 drive 重种子）。usageTotalFor 返回账号累计 usage（input/output/
    // totalTokens）；每轮被点名者推进前先记下当前累计做基线，轮末做差得本轮增量。首次 drive 时
    // 账号会话可能尚未 warm（mesh 在首条 cue 才 open），种子读到 0 恰是「尚无一 token」的真起点。
    const usageBaseline = new Map<AccountId, UsageBreakdown>();
    if (usageTotalFor) {
      for (const c of candidates) {
        const total = await usageTotalFor(c);
        usageBaseline.set(c, total);
      }
    }
    const readTurnUsage = async (addressee: AccountId, turn: number): Promise<UsageBreakdown> => {
      if (usageForTurn) {
        // usageForTurn 是测试/注入缝，只给本轮增量总额，无 input/output 拆分。
        const n = usageForTurn(sceneId, addressee, turn) ?? 0;
        return { tokensIn: 0, tokensOut: n, totalTokens: n };
      }
      if (!usageTotalFor) return { tokensIn: 0, tokensOut: 0, totalTokens: 0 };
      const total = await usageTotalFor(addressee);
      const last = usageBaseline.get(addressee);
      usageBaseline.set(addressee, total);
      if (last === undefined) return { tokensIn: 0, tokensOut: 0, totalTokens: 0 };
      return {
        tokensIn: Math.max(0, total.tokensIn - last.tokensIn),
        tokensOut: Math.max(0, total.tokensOut - last.tokensOut),
        totalTokens: Math.max(0, total.totalTokens - last.totalTokens),
      };
    };

    // 本轮账本（内存，§7.2 三条契约：只读快照、不 I/O、纯函数由 build* 承担；此处仅持状态）。
    const lastSpoke = new Map<AccountId, number>();
    let speakerOrder: AccountId[] = [];
    const silenced: ReadonlySet<AccountId> = new Set(); // P2 无沉默机制，恒空（§7.4 P3 落）

    let virtualNow = row.virtualNow ?? row.virtualStart ?? DEFAULT_VIRTUAL_START;
    let tokenSpent = row.tokenSpent; // 场景累计（持久，跨 run）
    let runSpent = 0; // 本次 run 增量（不持久，R13/E02：总限与本次上限分开）
    let completed = 0;
    let prevAddressee: AccountId | null = null;
    let stopReason: SceneRunResult["stopReason"] = "idle";

    // A19：resume/恢复入账（新建场景已由 create 里 seed）——先把全员归位到当前边界
    // （turn = 已累计轮数，virtualTs = 当前虚拟位置），随后每轮 cue 再刷新被点名者。
    if (extRegistry) {
      for (const p of participants) {
        extRegistry.setExt(p.meshAccountId, { sceneId, turn: row.turnCount, virtualTs: virtualNow });
      }
    }

    try {
      for (;;) {
        // ⓪ A08 关闭守卫：每轮重读状态，close 在途中标 ended/aborted 后不再发新 cue、
        //    不再推进。只看开头一次会漏掉并发 close（run 已持有 row 快照后仍继续发 cue）。
        const live = dao.get(sceneId);
        if (!live || live.status !== "active") {
          stopReason = "closed";
          break;
        }
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
        // ③ token 预算熔断：场景总限（累计）与本次 run 限（本轮增量）分开判（R13/E02）。
        //    `row.tokenBudget` 是建档的总限，`opts.tokenBudget` 是本次 run 临时收窄的上限。
        if (row.tokenBudget !== null && tokenSpent >= row.tokenBudget) {
          stopReason = "budget";
          break;
        }
        if (opts?.tokenBudget !== undefined && runSpent >= opts.tokenBudget) {
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

        // A19：每轮先把「场景当前位置（sceneId/turn/virtualTs）」对整个会场归位——ext 描述
        // 的是「何时」而非「谁」，free_for_all（无点名）与一轮内多个发送者都必须拿到本轮统一
        // 位置；被点名者的 mesh_send、旁观者被 cue 的 followUp 都会被 extProvider 补齐这三字段。
        if (extRegistry) {
          for (const p of participants) {
            extRegistry.setExt(p.meshAccountId, { sceneId, turn, virtualTs: virtualNow });
          }
        }

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
          const sent = await sendCue(mesh, {
            from: cueFrom,
            conversationId,
            to: addressee,
            text: cue.text,
            ext: cue.ext,
            logicalTs: virtualNow,
          });
          // A06：发送成功 ≠ 一轮完成——等被点名者 consumed 后才计发言/推进（迟交/沉默按
          // 超时照常推进，不提前把「送出」当「说过了」）。
          await waitForConsumption(addressee, sent.messageId, opts?.signal);
          lastSpoke.set(addressee, turn);
          speakerOrder = [addressee, ...speakerOrder.filter((x) => x !== addressee)].slice(0, LAST_SPEAKER_WINDOW);
          prevAddressee = addressee;
        }

        floorState.clear();

        // ⑦ 推进虚拟时钟 + 落库（turn_count 递增；token 增量来自本轮的 usageForTurn，A07——
        //    不再恒 0，预算熔断借真实用量生效；未注入 usage 源时退 0 保持 P2 无 LLM 语义）。
        virtualNow = advanceVirtualTs(virtualNow, deltaMinutes);
        const turnUsage: UsageBreakdown =
          addressee !== null ? await readTurnUsage(addressee, turn) : { tokensIn: 0, tokensOut: 0, totalTokens: 0 };
        const adv = dao.advance(sceneId, virtualNow, turnUsage.totalTokens);
        if (!adv.changed) {
          // A08：并发 close 已把它标为非 active，推进写 0 行生效——干净停在轮次边界。
          stopReason = "closed";
          break;
        }
        tokenSpent = adv.tokenSpent;
        runSpent += turnUsage.totalTokens;
        completed += 1;

        // onCost（§20.2 成本出口）：本轮完成真实推进即上抛一条 dialogue 记录；只报落库成功的
        // 轮次（并发 close 停在轮次边界不报）；tokensIn/tokensOut 来自 usageTotalFor 做差。
        if (onCost && addressee !== null && turnUsage.totalTokens > 0) {
          const speaker = participants.find((p) => p.meshAccountId === addressee);
          onCost({
            source: "dialogue",
            agentId: speaker?.agentId,
            sceneId,
            tokensIn: turnUsage.tokensIn,
            tokensOut: turnUsage.tokensOut,
            at: now(),
          });
        }

        // 让出事件循环，给 mesh 投递/回放派发余地（FakeStreamPort 同步回吐 entry）。
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      floorState.clear();
    }

    // abort（H04）：只停止新 cue，不默认取消正在生成的模型，也不回退/清队列。在途 submission
    // 由 mesh 按权威状态自然收敛。场景状态保持 active（signal abort 是宿主「干净停在轮次边界」，
    // 不是场景异常），resume 从 turn_count 无损续上。旧的 beforeClearQueue 协议已随 mesh v0.2.0
    // 移除（M04），此处不再重排队列，队列也从未被清空。
    return { sceneId, stopReason, turnsCompleted: completed, tokensThisRun: runSpent, tokensCumulative: tokenSpent, queueClearedDetected: await queueCleared(), dissolved: false, degradeTrace: [], invariantViolations: [] };
  }

  async function close(sceneId: string): Promise<SceneRunResult> {
    const row = dao.get(sceneId);
    if (!row) throw new ValidationError(`scene not found: ${sceneId}`);
    const turnsCompleted = row.turnCount;
    const degradeTrace: string[] = [];

    // Q01 阶段①：停止新发言（status→ended）。并发 drive 在下一轮 ⓪ 重读时停，不再发新 cue。
    if (row.status === "active") {
      dao.end(sceneId, "ended", now());
    }

    // Q01 阶段②：收敛在途（有界，E03 默认 30s）——等本场景 drive 循环退出，避免在它发 cue
    // 的时刻 dissolve；超时如实留痕，仍继续（不伪造「已收敛」）。
    const converged = await waitDriveConvergence(sceneId, turnSettledMs);
    if (!converged) degradeTrace.push(`converge in-flight timed out after ${turnSettledMs}ms`);

    // R16 阶段③：结束自省 / 日终（记忆衰减→自省/知识迁移→知识衰减→队列整理），幂等。
    const participants = decodeParticipants(row.participantsJson);
    if (dayEnd) {
      try {
        const day = await dayEnd({
          sceneId,
          agentIds: participants.map((p) => p.agentId),
          virtualTs: row.virtualNow ?? row.virtualStart ?? DEFAULT_VIRTUAL_START,
        });
        for (const r of day.ran) for (const d of r.degraded) degradeTrace.push(`${r.agentId}: ${d}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        degradeTrace.push(`day-end failed: ${msg}`);
      }
    }

    // R30/G4 devMode 关场校验：日终后跑一次 A1–A11（含 A2'）分区不变量；生产未注入则跳过。
    let invariantViolations: SceneInvariantViolation[] = [];
    if (invariantCheck) {
      try {
        invariantViolations = invariantCheck();
        for (const v of invariantViolations) {
          degradeTrace.push(`invariant ${v.id} (${v.assertion}) failed: ${v.count}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        degradeTrace.push(`invariant check failed: ${msg}`);
      }
    }

    // Q01 阶段④：解散群会话（一场景一群）。by = moderator（会话创建者，持 ALL_CAPS⊇dissolve）；
    // 复用已有 conversationId 的边界若 moderator 不是创建者、无 dissolve cap，则解散失败并留痕。
    let dissolved = false;
    if (row.conversationId) {
      try {
        const moderator = resolveModerator(participants);
        await mesh.dissolve(row.conversationId, moderator.meshAccountId);
        dissolved = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        degradeTrace.push(`dissolve failed: ${msg}`);
      }
    }

    // A19：close 归还「非场景事件」判定——把全员从账本移除，随后 extProvider 退 {}。
    if (extRegistry) {
      for (const p of participants) extRegistry.remove(p.meshAccountId);
    }
    floorState.clear();
    return {
      sceneId,
      stopReason: "closed",
      turnsCompleted,
      tokensThisRun: 0,
      tokensCumulative: row.tokenSpent,
      queueClearedDetected: await queueCleared(),
      dissolved,
      degradeTrace,
      invariantViolations,
    };
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