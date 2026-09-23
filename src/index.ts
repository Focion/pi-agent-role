// ═══════════════════════════════════════════════════════════════════════════
// pi-agent-role — 包根（§2.3 / §22.4 #3）
//
// 不可独立运行的 npm 库：无 CLI、无端口、不读 argv。唯一入口 `createRuntime`。
// 对外只暴露一个函数 + 公开类型 + 错误层级；runtime 内部句柄（mesh/registry）
// 不进入公开类型，测试经 `src/runtime/runtime.js` 的 `RuntimeInternals` 触达。
// ═══════════════════════════════════════════════════════════════════════════

import { createRuntime as createRuntimeImpl } from "./runtime/runtime.js";

import type { Runtime, RuntimeOptions } from "./runtime/types.js";

/** 唯一入口（§2.3）：构建 Runtime，向下装配 mesh + pi（经 @pi/agent-mesh）。 */
export const createRuntime: (options: RuntimeOptions) => Promise<Runtime> = createRuntimeImpl;

export type {
  Runtime,
  RuntimeOptions,
  RuntimeEvent,
  CostRecord,
  BlueprintApi,
  AgentApi,
  CreateAgentInput,
  CreateAgentResult,
  ReconcileRegistrationResult,
  FacilityApi,
  SceneApi,
  ReflectApi,
  MemoryApi,
  InspectApi,
  RoleInvariantReport,
} from "./runtime/types.js";

export type {
  ModelConfig,
  ModelConfigSource,
  ModelConfigLayer,
  ModelDialogueConfig,
  ModelBudgetConfig,
} from "./compile/types.js";

export type {
  ReflectionTrigger,
  ReflectionDepth,
  ReflectionRunResult,
  ReflectSnapshot,
  ReflectionOutput,
} from "./reflect/types.js";

export type { RoleCostMetrics } from "./inspect/cost.js";

export type {
  BlueprintSchemaKind,
  Fact,
  ValidationReport,
  AuthorModel,
  AuthorModelRequest,
  AuthorModelTarget,
  AuthorModelResponse,
  GenerateInput,
  BlueprintReport,
  AllocationEntry,
  GapEntry,
  UnallocatedEntry,
  SeedEntry,
  PromoteInput,
  PromoteResult,
} from "./authoring/types.js";

export type {
  MemoryTimeline,
  TimelineScene,
  TimelineItem,
  TimelineEvidence,
  EvidenceLevel,
  ImpressionEvolution,
  ImpressionPoint,
  ImpressionJump,
  CostView,
  ObserveWindow,
} from "./observe/types.js";

export {
  RoleRuntimeError,
  ValidationError,
  SpecVersionMismatch,
  AgentLocked,
  BudgetExceeded,
  MeshBridgeError,
  SplitDbError,
  BlueprintNotFound,
  CrossOwnerWriteRejected,
} from "./runtime/errors.js";