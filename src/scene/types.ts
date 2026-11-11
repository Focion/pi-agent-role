// ═══════════════════════════════════════════════════════════════════════════
// 场景领域类型（§7 / §8 / §18.3）——纯类型 + 常数，无行为
//
// 场景 = 一个 group Conversation（mesh 侧）+ 一行 scenes（本环侧），由
// scenes.conversation_id 关联，边界不同（§3.3）：
//   · 会话是 mesh 的边界（成员、caps、Floor）；场景是本环的边界（虚拟时间、轮次、预算）。
//   · 场景结束 ≠ 会话解散：一个会话可承载多行 scenes（不同周次），故 sceneId 不编进 conversationId（C10）。
//
// 分层纪律（§22.4 #4）：本目录不 import `@pi/agent-mesh`；mesh 类型经
// ../mesh/public-types.js（纯 type 再出口），mesh 值（MeshHost/Observer）由 runtime
// 注入。领域层 role.* 字段由 `../mesh/ext-role.js` 的 RoleExt 承载，此处只引用类型。
// ═══════════════════════════════════════════════════════════════════════════

import type { AccountId, Cap, ConversationId, MeshHost } from "../mesh/public-types.js";
import type { RoleExt } from "../mesh/ext-role.js";
import type { UsageBreakdown } from "../mesh/pi-backend.js";
import type { CostRecord } from "../runtime/types.js";
import type { SceneExtRegistry } from "./ext-registry.js";

/** 场景状态机（§7.5 四段 + aborted + paused）。DB 缺省 'active' = 运行中。 */
export type SceneStatus = "active" | "paused" | "ended" | "aborted";

/** 参与者在场景内的领域角色（§3.3 表 + §7.1）。旁听/观察者只有 read、无 speak。 */
export type SceneParticipantRole = "host" | "teacher" | "student" | "facility" | "observer";

/**
 * 场景参与者（scenes.participants_json 的一项）。`meshAccountId` 是**建场景那一刻**
 * 的映射快照（§18.3.1 末）；成员/caps 的权威在 mesh 成员表，这里只冗余只读。
 */
export interface SceneParticipant {
  agentId: string;
  role: SceneParticipantRole;
  meshAccountId: AccountId;
  /** 建会话时授予的 caps；冗余快照，冲突以 mesh 成员表为准。 */
  caps?: Cap[];
}

/** 发言权模式（scenes.floor_mode / §7.2）。mesh 内建只有 free_for_all，其余本环实现。 */
export type FloorMode = "free_for_all" | "round_robin" | "director" | "reactive";

/**
 * 导演剧本的一步（O02）：按顺序点名。`target` 是场景参与者的 agentId 或领域角色名
 * （角色名匹配第一个该角色参与者，顺序无关——「叫第一个学生」这类条件）。
 */
export interface DirectorStep {
  /** 点名目标：agentId 或角色名（host/teacher/student/facility/observer）。 */
  target: string;
  /** 本条点名的 cue 正文；缺省用编曲器默认「【点名】…」。 */
  text?: string;
}

/**
 * 完整导演剧本（O02）：显式有序脚本，替代 director 模式的默认轮转。
 *   顺序 = steps 依序执行；条件 = target 可角色名解析 + 逐步资格校验（observer/缺失 skip）；
 *   恢复位置 = 绝对轮次（turn_count）对 steps 取模/截断，resume 从停点无损续上；
 *   失败边界 = 建场景时校验每个 target 可解析到非 observer 参与者（否则 ValidationError），
 *   非 loop 播完 → stopReason="idle"。
 */
export interface DirectorScript {
  steps: DirectorStep[];
  /** 播完回绕（缺省 false：播完即 idle）。 */
  loop?: boolean;
}

/** scenes 表一行（§18.3 DDL）。participants 反序列化后是 SceneParticipant[]。 */
export interface SceneRow {
  sceneId: string;
  name: string | null;
  facilityId: string | null;
  facilityJson: string | null;
  conversationId: string | null;
  /** cue 发送账号（建档者声明的 hostAccountId，缺省 NULL = 退 deps / @system，§7.3）。 */
  hostAccountId: string | null;
  floorMode: string | null;
  convBoundAt: string | null;
  virtualStart: string | null;
  virtualNow: string | null;
  participantsJson: string;
  turnPolicy: string | null;
  turnCount: number;
  tokenBudget: number | null;
  tokenSpent: number;
  status: SceneStatus;
  createdAt: string;
  endedAt: string | null;
}

/** scenes.create() 入参。注册参数由调用方给出，但每个 participant 的 caps 按角色推导（§3.3 caps 表）。 */
export interface SceneSpec {
  sceneId: string;
  name?: string;
  participants: SceneParticipant[];
  /** 建档者 / cue 发出者的账号（@system 或场景主持）。本环以宿主身份发 cue，from 必须是它。
   *  缺省取 participants 里 role 为 host 者的 meshAccountId，再缺省取 deps.hostAccountId。 */
  hostAccountId?: AccountId;
  /** 复用已有 group 会话；缺省由介编 createConversation 新建。 */
  conversationId?: ConversationId;
  /** 虚拟起点，形如 W3D1T14（§8.1）。缺省取 root 时钟起点。 */
  virtualStart?: string;
  /** 每轮推进的虚拟分钟数（§8.2.1 配置，E01 起整分钟）。默认 60（= 1 虚拟小时）。 */
  turnDurationMinutes?: number;
  /** 发言权模式。默认 'director'（只有被点名者能说，§7.2 表）。 */
  floorMode?: FloorMode;
  /** director 模式的完整剧本（O02）；缺省则 director 退化为基础轮转。 */
  script?: DirectorScript;
  /** 场景轮次预算（领域预算，mesh Limits 无此概念，§7.6）。超限熔断。 */
  maxTurns?: number;
  /** 场景 token 预算（§7.6）。 */
  tokenBudget?: number;
  facilityId?: string;
  facilityJson?: unknown;
}

/** 场景运行结果（§P2 验收 7：abort 无损、stopReason 精确）。 */
export interface SceneRunResult {
  sceneId: string;
  stopReason: "max_turns" | "budget" | "aborted" | "closed" | "paused" | "idle";
  turnsCompleted: number;
  /** 本次 run 消耗的 token（不持久；run 临时收窄上限据此判定，R13/E02）。 */
  tokensThisRun: number;
  /** 场景累计 token（持久于 scenes.token_spent，跨 run 累加）。 */
  tokensCumulative: number;
  /** H04/M04：abort 不再清队列也不回退，此计数恒为 false（moderator 从未触发 queue_cleared）。 */
  queueClearedDetected: boolean;
  /**
   * Q01/R16：close 是否已完成「收敛在途 → 解散群会话」的末段。run/resume（非 close 路径）
   * 恒为 false——只有 close 走解散，abort/预算/轮次熔断都保持会话不解散（场景仍在）。
   */
  dissolved: boolean;
  /**
   * R16 降级留痕：收敛超时 / 解散失败 / 日终降级等，逐条记录真实原因；空数组 = 无降级。
   * 绝不把失败吞成成功，也不在未真正解散时宣称 dissolved=true。
   */
  degradeTrace: string[];
  /**
   * R30/G4 devMode 关场校验：close 在日终后跑一次 A1–A11（含 A2'）分区不变量，
   * 逐条记录违例（id/assertion/count）；空数组 = 无违例（本次自检全绿）。
   * run/resume/abort 非 close 路径恒为空数组——只有 close 走关场自检。
   */
  invariantViolations: SceneInvariantViolation[];
}

/** R30/G4 devMode 关场校验的一条违例（对应 invariant-sql 的 RoleInvariantReport.violations[]）。 */
export interface SceneInvariantViolation {
  id: string;
  assertion: string;
  count: number;
}

/** 点名动作的发起原因（§7.3 领域层 role.cue.reason）。 */
export type CueReason = "reactive_score" | "round_robin" | "director_script";

/** 一条 cue 消息的完整意图层（缺 from——由 orchestrator 闭包补）。 */
export interface CueMessage {
  conversationId: ConversationId;
  kind: "system";
  expect: "reply";
  to: AccountId[];
  text: string;
  /** 领域层：sceneId/turn/virtualTs/cue 全部写进 RoleExt（§7.3 四字段表）。 */
  ext: RoleExt;
}

/** 点名元信息（领域层 role.cue，仅审计读，库不读，§21.1）。 */
export interface CueAudit {
  reason: CueReason;
  score?: number;
  runnerUp?: Array<{ accountId: AccountId; score: number }>;
  policyDegraded: boolean;
}

// ─── 发言权打分（§7.2 反查器 + 瞬时状态）──────────────────────────────────

/**
 * 场景内一个角色的瞬时状态。字段全部由本环 agent_state / scenes 快照提供，与 mesh 无关。
 * 策略槽不得读 ext，也不得执行 SQL（mesh §12.3 三条契约）——它读的是这份**内存快照**。
 */
export interface RoleTurnState {
  agentId: string;
  /** 该 accountId 当前所在场景 id；不在任何场景内为 null。 */
  sceneId: string | null;
  /** [0,1] 唤起度（P3 接 agent_state；P2 中性 0.5）。 */
  arousal: number;
  /** [0,1] 参与度（P2 中性 0.5）。 */
  engagement: number;
  /** 本场景内距上次发言的轮数；从未发言取 sceneTurn。 */
  turnsSinceLastSpoke: number;
  /** 上一条消息的 to ∪ mentions 是否含我。 */
  wasAddressed: boolean;
  /** 沉默权：该轮之前不参与打分（§7.4）。 */
  silencedUntilTurn: number | null;
}

/**
 * 反查器：本环注入给自实现 floor/activation 策略槽的**唯一数据入口**（§7.2）。
 * 三条硬约束：同步返回、只读内存快照不得 I/O、纯函数（快照版本号进回放）。
 */
export interface RoleStateLookup {
  byAccount(accountId: AccountId): RoleTurnState | undefined;
  byAccounts(accountIds: readonly AccountId[]): Map<AccountId, RoleTurnState>;
  sceneOfConversation(conversationId: ConversationId): { sceneId: string; sceneTurn: number } | undefined;
}

// ─── 发言权快照（注入 floor/activation 的共享可变状态，§3.7 末尾）───────────

/**
 * 每轮由编曲器在 cue 前刷新的只读快照。策略槽（floor）**不得读 envelope.ext**，
 * 一律从这里读发言权判决。快照是内存对象，从不持久化（§13.2）。
 */
export interface SceneFloorState {
  /** 本场景绑定的 group 会话；floor 只对该会话生效（非本场景走 free_for_all）。 */
  conversationId: ConversationId | null;
  /** scenes.floor_mode 派生；fallback free_for_all。 */
  floorMode: FloorMode | "free_for_all";
  /** 本轮点名者（director 只给它发言权）。 */
  addressee: AccountId | null;
  /** 主持人（cue 的 from）；grantFloor 恒放行主持人，否则 director 模式连 cue 都发不出。 */
  host: AccountId | null;
  /** 本轮有 speak 权的候选（按座次）。 */
  candidates: AccountId[];
  /** 上一轮真正发言者（round_robin 轮转起点）。 */
  lastSpeakers: AccountId[];
  /** 场景内瞬时状态反查器。 */
  lookup: RoleStateLookup;
  /** 本轮被沉默者（silencedUntilTurn ≥ 当前轮）；floor 排除之。 */
  silenced: ReadonlySet<AccountId>;
}

/** 编曲器持有，策略槽经闭包读同一对象；`clear()` 归还 free_for_all。 */
export interface FloorStateController {
  set(state: SceneFloorState): void;
  get(): SceneFloorState | null;
  clear(): void;
}

// ─── 编曲器契约（scene/orchestrator.ts 实现；runtime/scenes.ts 面向它）────────

/** run/resume 的运行时覆盖（预算/轮次上限；场景建档时的预算可被临时收窄）。 */
export interface RunOptions {
  signal?: AbortSignal;
  maxTurns?: number;
  tokenBudget?: number;
}

/**
 * 日终编排的回调（R16/Q02）。scene 目录不 import reflect，运行时把 DayEndService 的一
 * 次片段闭包成这个最小形状注入；close 在「收敛在途」之后、「解散」之前调用它。
 */
export type DayEndRunner = (opts: {
  sceneId: string;
  agentIds: string[];
  virtualTs: string;
}) => Promise<{
  virtualDay: number;
  ran: Array<{ agentId: string; depth: string; alreadyDone: boolean; degraded: string[] }>;
}>;

/** scenes.create() 建档成功后的句柄。 */
export interface SceneEstablished {
  sceneId: string;
  conversationId: ConversationId;
  participants: SceneParticipant[];
  virtualStart: string;
  floorMode: FloorMode;
}

/**
 * 场景注入（O05）：宿主往运行中的场景注入一条旁白/事件消息（kind:"system" +
 * msgClass:"narration"）的审计 + 幂等记录。injectId 是客户端幂等键——重试/崩溃恢复
 * 按它去重，不重复发消息。
 */
export interface SceneInjectionInput {
  sceneId: string;
  /** 客户端幂等键；同键重试幂等返回原注入。 */
  injectId: string;
  /** 旁白正文。 */
  text: string;
  /** 归属账号：必须是被授权发 system 的 host（缺省退场景 host / deps.host / @system）。 */
  from?: AccountId;
}

/** scene_injections 表投影。 */
export interface SceneInjection {
  injectId: string;
  sceneId: string;
  conversationId: string;
  messageId: string;
  fromAccount: AccountId;
  msgClass: string;
  text: string;
  virtualTs: string | null;
  createdAt: string;
}

/**
 * 场景编曲器（P2 · §7）。runtime 门面把「agentId/角色」解析成 meshAccountId 后，
 * 交给本接口的 create()；run/resume 驱动点名循环直到预算/超时/abort。
 */
export interface SceneOrchestrator {
  /** 建档 + 入会（§7.1）：写 scenes 行 → 建/复用 group 会话 → addMember 设 caps。幂等 by sceneId。 */
  create(spec: SceneSpec): Promise<SceneEstablished>;
  /** 跑一轮（§7.5）：点名 → 发 cue → 推进虚拟时钟 → 预算熔断；abort（H04）只停新 cue。 */
  run(sceneId: string, opts?: RunOptions): Promise<SceneRunResult>;
  /** 恢复一个仍在 active/paused 的场景接着跑（读 scenes 行，不重建会话成员）。 */
  resume(sceneId: string, opts?: RunOptions): Promise<SceneRunResult>;
  /** 暂停（O04）：status→'paused'，持久化；不解散会话、不跑日终；resume 从停点无损续上。 */
  pause(sceneId: string): Promise<SceneRunResult>;
  /** 注入（O05）：往运行中场景发一条旁白（narration），授权/归属/审计/幂等恢复。 */
  inject(input: SceneInjectionInput): Promise<SceneInjection>;
  /** 收尾（§7.5）：status='ended'，落 ended_at，不解散会话（一个会话可乘多周次）。 */
  close(sceneId: string): Promise<SceneRunResult>;
  /** 读当前行（host 自检 / resume 前判断）。 */
  get(sceneId: string): SceneRow | undefined;
}

// ─── 场景行新建入参 + 存储接口（DAO 实现；编曲器依赖接口不依赖实现）────────────

/** scenes 表新建行的结构化入参；participants 由 DAO 序列化为 participants_json。 */
export interface NewSceneInput {
  sceneId: string;
  name: string | null;
  facilityId: string | null;
  facilityJson: string | null;
  conversationId: string | null;
  /** cue 发送账号；未声明时 build 层落在 NULL（退 deps.host_account_id / @system）。 */
  hostAccountId?: AccountId | null;
  floorMode: string | null;
  convBoundAt: string | null;
  virtualStart: string | null;
  virtualNow: string | null;
  participants: SceneParticipant[];
  turnPolicy: string | null;
  tokenBudget: number | null;
  createdAt: string;
}

/** 编曲器看到的 scenes 存储接口；scenes-dao.ts 的 ScenesDao 结构化满足它。 */
export interface SceneStore {
  insert(inp: NewSceneInput): void;
  get(sceneId: string): SceneRow | undefined;
  getByConversation(conversationId: ConversationId): SceneRow | undefined;
  advance(sceneId: string, virtualNow: string, deltaTokens: number): { turnCount: number; tokenSpent: number; changed: boolean };
  end(sceneId: string, status: Extract<SceneStatus, "ended" | "aborted">, endedAt: string): void;
  /** 暂停：active→paused；返回是否确实发生翻转（已 ended/aborted/paused 或不存在则 false）。 */
  pause(sceneId: string): boolean;
  /** 恢复：paused→active；返回是否确实发生翻转。 */
  unpause(sceneId: string): boolean;
  /** 记一笔注入（幂等键 injectId）。 */
  recordInjection(inj: SceneInjection): void;
  /** 按幂等键回读注入（不存在返回 undefined）。 */
  getInjection(injectId: string): SceneInjection | undefined;
  listActive(): SceneRow[];
}

/** scene/orchestrator.ts 的装配依赖：mesh 值在 runtime 层归拢后注入。 */
export interface SceneOrchestratorDeps {
  mesh: MeshHost;
  dao: SceneStore;
  floorState: FloorStateController;
  /** 点名（cue）的 from 账号后备；per-scene 真值 = participants 里 role:'host' 者（§7.3）。 */
  hostAccountId?: AccountId;
  /** 场景位置账本（A19）：cue 前写被点名者所在场景/轮次/虚拟时间，供 extProvider 读。 */
  extRegistry?: SceneExtRegistry;
  /** 本轮实际生成/token 用量（A07，测试/注入缝）：直接给本轮增量，默认 0；缺省无 LLM 语义。 */
  usageForTurn?: (sceneId: string, addressee: AccountId, turn: number) => number;
  /**
   * A07 真实用量回读：返回账号当前累计 usage（跨 run 持久于 durable 会话 pi.usage）。
   * 编曲器在 drive 起点为每位发言候选读一次基线，之后每轮读一次并与该账号上次基线做差，
   * 得到本轮增量（input/output/totalTokens 分别做差）。与 usageForTurn 互斥：两者都注入时
   * usageForTurn 优先（测试缝只给定增量总额，无 input/output 拆分）。
   */
  usageTotalFor?: (addressee: AccountId) => UsageBreakdown | Promise<UsageBreakdown>;
  /** 成本出口（§20.2 三类来源）：每完成一轮真实生成即上抛一条 `source:'dialogue'` 记录。 */
  onCost?: (c: CostRecord) => void;
  /** 一轮收敛等待上限（A06，真实毫秒）：等被点名者 consumed 才计发言/推进；默认 30000。 */
  turnSettledMs?: number;
  /** 日终编排（R16/Q02）：close 在收敛在途后调用；缺省不跑日终（延迟接线，不伪造）。 */
  dayEnd?: DayEndRunner;
  /** R30/G4 devMode 关场校验：close 在日终后调用；缺省不跑自检（生产），返回 A1–A11 违例。 */
  invariantCheck?: () => SceneInvariantViolation[];
  now?: () => string;
}

/** scene/orchestrator.ts 导出的工厂（runtime/scenes.ts 据此构造）。 */
export type SceneOrchestratorFactory = (deps: SceneOrchestratorDeps) => SceneOrchestrator;