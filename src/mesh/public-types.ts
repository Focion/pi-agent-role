// ═══════════════════════════════════════════════════════════════════════════
// mesh 类型再出口（§22.4 约束 #4）
//
// `@pi/agent-mesh` 只允许出现在 `src/mesh/**`。本文件是本环「把对外部库的依赖收进
// 一个可被 CI 扫描的目录」的唯一门——runtime / db / index 需要 mesh 类型时，一律
// 经这里 `import type { … } from "../mesh/public-types.js"`，绝不直接 import 包。
// 纯类型再出口：零运行时依赖，不构成 runtime ↔ mesh 的值环。
// ═══════════════════════════════════════════════════════════════════════════

export type {
  Account,
  AccountId,
  AckResult,
  Cap,
  Conversation,
  ConversationConfig,
  ConversationId,
  ConversationKind,
  ConversationSummary,
  CreateConversationInput,
  Endpoint,
  EndpointClass,
  EndpointId,
  EndpointState,
  Envelope,
  ExpectKind,
  Grade,
  InvariantReport,
  Limits,
  MeshEvents,
  MeshHost,
  MeshLease,
  MeshToolName,
  MeshToolResult,
  MessageKind,
  ParkReason,
  Policies,
  PresenceState,
  RejectCode,
  StreamPort,
  StreamTopology,
  ToolDefinition,
  Unsubscribe,

  // P2 场景/编排新增（§3.7 九槽余下 + Observer / SendInput）
  AccessControl,
  ActivationPolicy,
  DeliveryPolicy,
  EndpointSelector,
  FloorPolicy,
  LogicalClock,
  Observer,
  Renderer,
  RetentionPolicy,
  SendInput,
  SessionFactory,
} from "@pi/agent-mesh/core";