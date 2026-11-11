// ═══════════════════════════════════════════════════════════════════════════
// pi-agent-role — 错误层级
//
// 全部继承 RoleRuntimeError 一个基类，宿主可统一按 `instanceof RoleRuntimeError`
// 捕获本环错误。`name` 由 `new.target.name` 派生，保证 `err.name === "ValidationError"`
// 而不是一律 "Error"。
// ═══════════════════════════════════════════════════════════════════════════

export class RoleRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 入参 / 蓝本 / spec 校验失败。宿主把表单 JSON 转成对象后调用，这是第一道关卡（§2.5 ①）。 */
export class ValidationError extends RoleRuntimeError {}

/** 蓝本 / spec 的版本跨域不支持（如 v2 运行时读到一个 v3 蓝本）。§24 的失败模式。 */
export class SpecVersionMismatch extends RoleRuntimeError {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`spec version mismatch: expected ${expected}, got ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

/** 实例模板正在被另一个写者持锁（Projector 的文件锁，P5 不等待不重试）。§18.7 P5。 */
export class AgentLocked extends RoleRuntimeError {
  readonly agentId: string;
  constructor(agentId: string) {
    super(`agent template is locked by another writer: ${agentId}`);
    this.agentId = agentId;
  }
}

/** 场景预算 / 记忆写入预算超限。§7.6 的场景预算与 §12.2 的记忆写入上限。 */
export class BudgetExceeded extends RoleRuntimeError {
  readonly kind: "turns" | "tokens" | "memory";
  readonly sceneId?: string;
  constructor(kind: "turns" | "tokens" | "memory", detail: string, sceneId?: string) {
    super(`budget exceeded (${kind}): ${detail}`);
    this.kind = kind;
    this.sceneId = sceneId;
  }
}

/** mesh 侧操作失败时的桥接错误，`cause` 保留 mesh 原始错误。 */
export class MeshBridgeError extends RoleRuntimeError {}

/**
 * 双库规约被破坏（§18.6）：例如试图在本环库内 JOIN mesh 表、或把 mesh 侧标识写进
 * 本环唯一键。这类错误意味着实现层缺陷而非运行期故障。
 */
export class SplitDbError extends RoleRuntimeError {}

/** 请求的蓝本（blueprint）不存在或无法解析。 */
export class BlueprintNotFound extends RoleRuntimeError {
  readonly blueprint: string;
  constructor(blueprint: string) {
    super(`blueprint not found: ${blueprint}`);
    this.blueprint = blueprint;
  }
}

/** §6.4.1 导出净化断言命中的违规类别（镜像创建方向的 mesh 禁止字段，导出侧更易出错）。 */
export type BlueprintExportViolation =
  | "MESH_ACCOUNT_ID_PRESENT"
  | "ENDPOINT_ID_PRESENT"
  | "CONVERSATION_ID_PRESENT"
  | "SEQ_OR_SEAL_PRESENT"
  | "PEER_AGENT_ID_PRESENT"
  | "PROMPT_VERSION_PRESENT";

/** §6.4.1 assertExportable 失败：导出的蓝本携带 mesh 身份平面或同伴 agent id，不产出蓝本。 */
export class BlueprintExportError extends RoleRuntimeError {
  readonly violations: Array<{ code: BlueprintExportViolation; where: string }>;
  constructor(violations: Array<{ code: BlueprintExportViolation; where: string }>, message: string) {
    super(message);
    this.violations = violations;
  }
}

/**
 * 双库配对不成立（§18.2 / R33）：缺锚点、锚点标记不符、或 mesh 库被替换。此时所有
 * 跨库读取（恢复、成本重算、悬挂扫描）应整体拒绝出数，而不是给一个漏排除/误判的数。
 */
export class PairingError extends RoleRuntimeError {
  readonly detail: string;
  constructor(detail: string) {
    super(`dual-db pairing not established: ${detail}`);
    this.detail = detail;
  }
}

/** DAO 检出跨 owner 写入尝试（§19.4 分区隔离）。刷 `state_writes(reason='cross_owner_write_rejected')`。 */
export class CrossOwnerWriteRejected extends RoleRuntimeError {
  readonly ownerAgent: string;
  readonly attemptedOwner: string;
  constructor(ownerAgent: string, attemptedOwner: string) {
    super(`cross-owner write rejected: owner=${ownerAgent} attempted=${attemptedOwner}`);
    this.ownerAgent = ownerAgent;
    this.attemptedOwner = attemptedOwner;
  }
}