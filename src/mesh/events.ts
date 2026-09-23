// ═══════════════════════════════════════════════════════════════════════════
// 领域事件出口（§20.1）：把 mesh 的 15 个事件转译成统一的 RuntimeEvent 流
//
// mesh §12.5 ①：事件是**通知不是钩子**——事件订阅者不在投递判定路径上，所以
// 在这里读 envelope.ext 是合法的（mesh §21.1 推论 1），devMode 的 Proxy 也不会拦。
// 这一条区分必须保留：策略槽不得读 ext，事件订阅者可以。
//
// P0 转译所有 15 类（白名单收窄在 P6 observe 落地，届时只转「与领域相关」的子集）。
//
// 分层纪律（§22.4）：本文件不 import `runtime/**`（mesh → runtime 是反向依赖）。
// 转发事件用本地的 `MeshForwardEvent` 自描述，`RuntimeEvent` 在 runtime 层加以收窄。
// ═══════════════════════════════════════════════════════════════════════════

import type { MeshHost, MeshEvents } from "@pi/agent-mesh/core";

/** 转发的 mesh 事件（原样透传 kind + payload）。runtime 层把它收窄进 RuntimeEvent 联合。 */
export interface MeshForwardEvent {
  type: "mesh";
  kind: keyof MeshEvents;
  payload: unknown;
}

/** 本环关注的 mesh 事件全集（P6 收窄为白名单）。 */
export const MESH_EVENT_KINDS: Array<keyof MeshEvents> = [
  "message_routed",
  "message_delivered",
  "message_consumed",
  "message_parked",
  "message_dropped",
  "message_acked",
  "inbox_overflowed",
  "request_timeout",
  "conversation_changed",
  "membership_caps_changed",
  "shared_object_changed",
  "presence_changed",
  "endpoint_state_changed",
  "policy_degraded",
  "invariant_violated",
];

/** 订阅 mesh 事件并转发为 MeshForwardEvent。返回退订函数。 */
export function forwardMeshEvents(
  mesh: MeshHost,
  onEvent?: (e: MeshForwardEvent) => void,
): () => void {
  if (!onEvent) return () => {};
  const unsubs = MESH_EVENT_KINDS.map((kind) =>
    mesh.on(kind, (payload) => onEvent({ type: "mesh", kind, payload })),
  );
  return () => unsubs.forEach((u) => u());
}