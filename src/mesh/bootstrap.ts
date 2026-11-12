// ═══════════════════════════════════════════════════════════════════════════
// createRoleMesh（§12.1 装配）——本环「接上 mesh」的唯一装配点
//
// 只传 5 个策略槽：sessionFactory（★必填）+ 4 个自实现槽（activation/floor/
// renderer/accessControl）。其余 4 槽（delivery/clock/retention/endpointSelector）
// 不传，走 mesh 默认（九槽签名文档 §改动清单）。本环由此处起，其余文件不直接
// 调 createMesh。
//
// registerAgent 把「注册一个角色/设施 Account + unified Endpoint」做成一步，消除
// ENDPOINT_GONE 的空窗：account 与 endpoint 落库后再回填注册表闭包（§3.7①策略槽
// 只经闭包 O(1) 反查，不查库）。
// ═══════════════════════════════════════════════════════════════════════════

import { createMesh } from "@pi/agent-mesh";
import type { Grade, Limits, MeshHost, MessageKind, StreamPort, StreamTopology } from "@pi/agent-mesh/core";

import { makeLogicalClock } from "../scene/clock.js";
import { makeFloorStateController } from "../scene/floor-state.js";
import type { FloorStateController } from "../scene/types.js";

import { RoleAccountRegistry, type RegisteredAgentMeshIds } from "./accounts.js";
import { makeAccessControl } from "./policies/access-control.js";
import { makeActivationPolicy } from "./policies/activation.js";
import { makeFloorPolicy } from "./policies/floor.js";
import { makeRenderer } from "./policies/renderer.js";
import { makeSessionFactory, type SessionBackend, type RoleSessionFactoryOptions } from "./session-factory.js";

export interface RoleMeshOptions {
  /** mesh.db 路径（DB-B），原样透传 createMesh({dbPath})。 */
  dbPath: string;
  devMode?: boolean;
  limits?: Partial<Limits>;
  /** 无 LLM 测试注入 FakeStreamPort；缺省 mesh 自建 PiStreamPort。 */
  streamPort?: StreamPort;
  /**
   * 多进程部署透传（O07 · §19.3，原样透传 createMesh，不复制通信运行时）：
   *   · transport:"sameHost" ⇒ 用 SameHostTransport（同机多进程共享 DB-B，经 outbox 交叉投递）。
   *   · transportOptions        ⇒ SameHostTransport 热轮询/租约参数。
   *   · recoverDeadEndpoints    ⇒ 启动回收死写者遗留的实例/端点锁（§27.4，自动回收仅此一处）。
   *   · busyTimeoutMs           ⇒ SQLite 写锁等待上限（多进程部署建议显式设置，§19.5）。
   * 缺省全不传 ⇒ mesh 走 InProcessTransport + 单实例排他锁（单进程核心，行为不变）。
   */
  transport?: "sameHost";
  transportOptions?: { pollIntervalMs?: number; claimTtlMs?: number; maxAttempts?: number };
  recoverDeadEndpoints?: boolean;
  busyTimeoutMs?: number;
  /** 会话后端；缺省 fake（无 LLM）。真实后端经 createPiBackend（pi-durable 1.5，M01–M02）。 */
  backend?: SessionBackend;
  /** 逐账号领域工具处理器（P3 记忆：remember/recall 需按 owner 分区闭包；异步装配）。 */
  domainHandlersFor?: RoleSessionFactoryOptions["domainHandlersFor"];
  /** 发送装饰（C10 / §3.6）：按 accountId 返回当前场景要补齐的 ext.role 字段。 */
  extProvider?: RoleSessionFactoryOptions["extProvider"];
  /** 边界审计（R11 / §18.4.4）：mesh_send 被 mesh 拒绝时回调，runtime 写成 boundary_events。 */
  boundaryAudit?: RoleSessionFactoryOptions["boundaryAudit"];
  /**
   * 预建注册表（P3 记忆服务在 createRoleMesh 之前就要拿着注册表闭包反查 owner 分区）；
   * 传入时 createRoleMesh 不再自建，只往里 seed + 回填。缺省自建。
   */
  registry?: RoleAccountRegistry;
  /**
   * 恢复期预置注册表（§4.2.4 / §18.2 恢复链路）：createRuntime 从 DB-A 读出已注册
   * Agent 的 mesh 映射后，在 mesh 装配前回填闭包，使 mesh 恢复 `SessionFactory.open`
   * 的 classify/nameOf 能 O(1) 命中原有 Agent。
   */
  seedRegistry?: RegisteredAgentMeshIds[];
  /**
   * 发言权快照控制器（§3.7 末尾）：与场景编曲器共享的同一实例。runtime 在装配时
   * 新建一个并同时注入 createRoleMesh 与 createSceneOrchestrator；缺省自建仅供
   * 无场景装配路径（如纯 P0 冒烟）。
   */
  floorState?: FloorStateController;
}

export interface RegisterAgentInput {
  agentId: string;
  agentType: "role" | "facility" | "system";
  displayName: string;
  /** 主账号 id；缺省由 mesh 签发 ULID。 */
  accountId?: string;
  /** 自省流账号/端点 id（P4 单独注册；此处只做注册表映射）。 */
  reflectAccountId?: string;
  reflectEndpointId?: string;
}

/**
 * §4.2.1 投影注册：`agents.create()` 第 7 步用它。区别 P0 后门 `registerAgent`——
 * 这里把 `capabilities` / `initiate` / `defaultGrade` / `topology` / `profileRef`
 * 全部作为**编译产物**传入（C1：注册参数不由调用方提供，而由身份编译器算出）。
 */
export interface RegisterProjectionInput {
  agentId: string;
  agentType: "role" | "facility" | "system";
  displayName: string;
  capabilities?: string[];
  initiate?: MessageKind[];
  defaultGrade?: Grade;
  topology: StreamTopology;
  profileRef?: string;
}

export interface ProjectedMeshIds {
  accountId: string;
  endpointId: string;
}

/** P4（§4.4）：注册一条自省流的参数。reflect accountId = `<agentId>:reflect`（命名约定非数据契约）。 */
export interface RegisterReflectInput {
  agentId: string;
  displayName: string;
}

export interface RegisterReflectResult {
  reflectAccountId: string;
  reflectEndpointId: string;
  reflectConversationId: string;
}

export interface RoleMesh {
  mesh: MeshHost;
  registry: RoleAccountRegistry;
  registerAgent(input: RegisterAgentInput): Promise<RegisteredAgentMeshIds>;
  registerProjection(input: RegisterProjectionInput): Promise<ProjectedMeshIds>;
  registerReflect(input: RegisterReflectInput): Promise<RegisterReflectResult>;
  close(): Promise<void>;
}

export async function createRoleMesh(opts: RoleMeshOptions): Promise<RoleMesh> {
  const registry = opts.registry ?? new RoleAccountRegistry();
  for (const rec of opts.seedRegistry ?? []) registry.register(rec);

  const policies = {
    sessionFactory: makeSessionFactory({
      backend: opts.backend,
      classify: (accountId) => registry.kindOf(accountId),
      domainHandlersFor: opts.domainHandlersFor,
      extProvider: opts.extProvider,
      boundaryAudit: opts.boundaryAudit,
    }),
    activation: makeActivationPolicy(),
    floor: makeFloorPolicy(opts.floorState ?? makeFloorStateController()),
    renderer: makeRenderer((accountId) => registry.nameOf(accountId)),
    accessControl: makeAccessControl({
      isReflectAccount: (accountId) => registry.isReflectAccount(accountId),
      baseOfReflect: (reflectAccountId) => registry.baseOfReflect(reflectAccountId),
    }),
    // C11：虚拟时钟槽——mesh 用 LogicalClock.compare 排序信封逻辑时间戳（W<周>D<日>T<时>）。
    clock: makeLogicalClock(),
  };

  const mesh = await createMesh({
    dbPath: opts.dbPath,
    devMode: opts.devMode,
    limits: opts.limits,
    streamPort: opts.streamPort,
    policies,
    // O07：多进程部署透传（缺省 undefined ⇒ mesh 走 InProcess + 单实例排他，行为不变）。
    transport: opts.transport,
    transportOptions: opts.transportOptions,
    recoverDeadEndpoints: opts.recoverDeadEndpoints,
    busyTimeoutMs: opts.busyTimeoutMs,
  });

  async function registerAgent(input: RegisterAgentInput): Promise<RegisteredAgentMeshIds> {
    const isFacility = input.agentType === "facility";
    const account = await mesh.registerAccount({
      id: input.accountId,
      displayName: input.displayName,
      endpointClass: "stream",
      // 角色可发起 chat/task/event；设施 initiate:[] 纯接收（主动发起被 mesh 闸②拦）。
      initiate: isFacility ? [] : ["chat", "task", "event"],
      defaultGrade: isFacility ? "steer" : undefined,
    });
    const endpoint = await mesh.registerEndpoint({
      accountId: account.id,
      topology: { kind: "unified" },
    });
    // §15/A2：角色 Agent 恒在线。presence 缺省 offline 且端点冷启动时 mesh 派生
    // offline ⇒ A2 闸（dnd/offline 不唤醒）让所有 cue 永不触发轮次；本环是 mesh 的
    // 宿主，presence 归宿主宣告。dnd/offline 由上层（L4）经 setPresence 显式覆盖。
    await mesh.setPresence(account.id, "available");
    const rec: RegisteredAgentMeshIds = {
      agentId: input.agentId,
      agentType: input.agentType,
      accountId: account.id,
      endpointId: endpoint.id,
      reflectAccountId: input.reflectAccountId,
      reflectEndpointId: input.reflectEndpointId,
      displayName: input.displayName,
    };
    registry.register(rec);
    return rec;
  }

  // §4.2.1：注册参数全部来自 AgentSpec.mesh 投影（C1）。①② 必须相邻且 ② 紧跟 ①，
  // 否则产出「有账号无端点」的 stream 坏状态（§4.2.2）。
  async function registerProjection(input: RegisterProjectionInput): Promise<ProjectedMeshIds> {
    const account = await mesh.registerAccount({
      id: input.agentId,
      displayName: input.displayName,
      endpointClass: "stream",
      capabilities: input.capabilities ?? [],
      initiate: input.initiate ?? [],
      defaultGrade: input.defaultGrade,
      profileRef: input.profileRef,
    });
    const endpoint = await mesh.registerEndpoint({
      accountId: account.id,
      topology: input.topology,
    });
    // 同 registerAgent：宿主宣告恒在线（§15/A2），否则 cue 永不唤醒。
    await mesh.setPresence(account.id, "available");
    registry.register({
      agentId: input.agentId,
      agentType: input.agentType,
      accountId: account.id,
      endpointId: endpoint.id,
      reflectAccountId: undefined,
      reflectEndpointId: undefined,
      displayName: input.displayName,
    });
    return { accountId: account.id, endpointId: endpoint.id };
  }

  // §4.4：注册自省流（reflect Account/Endpoint + ensureDirect）。reflect 账号 initiate:[]、
  // defaultGrade steer（自省是被 cue 唤醒的接收方，不对外发言）。幂等：注册表已带自省流
  // 映射时跳过 account/endpoint 重建，只重推 ensureDirect（自省流会话 id 不落 DB-A，恢复期
  // 据此重新结回，§4.2.4）。
  async function registerReflect(input: RegisterReflectInput): Promise<RegisterReflectResult> {
    const rec = registry.byAgentId(input.agentId);
    if (!rec) throw new Error(`agent not registered: ${input.agentId}`);
    const existing = rec.reflectAccountId && rec.reflectEndpointId;
    const reflectAccountId = rec.reflectAccountId ?? `${input.agentId}:reflect`;
    let reflectEndpointId = rec.reflectEndpointId ?? "";
    if (!existing) {
      const account = await mesh.registerAccount({
        id: reflectAccountId,
        displayName: `${input.displayName}（自省）`,
        endpointClass: "stream",
        capabilities: [],
        initiate: [],
        defaultGrade: "steer",
      });
      const endpoint = await mesh.registerEndpoint({ accountId: account.id, topology: { kind: "unified" } });
      await mesh.setPresence(account.id, "available");
      reflectEndpointId = endpoint.id;
      registry.attachReflect(input.agentId, account.id, endpoint.id);
    }
    const conv = await mesh.ensureDirect(rec.accountId, reflectAccountId);
    return {
      reflectAccountId,
      reflectEndpointId,
      reflectConversationId: conv.id,
    };
  }

  return { mesh, registry, registerAgent, registerProjection, registerReflect, close: () => mesh.close() };
}