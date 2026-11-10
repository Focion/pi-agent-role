// ═══════════════════════════════════════════════════════════════════════════
// 公开类型面（§2.3 createRuntime 修订版）
//
// createRuntime 是**唯一**入口；其余类型在此聚合。宿主只 import "@pi/agent-role"。
// 需要 mesh 类型时经 `../mesh/public-types.js` 或 `../mesh/events.js`（§22.4 #4：
// `@pi/agent-mesh` 不得出现在本文件）。
// ═══════════════════════════════════════════════════════════════════════════

import type { AccountId, ConversationId, InvariantReport, Limits } from "../mesh/public-types.js";
import type { MeshForwardEvent } from "../mesh/events.js";
import type { ModelCredential } from "../mesh/pi-backend.js";

import type { ModelConfig, ModelConfigOverride, ModelConfigSource, ModelDialogueConfig } from "../compile/types.js";
import type {
  BlueprintReport,
  GenerateInput,
  PromoteInput,
  PromoteResult,
} from "../authoring/types.js";
import type { DanglingScanResult } from "../inspect/dangling-scan.js";
import type { RoleCostMetrics } from "../inspect/cost.js";
import type { ReconcileResult, ReprojectResult } from "./projector.js";
import type {
  MemoryTimeline,
  ImpressionEvolution,
  CostView,
} from "../observe/types.js";
import type {
  DomainDecisionReplay,
  ReplayCompareResult,
  ReplayReexecuteInput,
} from "../replay/types.js";
import type {
  ReflectionRunResult,
  ReflectSnapshot,
  ReflectionTrigger,
} from "../reflect/types.js";
import type { FloorMode, SceneEstablished, SceneParticipantRole, SceneRunResult } from "../scene/types.js";

import type { VirtualTs, VirtualClockMode } from "./virtual-clock.js";

// ─── 领域事件（§20.1 白名单；P6 observe 补全联合）──────────────────────────

/** 本环领域事件：转发的 mesh 事件 + 本环自产事件。 */
export type RuntimeEvent =
  | MeshForwardEvent
  | {
      type: "agent_registered";
      agentId: string;
      agentType: "role" | "facility" | "system";
      accountId: string;
      endpointId: string;
      reflectAccountId?: string;
    };

// ─── 成本出口（§20.2 三类来源）─────────────────────────────────────────────

export interface CostRecord {
  source: "dialogue" | "reflect" | "blueprint";
  agentId?: string;
  sceneId?: string;
  tokensIn?: number;
  tokensOut?: number;
  at: string;
}

// ─── 七个命名空间（逐阶段补齐方法；P0 只有门面壳）──────────────────────────

/** 蓝本：生成 / 落地（§24）。PA 实装。产物只写 staging；promote 是显式的第二次调用。 */
export interface BlueprintApi {
  /** 五步流水线（§24.3）：normalize → scaffold → seed → expand → validate。只写 staging。 */
  generate(input: GenerateInput): Promise<BlueprintReport>;
  /** 落地（§24.6）：原子 rename 到 templates/<kind>，写 provenance.yaml，幂等冲突拒绝。 */
  promote(stagingId: string, opts?: PromoteInput): Promise<PromoteResult>;
}

/** 角色 Agent：创建 / 删除 / 编译 / 查询（§4）。P1 实装 create + reconcile。 */
export interface AgentApi {
  /** §4.2 八步：物化 → 编译 → 落库 → 注册 mesh（dialogue Account/Endpoint）→ 回写映射。 */
  create(input: CreateAgentInput): Promise<CreateAgentResult>;
  /** R04 / §4.2.4：逐项串行创建多个角色，逐项报告成功/待恢复。不承诺跨库整批原子回滚——已成功的项保留，失败项按失败阶段推进（registering 可 reconcile、failed 已回滚）。 */
  createBatch(inputs: CreateAgentInput[]): Promise<CreateBatchItemResult[]>;
  /** §4.2.4 前向恢复：扫描 status='registering' 的行并补齐 mesh 注册，幂等可重复。 */
  reconcileRegistrations(opts?: { agentIds?: string[] }): Promise<ReconcileRegistrationResult[]>;
  /** R09 / §6.2：把 DB 当前状态渲染成全部实例文件（模板 + 记忆投影），幂等可重跑、损坏可重建。 */
  reproject(agentId: string): ReprojectResult;
  /** R09 / §6.2：检测模板文件与 DB 的差异，审计后导入可回导字段，再重新投影（不静默覆盖）。 */
  reconcile(agentId: string): ReconcileResult;
  /** R06 / §5.4：在已定稿模型配置上合并运行期覆盖（dialogue/reflection/budget 独立），写回并同步内存绑定。 */
  setModelConfig(agentId: string, patch: ModelConfigOverride): SetModelConfigResult;
  /** R10 / §4.6.2 前半：从实例模板重编译 spec 并写新快照；身份字段变化拒绝，mesh 投影漂移只在返回里报告。 */
  respec(agentId: string): Promise<RespecResult>;
  /** R10 可恢复退役：status→'retired'，保留 role 侧行与 mesh 历史；幂等。 */
  retire(agentId: string): RetireResult;
  /** R10 恢复退役 Agent（不重新注册 mesh——账号从未删除）。 */
  restore(agentId: string): RestoreResult;
  /** R10 永久删除 role 侧行 + 实例目录；mesh 历史保留。不可逆。 */
  deleteAgent(agentId: string): DeleteAgentResult;
}

/** §4.2 `create()` 入参。注册参数不由调用方提供，而由身份编译器算出（C1）。 */
export interface CreateAgentInput {
  /** 相对 root，或绝对路径（§4.2）。 */
  blueprint: string;
  /** 由调用方给定；同时就是 mesh accountId（§4.2.1 恒等）。 */
  agentId: string;
  /** 对蓝本的 JSON-merge-patch，物化时应用（C3 / §4.2.5）。 */
  overlay?: unknown;
  /** 第 4 层：dialogue 模型覆盖（§5.4）。 */
  model?: Partial<ModelDialogueConfig>;
  /** 第 4 层：reflect 流模型覆盖；缺省继承 dialogue（§5.4 末）。 */
  reflectModel?: Partial<ModelDialogueConfig>;
  /** 第 4 层：生命周期 token 预算。 */
  tokenBudget?: number;
  /** 缺省取编译结果（personal.name.full || agentId）。 */
  displayName?: string;
}

/** §4.2 `create()` 返回值。 */
export interface CreateAgentResult {
  agentId: string;
  promptVersion: string;
  blueprintId: string;
  blueprintHash: string;
  modelConfig: ModelConfig;
  modelConfigSource: ModelConfigSource;
  mesh: {
    accountId: string;
    endpointId: string;
    /** P1 未注册自省流（§4.4 在 P4 实装），恒为 undefined。 */
    reflectAccountId?: string;
    reflectEndpointId?: string;
    reflectConversationId?: string;
  };
}

/** §4.2.4 `reconcileRegistrations()` 的单行结果。 */
export interface ReconcileRegistrationResult {
  agentId: string;
  before: "registering" | "active";
  actions: string[];
  after: "active" | "failed";
  error?: { code: string; message: string };
}

/** R04 `createBatch()` 的单行结果（§4.2.4 逐项串行，不承诺整批原子回滚）。 */
export interface CreateBatchItemResult {
  agentId: string;
  /**
   * 单行终态：
   *   · "active"     —— 本项完整注册（八步走完）；
   *   · "registering"—— mesh 注册区间（第 7/7.5 步）失败，行保留待 `reconcileRegistrations` 前向恢复；
   *   · "failed"     —— 物化/编译/落库（第 3–6 步）失败，单事务已回滚，无残留行。
   */
  after: "active" | "registering" | "failed";
  /** after='active' 时的完整结果。 */
  result?: CreateAgentResult;
  /** after='registering' / 'failed' 时的原因。 */
  error?: { code: string; message: string };
}

/** R06 `agents.setModelConfig()` 的返回值：应用覆盖后的定稿模型配置 + 叶子来源。 */
export interface SetModelConfigResult {
  agentId: string;
  modelConfig: ModelConfig;
  modelConfigSource: ModelConfigSource;
}

/** R10 `agents.respec()` 检出的 mesh 投影漂移（mesh 无 updateAccount，故只报告不静默改现场）。 */
export interface RespecMeshDrift {
  field: string;
  from: unknown;
  to: unknown;
  repair: "respec" | "recreate_endpoint";
}

/** R10 `agents.respec()` 的返回值。 */
export interface RespecResult {
  agentId: string;
  promptVersion: string;
  /** 重编译后聚合 spec 指纹是否有变化；true 时已写新 agent_specs 快照 + 审计。 */
  specHashChanged: boolean;
  /** 相对注册快照的 mesh 投影漂移；displayName/capabilities/initiate/defaultGrade/topology 变化无法在 mesh 侧跟随。 */
  pendingMeshDrift: RespecMeshDrift[];
}

/** R10 `agents.retire()` 的返回值。 */
export interface RetireResult {
  agentId: string;
  status: "retired";
  retiredAt: string | null;
  /** true = 已是退役态，本次为幂等空操作。 */
  alreadyRetired: boolean;
}

/** R10 `agents.restore()` 的返回值。 */
export interface RestoreResult {
  agentId: string;
  status: "active";
}

/** R10 `agents.deleteAgent()` 的返回值。 */
export interface DeleteAgentResult {
  agentId: string;
  deleted: boolean;
}

/** §4.6.1 契约 4 的逐条核对结果（R10 一致性报告）。 */
export interface MeshConsistencyFinding {
  code: "MAPPING_MISSING" | "ACCOUNT_MISSING" | "ENDPOINT_MISSING" | "FIELD_DRIFT" | "TOPOLOGY_DRIFT";
  field?: string;
  expected?: unknown;
  actual?: unknown;
  repair: "reconcile" | "respec" | "recreate_endpoint" | "manual";
}

export interface MeshConsistencyAgent {
  agentId: string;
  findings: MeshConsistencyFinding[];
}

export interface MeshConsistencyReport {
  checkedAt: string;
  /** 未核对的断言（需 mesh 侧读或未持久化的反射会话 id）：如实标注，不以 0 占位。 */
  notChecked: string[];
  agents: MeshConsistencyAgent[];
}

/** 设施 Agent：同上，能力面不同（§3.2 / §5.5）。R11 实装 create + reconcile。 */
export interface FacilityApi {
  /** §5.5：物化设施蓝本 → 编译 FacilitySpec → 落库（模板/模型/身份/状态）→ 注册 mesh 只应答 Account。 */
  create(input: CreateFacilityInput): Promise<CreateFacilityResult>;
  /** §4.2.4 前向恢复：扫描 status='registering' 的设施行并补齐 mesh 注册，幂等可重复。 */
  reconcileRegistrations(opts?: { facilityIds?: string[] }): Promise<ReconcileRegistrationResult[]>;
}

/** facilities.create() 入参。设施不是 persona，无身份编译；由设施编译器算出 mesh 投影与四工具面。 */
export interface CreateFacilityInput {
  /** 设施 id，同时就是 mesh accountId（§4.2.1 恒等约定沿用）。 */
  facilityId: string;
  /** 设施蓝本目录（相对 root 或绝对路径）。materialize 落 <root>/agents/<id>/facility/。 */
  blueprint: string;
  /** 对蓝本的 JSON-merge-patch，物化时应用（C3）。 */
  overlay?: unknown;
  /** 第 4 层：dialogue 模型覆盖（§5.4）。 */
  model?: Partial<ModelDialogueConfig>;
  /** 第 4 层：生命周期 token 预算。 */
  tokenBudget?: number;
  /** 缺省取编译结果（facility.name）。 */
  displayName?: string;
}

export interface CreateFacilityResult {
  facilityId: string;
  promptVersion: string;
  blueprintId: string;
  blueprintHash: string;
  modelConfig: ModelConfig;
  modelConfigSource: ModelConfigSource;
  accountId: string;
  endpointId: string;
}

/** 场景：create / run / resume / close（§7）。P2 实装。 */
export interface SceneApi {
  /** 建档（§7.1）：写 scenes 行 + 建/复用 group 会话 + 入会设 caps（按角色推导）。 */
  create(input: CreateSceneInput): Promise<SceneEstablished>;
  /** 跑一轮（§7.5）：点名 → 发 cue → 推进虚拟时钟 → 预算熔断；abort（H04）只停新 cue。 */
  run(sceneId: string, signal?: AbortSignal, opts?: SceneRunOptions): Promise<SceneRunResult>;
  /** 恢复一个仍在 active 的场景接着跑（读 scenes 行，不重建成员）。 */
  resume(sceneId: string, signal?: AbortSignal, opts?: SceneRunOptions): Promise<SceneRunResult>;
  /** 收尾（§7.5）：场景 status='ended'，不解散会话。 */
  close(sceneId: string): Promise<SceneRunResult>;
}

/** 场景参与者入参：宿主只给 agentId + 领域角色；meshAccountId/caps 由门面按角色推导（§3.3）。 */
export interface SceneParticipantInput {
  agentId: string;
  role: SceneParticipantRole;
}

/** scenes.create() 入参。 */
export interface CreateSceneInput {
  sceneId: string;
  name?: string;
  participants: SceneParticipantInput[];
  /** 点名（cue）的 from 账号，缺省 @system（宿主提供的系统账号）。 */
  hostAccountId?: AccountId;
  /** 复用已有 group 会话；缺省新建。 */
  conversationId?: ConversationId;
  /** 虚拟起点（W3D1T14）；缺省取 root 时钟起点。 */
  virtualStart?: string;
  /** 每轮推进的虚拟分钟数（§8.2.1）。默认 60（÷60 = 1 虚拟小时）。 */
  turnDurationMinutes?: number;
  /** 发言权模式。默认 director。 */
  floorMode?: FloorMode;
  maxTurns?: number;
  tokenBudget?: number;
  facilityId?: string;
  facilityJson?: unknown;
}

/** run/resume 的运行时覆盖（临时收窄预算/轮次）。 */
export interface SceneRunOptions {
  maxTurns?: number;
  tokenBudget?: number;
}

/** 自省：触发一次自省回合、读自省记忆（§13）。P4 实装。 */
export interface ReflectApi {
  /** 对单个角色触发一次分级自省（manual/full 或显式触发器）。 */
  run(
    agentId: string,
    opts?: { trigger?: ReflectionTrigger; sceneId?: string; virtualTs?: string },
  ): Promise<ReflectionRunResult>;
  /** 阈值触发器（episodes_since / daily）：未达阈值返回 undefined。 */
  maybe(
    agentId: string,
    trigger: ReflectionTrigger,
    opts?: { sceneId?: string; virtualTs?: string },
  ): Promise<ReflectionRunResult | undefined>;
  /** 对全部 role agent 逐个触发（scene_end 等广播触发器）。 */
  runAll(opts: { trigger: ReflectionTrigger; sceneId?: string; virtualTs?: string }): Promise<ReflectionRunResult[]>;
  /** 读自省记忆（画像 + 自省历史 + 当前状态）。 */
  read(agentId: string): Promise<ReflectSnapshot>;
}

/** 记忆：宿主侧只读检索与统计（§14 / §20 / R08）。纯读，不强化、不复活（「不隐式强化或修复」）。 */
export interface MemoryApi {
  /** owner 视图：检索该 agent 记得什么（等价 recall 的纯读，不落检索账、不强化）。 */
  recall(ownerAgent: string, query: string, opts?: { limit?: number }): Promise<MemoryRecallResult>;
  /** 管理视图：本库全部 role agent 的记忆计数统计（跨 owner 汇总）。 */
  stats(): Promise<MemoryStats>;
}

/** memory.recall() 的一条命中（宿主视图可看内部字段；区分于面向 Agent 的卡片视图）。 */
export interface MemoryRecallItem {
  episodeId: string;
  kind: string;
  gist: string;
  detail: string | null;
  salience: number;
  retention: number;
  confidence: number;
  status: "active" | "faded" | "consolidated";
  virtualTs: string | null;
}

export interface MemoryRecallResult {
  ownerAgent: string;
  query: string;
  items: MemoryRecallItem[];
}

export interface MemoryStatsAgent {
  agentId: string;
  episodes: number;
  subjects: number;
  knowledgeItems: number;
  reflections: number;
}

export interface MemoryStats {
  agents: MemoryStatsAgent[];
}

/** 巡检：谱系一致性、分区不变量、悬挂 msg_id 检测（§18.6）。 */
export interface InspectApi {
  /** 分区不变量 + mesh 不变量（P6 合一）。P0 转发 mesh.checkInvariants。 */
  checkInvariants(): Promise<{ mesh: InvariantReport; role: RoleInvariantReport }>;
  /** R10 / §4.6.1：本环 AgentSpec ↔ mesh 投影的一致性报告（A/B/C/D 断言，如实标注未核对项）。 */
  checkMeshConsistency(): Promise<MeshConsistencyReport>;
  /** §18.6.3：双库悬挂检测——扫描 episode/knowledge/retrieval/reflection 四类裸锚点，
   *  核对 mesh 原文，标记 evidence_lost（有 confidence 的降级，检索/自省只审计，不碰 status）。 */
  scanDanglingMessages(opts?: { since?: string; confidencePenalty?: number }): Promise<DanglingScanResult>;
  /** §20.2.4：自省流成本两段拼接排除——对话口径（含/不含自省）的重算指标。 */
  costMetrics(opts?: { since?: string; until?: string }): Promise<RoleCostMetrics>;
  /** §20.3.1：记忆时间线——角色经历了什么、记住了什么。跨库回查 mesh 证据。 */
  memoryTimeline(ownerAgent: string, opts?: { since?: string; until?: string; maxItems?: number }): Promise<MemoryTimeline>;
  /** §20.3.2：印象演化曲线——某个 subject 的评价轨迹。单库查询，无需 mesh。 */
  impressionEvolution(ownerAgent: string, subjectType: string, subjectId: string): Promise<ImpressionEvolution>;
  /** §20.3.3：成本视图——这段时间花了多少、花在哪。聚合 mesh 计数器 + 本环开销。 */
  costView(opts?: { since?: string; until?: string; sceneIds?: string[]; agentIds?: string[] }): Promise<CostView>;
}

export interface RoleInvariantReport {
  ok: boolean;
  checked: number;
  violations: Array<{ id: string; assertion: string; count: number }>;
}

/** 回放与比较（H03 / R37 / R38）：记录回放 + 隔离重执行 + 结构化比较。 */
export interface ReplayApi {
  /** 记录回放：只读已保存的逐轮/空轮领域决策 + 检索快照，核对 hash/指纹/来源。 */
  record(ownerAgent: string, opts?: { sceneId?: string; since?: string; until?: string; maxItems?: number }): Promise<DomainDecisionReplay>;
  /** 隔离重执行：独立新环境跑冻结探针脚本，原环境不改；结果来源 source:"reexecuted"。 */
  reexecute(input: ReplayReexecuteInput): Promise<DomainDecisionReplay>;
  /** 结构化比较：两条回放的记忆/知识/决策/检索/成本硬指标差异（纯函数）。 */
  compare(left: DomainDecisionReplay, right: DomainDecisionReplay): ReplayCompareResult;
}

// ─── createRuntime 入口 ────────────────────────────────────────────────────

export interface RuntimeOptions {
  /** 工作根目录：模板物化、pi session JSONL、导出产物都落这里。root 之外零副作用（C8）。 */
  root: string;

  /** DB-A：本环独占的领域库路径（附录 E）。表结构由本环迁移管理。 */
  db: string;

  /** DB-B：mesh 自持库路径，原样透传 createMesh({dbPath})。缺省 `${root}/mesh.db`（决议 D-B）。 */
  meshDb?: string;

  /**
   * R33 双库配对锚点账号 id（§18.2）。只用于在 mesh 里注册一个承载配对标识的锚点账号，
   * 供恢复 / 成本 / 悬挂扫描回读核对「本 role 库正对的是哪个 mesh 库」。缺省 `role:pairing`；
   * 首次配对后不得更改（改传不同值会抛 PairingError）。
   */
  pairingAnchor?: string;

  /** 虚拟时钟（C11）。mode:'virtual' 维护 W<周>D<日>T<时段>；'real' 用真实时间（测试/单轮调试）。 */
  clock?: { mode: VirtualClockMode; start?: VirtualTs };

  /** 领域事件出口（转 mesh 15 事件白名单子集 + 本环事件）。 */
  onEvent?: (e: RuntimeEvent) => void;

  /** 成本出口（dialogue / reflect / blueprint 三类）。 */
  onCost?: (c: CostRecord) => void;

  /** 覆盖 mesh Limits 子集（26 项封闭集，附录 F.1）。本环只透传。 */
  limits?: Partial<Limits>;

  /** 第 1 层模型默认（§5.4 runtime_default 层）：本 runtime 内所有 Agent 的地板之上。 */
  modelDefaults?: Partial<ModelConfig>;

  /** 透传 mesh.devMode：策略槽读 ext / 策略内重入写 API 会被运行时捕获。测试环境恒 true。 */
  devMode?: boolean;

  /** provider → 模型凭据（M05：pi-durable 1.5 无缺省模型目录，宿主须显式注入）。
   *   `baseUrl` 存在即按自定义 provider（OpenAI 兼容端点）装配，缺省按 pi-ai 内建目录。
   *   缺省不注入 → 真实模型调用会在 provider 认证处失败；fake 后端不受影响。 */
  credentialFor?: (
    provider: string,
  ) => ModelCredential | undefined | Promise<ModelCredential | undefined>;

  /** 无 LLM 测试：SessionFactory 走假实现 + FakeStreamPort 交给 mesh（§21.2）。 */
  fake?: {
    streamPort?: boolean;
    sessions?: boolean;
    /** 测试注入场景 token 用量源（A07）：缺省每轮 0，避免真实后端不可得的假校验。 */
    usageForTurn?: (sceneId: string, addressee: string, turn: number) => number;
  };
}

export interface Runtime {
  blueprints: BlueprintApi;
  agents: AgentApi;
  facilities: FacilityApi;
  scenes: SceneApi;
  reflect: ReflectApi;
  memory: MemoryApi;
  inspect: InspectApi;
  replay: ReplayApi;
  close(): Promise<void>;
}