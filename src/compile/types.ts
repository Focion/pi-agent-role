// ═══════════════════════════════════════════════════════════════════════════
// 编译产物契约（§5.1 AgentSpec / §5.4 ModelConfig / §4.2.1 mesh 投影）
//
// 这是 P1 全部编译轨道共享的唯一类型契约：identity-loader（产出 AgentSpec）、
// model-resolver（产出 ModelConfig + ModelConfigSource）、materialize（产出实例模板
// 目录）、agents.create（消费全部）都以本文件为交界面。改这里 = 改所有编译器的签名。
//
// 分层纪律（§22.4 #4）：本文件属于 `src/compile/**`，**不得**直接 import
// `@pi/agent-mesh` 包。mesh 类型（MessageKind / MeshToolName）经
// `../mesh/public-types.js` 再出口；领域工具封闭集（DomainToolName）经
// `../mesh/tools.js` 复用，二者都是本环自己的模块，不碰包边界。
// ═══════════════════════════════════════════════════════════════════════════

import type { MeshToolName, MessageKind } from "../mesh/public-types.js";
import type { DomainToolName } from "../mesh/tools.js";

/** 契约 2 的版本号（§5.1）：mesh 投影是 v2 的新增段，版本从 "1.0" 升到 "2.0"。 */
export const SPEC_VERSION = "2.0" as const;
export type SpecVersion = typeof SPEC_VERSION;

/** 编译器种类：决定 endpointClass / defaultGrade / initiate 的推导分支（§4.2.1 / §5.5）。 */
export type CompilerKind = "identity" | "facility";

// ─── 模型配置（C6 / §5.4）───────────────────────────────────────────────────

export interface ModelDialogueConfig {
  provider: string;                          // "anthropic" | ...
  modelId: string;                           // "claude-opus-5" | "claude-sonnet-5" | ...
  thinkingLevel: "off" | "low" | "medium" | "high";
  temperature?: number;
}

export interface ModelBudgetConfig {
  tokenBudgetTotal?: number;                 // 该 Agent 生命周期累计上限
  tokenBudgetPerScene?: number;
  onExceed: "warn" | "downgrade" | "halt";
  downgradeTo?: { modelId: string; thinkingLevel: string };
}

export interface ModelConfig {
  dialogue: ModelDialogueConfig;
  /** 缺省继承 dialogue；reflect 流没有自己的解析链（§5.4 末）。 */
  reflection?: Partial<ModelDialogueConfig>;
  budget: ModelBudgetConfig;
}

/** 五层解析链（后者覆盖前者，全程无代码常量）。 */
export type ModelConfigLayer =
  | "runtime_default" | "blueprint" | "roster" | "create_arg" | "scene_override";

/** 每个叶子字段来自哪一层。key 是点分路径，如 "dialogue.modelId"（§5.4 末）。 */
export type ModelConfigSource = Record<string, ModelConfigLayer>;

// ─── mesh 投影（§4.2.1）：注册 Account/Endpoint 的全部入参 ──────────────────

export interface AgentSpecMeshProjection {
  accountId: string;                         // === AgentSpec.agentId，恒等（§4.2.3）
  displayName: string;                       // 编译自 personal.name.full
  endpointClass: "stream";                   // 角色 Agent 恒为 stream
  capabilities: string[];                    // agent_protocol.capabilities 原样 + kind:role
  initiate: MessageKind[];                   // ⊆ 五值封闭集；缺省 ["chat"]
  defaultGrade: "steer" | "followUp" | "silent";
  topology:
    | { kind: "unified" }
    | { kind: "perConversation"; scope: "conversation" | "purpose"; key: string }
    | { kind: "pooled"; size: number; affinity?: "none" | "conversation" | "sender" };
  profileRef: string;                        // = `spec:${promptVersion}`
}

// ─── 身份各维度（§5.1）──────────────────────────────────────────────────────

/** 来自 agent_protocol.yaml：能力宣告 + 发起权宣告。 */
export interface AgentProtocol {
  capabilities: string[];                    // 原样搬运，编译器不解释字符串内容
  initiate: MessageKind[];                   // 缺省 ["chat"]；越界=校验失败（本环定义）
}

/** constraints.yaml 编译产物，按 priority_order 排序后扁平（hard 在前）。 */
export interface CompiledConstraint {
  id: string;
  text: string;
  severity: "hard" | "soft";
  priorityOrder: number;
  violationResponse?: string;
}

export interface LazySection {
  section: string;                           // "psychology" | "academic" | "family" | ...
  description: string;
  keywords: string[];                        // 来自 manifest.load_trigger.keywords
  tokenEstimate: number;
}

export interface ToolPolicy {
  domainTools: DomainToolName[];             // 10 个封闭集合的子集（§3.8）
  meshTools: MeshToolName[];                 // 注册期裁剪后的 mesh 工具白名单（§4.4.2）
}

export interface KnowledgeItem {
  topic: string;
  claim: string;
}

/** 初始实例状态（写入 DB 后即与模板脱钩）。 */
export interface AgentInitialState {
  mood: string;
  moodIntensity: number;
  energy: number;
  trustDefaults: Record<string, number>;     // 来自 relationships.yaml
  knowledgeSeed: KnowledgeItem[];            // 来自 knowledge_boundaries.yaml
}

// ─── 记忆策略（§12.2）。P1 用 defaultMemoryPolicy 占位；P3 的 policy-mapper ──
// ─── 由 psychology.yaml + narrative_voice.yaml 编译，一次性替换默认值。────────

export interface MemoryPolicy {
  writeThreshold: number;                    // 0..1，超过才写
  w: {
    novelty: number; arousal: number; selfRelevance: number;
    hint: number; repetition: number; authority: number;
  };
  authorityWeights: Record<string, number>;  // role 名 → 权重
  defaultTrust: number;
  arousalGain: number;
  negativeBias: number;                      // 同时进衰减公式 τ（§15.1）
  detailRetention: number;
  maxWritesPerTurn: number;
  p2Damping: number;                         // P2 路径打分折扣（§12.1.2②）
  tau0Hours: number;                         // 衰减时间常数基准，单位虚拟小时
  reflection: {
    episodesPerReflection: number;
    trustDeltaCap: number;
    closenessDeltaCap: number;
    moodDeltaCap: number;
  };
}

/** 中性基线（没有任何角色特化的默认值）。P3 由模板字段编译覆盖。 */
export function defaultMemoryPolicy(): MemoryPolicy {
  return {
    writeThreshold: 0.5,
    w: { novelty: 1, arousal: 1, selfRelevance: 1, hint: 1, repetition: 1, authority: 1 },
    authorityWeights: {},
    defaultTrust: 0.5,
    arousalGain: 1,
    negativeBias: 1,
    detailRetention: 0.5,
    maxWritesPerTurn: 3,
    p2Damping: 0.6,
    tau0Hours: 24 * 7,
    reflection: {
      episodesPerReflection: 6,
      trustDeltaCap: 0.15,
      closenessDeltaCap: 0.15,
      moodDeltaCap: 0.2,
    },
  };
}

// ─── AgentSpec（纯数据、可序列化、无方法；§5.1）────────────────────────────

export interface AgentSpec {
  specVersion: SpecVersion;
  agentId: string;
  identityId: string;
  promptVersion: string;                     // sha256(参与编译文件 + 编译器版本)

  // 冷启动层：进 system prompt，每次必带
  systemPrompt: string;
  /** manifest 中 priority: cold_start 的文件，恰好 6 个（§5.1 注释）。 */
  coldStartFiles: string[];

  // 按需层：不进 prompt，仅登记索引，由 identity_read 拉取
  lazySections: LazySection[];

  toolPolicy: ToolPolicy;
  constraints: CompiledConstraint[];
  protocol: AgentProtocol;
  mesh: AgentSpecMeshProjection;
  memoryPolicy: MemoryPolicy;
  modelConfig: ModelConfig;
  initialState: AgentInitialState;
}

/** compileIdentity 的上下文（§5.1 恒定签名）。 */
export interface CompileContext {
  agentId: string;
  modelConfig: ModelConfig;
  compilerVersion: string;
}