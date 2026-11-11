// ═══════════════════════════════════════════════════════════════════════════
// createRuntime 装配（§2.3 + §12.1）：打开 DB-A → 回填恢复 → 装配 mesh（DB-B）→ 接线事件
//
// 1. openRoleDb：DB-A（封闭表集）迁移 + 断言无 mesh_ 对象（§18.7 P10）。
// 2. loadRegisteredAgents：恢复期从 DB-A 读已注册 Agent，回填 registry 种子 + spec 快照
//    （必须早于 createRoleMesh——mesh 恢复在 createMesh 内触发 SessionFactory.open，
//     彼时 classify/nameOf 要 O(1) 命中，§4.2.4 / §18.2）。
// 3. createRoleMesh：DB-B 交给 mesh，policies 只传 5 槽，其余走默认。
// 4. forwardMeshEvents：15 个 mesh 事件 → onEvent。
// 5. 七个命名空间门面：P1 实装 agents + inspect.dangling；其余空壳留待后续阶段。
//
// 分层纪律（§22.4 #4）：本文件不 import `@pi/agent-mesh`，mesh 类型经 public-types。
// ═══════════════════════════════════════════════════════════════════════════

import { join } from "node:path";

import { assertDistinctDbPaths, openRoleDb } from "../db/db.js";
import { scanDanglingMessages } from "../inspect/dangling-scan.js";
import { costMetricsExcludingReflect } from "../inspect/cost.js";
import { checkMeshConsistency } from "../inspect/mesh-consistency.js";
import { checkRoleInvariants } from "../inspect/invariant-sql.js";
import { buildMemoryTimeline } from "../observe/timeline.js";
import { buildImpressionEvolution } from "../observe/profile-history.js";
import { buildCostView } from "../observe/cost-view.js";
import type { RegisteredAgentMeshIds } from "../mesh/accounts.js";
import { RoleAccountRegistry } from "../mesh/accounts.js";
import { createRoleMesh, type RegisterAgentInput, type RoleMesh } from "../mesh/bootstrap.js";
import { establishPairingAnchor } from "../mesh/pairing.js";
import { readMeshCounterSnapshot } from "../mesh/counters-lookup.js";
import { forwardMeshEvents } from "../mesh/events.js";
import { FakeStreamPort } from "../mesh/fake-stream-port.js";
import type { MeshHost } from "../mesh/public-types.js";
import { createPiBackend } from "../mesh/pi-backend.js";
import type { BeforeCompactHook, SessionBeforeCompactEvent } from "../mesh/session-factory.js";
import { MemoryDao } from "../memory/dao.js";
import { MemoryService } from "../memory/service.js";
import { makeMemoryApi } from "../memory/read-api.js";
import { KnowledgeDao } from "../knowledge/dao.js";
import { KnowledgeService } from "../knowledge/service.js";
import { ReflectionDao } from "../reflect/dao.js";
import { ReflectionService } from "../reflect/service.js";
import { DayEndService } from "../reflect/day-end.js";
import { makeFloorStateController } from "../scene/floor-state.js";
import { createSceneExtRegistry, type SceneExtRegistry } from "../scene/ext-registry.js";
import { createSceneOrchestrator } from "../scene/orchestrator.js";
import { makeHealthGuard, type HealthGuard } from "./health.js";
import { ScenesDao } from "../scene/scenes-dao.js";
import { loadRegisteredAgents, makeAgentApi, type RehydratedAgent } from "./agents.js";
import { makeBlueprintApi } from "./blueprints.js";
import { makeFacilityApi } from "./facilities.js";
import { makeBindingResolver } from "./pi-bindings.js";
import { makeSceneApi } from "./scenes.js";
import { evaluatePairing } from "./pairing.js";
import { makeIdentityDomainTools } from "./identity-tools.js";
import { makeFacilityDomainTools } from "./facility-tools.js";
import { makeBoundaryAudit } from "./boundary-audit.js";
import { makeReplayApi } from "./replay.js";

import type { AgentApi, InspectApi, ReflectApi, RoleInvariantReport, Runtime, RuntimeOptions } from "./types.js";

/**
 * 运行期全量句柄：公开门面 `Runtime` + P0 测试后门（mesh / registry / registerAgent）
 * + P1 恢复快照（agentMeta）。P1 起 `agents.create()` 是正式入口；mesh/registry/registerAgent
 * 收敛为内部实现细节，测试后门随契约测试（P6.4）撤除。
 */
export interface RuntimeInternals extends Runtime {
  agents: AgentApi;
  mesh: MeshHost;
  registry: RoleAccountRegistry;
  /** 恢复期 spec 快照：agentId → 持久化元数据（§4.2.4 / §18.2）。 */
  agentMeta: ReadonlyMap<string, RehydratedAgent>;
  /** 场景位置账本（A19）：编曲器写、extProvider 读；供内部测试观察接线。 */
  sceneExt: SceneExtRegistry;
  /** R31 内部健康哨兵：不依赖宿主 onEvent 的策略降级/不变量观测与记忆停写状态。 */
  health: HealthGuard;
  /** R16/Q02 日终编排（内部）：round-trip 由 scenes.close 触发，供测试观察幂等/分档/降级。 */
  dayEnd: DayEndService;
  registerAgent(input: RegisterAgentInput): Promise<RegisteredAgentMeshIds>;
}

/**
 * 从 compression 范围里抽出角色消息（§15.4 H1）：只取 `custom_message` + `customType
 * === "mesh.msg"` 的条目，其余（工具调用 / 模型切换 / 先前 compaction 摘要）不提炼。
 * M02：durable 端 `toBeforeCompactEvent` 已把 EntryRecord 归一为本形状——`id` 是 mesh 投递的
 * envelopeId（H2 去重键），`content` 是 entry.model 首条 user 消息的原文（交给自省的原文）。
 */
export function extractRoleMessages(event: SessionBeforeCompactEvent): Array<{ msgId: string; text: string }> {
  const out: Array<{ msgId: string; text: string }> = [];
  for (const entry of event.branchEntries) {
    if (entry.type !== "custom_message" || entry.customType !== "mesh.msg") continue;
    const id = entry.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const text = typeof entry.content === "string" ? entry.content : "";
    if (text.trim().length === 0) continue;
    out.push({ msgId: id, text });
  }
  return out;
}

export async function createRuntimeInternals(o: RuntimeOptions): Promise<RuntimeInternals> {
  // §18.7 / R03：副作用前拒绝 role/mesh 双库同路径或同一物理文件（含别名/链接）。
  const meshDbPath = o.meshDb ?? join(o.root, "mesh.db");
  assertDistinctDbPaths(o.db, meshDbPath);

  const roleDb = openRoleDb(o.db, { devMode: o.devMode });

  // R33（§18.2）：双库配对判据——错库/缺锚点此处整体拒绝，先于恢复回填（恢复共用同一判据）。
  const pairing = evaluatePairing(roleDb.db, meshDbPath, o.pairingAnchor);

  // 恢复期（§4.2.4）：mesh 恢复在 createRoleMesh 内先于本环剩余代码跑，故注册表必须现在回填。
  const loaded = loadRegisteredAgents(roleDb.db);
  const agentMeta = new Map<string, RehydratedAgent>();
  const seed: RegisteredAgentMeshIds[] = [];
  for (const a of loaded) {
    agentMeta.set(a.agentId, a);
    if (a.meshAccountId && a.meshEndpointId) {
      seed.push({
        agentId: a.agentId,
        agentType: a.agentType,
        accountId: a.meshAccountId,
        endpointId: a.meshEndpointId,
        reflectAccountId: a.reflectAccountId ?? undefined,
        reflectEndpointId: a.reflectEndpointId ?? undefined,
        displayName: a.displayName ?? undefined,
      });
    }
  }

  // 逐账号绑定解析器（P1 · §3.7 ①）：create() 路径经 onCreated 塞现成的编译产物，
  // 恢复路径（mesh 在 createRoleMesh 内先触发 open）则从 agentMeta 重编译 system prompt。
  const bindings = makeBindingResolver(o.root, agentMeta);

  // 发言权快照控制器（§3.7 末尾）：floor 策略槽与场景编曲器共享的同一实例。
  const floorState = makeFloorStateController();

  // 场景位置账本（A19 完整接线）：编曲器写、mesh_send 装饰的 extProvider 读的同一实例。
  const sceneExt = createSceneExtRegistry();

  // 注册表预建（P3）：记忆服务要在 createRoleMesh 之前就拿着同一个注册表闭包，
  // 反查 owner 分区（accountId → agentId）。createRoleMesh 往里 seed + 后续回填。
  const registry = new RoleAccountRegistry();
  // R31 内部健康哨兵：先于 MemoryService 建立，write-block 门在构造期注入；事件订阅
  // 在 createRoleMesh 之后（那时才有 mesh.on）。
  const health: HealthGuard = makeHealthGuard();
  const memoryDao = new MemoryDao(roleDb.db, { nowReal: () => new Date().toISOString() });
  const nowReal = () => new Date().toISOString();
  const knowledgeDao = new KnowledgeDao(roleDb.db, { nowReal });
  const knowledge = new KnowledgeService({
    dao: knowledgeDao,
    knownAgents: () => new Set(registry.allAgentIds()),
  });
  const memory = new MemoryService({
    dao: memoryDao,
    registry,
    knowledge,
    policyOf: (accountId) => bindings.memoryPolicyOf(accountId),
    // R31：健康哨兵在构造期即注入；fail-closed 时记忆服务统一停写（不依赖宿主 onEvent）。
    writesAllowed: () => health.writesAllowed(),
  });
  // 自省（P4）：与记忆服务同 registry / 同 db，复用一个 MemoryDao 写巩固与自我洞察。
  // R34：usageForReflect 是晚绑定闭包（backend 在其后创建）——只在反射落地时才会被调用，
  // 届时 backend 已就绪；fake/无 LLM 时 backend 为 undefined，退回零快照，不量、不上抛。
  const reflection = new ReflectionService({
    dao: new ReflectionDao({ db: roleDb.db, nowReal }),
    memoryDao,
    knowledge,
    registry,
    policyOf: (accountId) => bindings.memoryPolicyOf(accountId),
    usageForReflect: (accountId) =>
      backend !== undefined
        ? backend.usageBreakdownFor(accountId)
        : Promise.resolve({ tokensIn: 0, tokensOut: 0, totalTokens: 0 }),
    onCost: o.onCost,
  });
  // R16/Q02 日终编排：复用记忆衰减 + 自省 + 知识衰减 + 队列整理，唯一写者 = 本服务（S05）。
  const dayEnd = new DayEndService({
    db: roleDb.db,
    memoryDao,
    knowledge,
    reflection,
    registry,
    policyOf: (accountId) => bindings.memoryPolicyOf(accountId),
  });

  // 会话后端：real pi（逐账号模型/提示绑定）除非显式 `fake.sessions`。独立成变量以便 A07 把
  // 同一 backend 实例的 usageBreakdownFor 回读接线到场景预算（真实用量驱动熔断 + onCost 分账）。
  // let：reflection 的 usageForReflect 闭包晚绑定引用它（构造在前、赋值在后，调用时已就绪）。
  let backend: ReturnType<typeof createPiBackend> | undefined = o.fake?.sessions
    ? undefined
    : createPiBackend({
        resolveBinding: (accountId) => bindings.resolve(accountId),
        credentialFor: o.credentialFor,
        contextHookFor: (accountId) => memory.contextHookFor(accountId),
        beforeCompactFor: (accountId) => {
          // 只对角色主 Account 挂抢救钩子；设施/自省流/系统账号无需提炼（§15.4）。
          const rec = registry.byAccountId(accountId);
          if (!rec || rec.agentType !== "role" || rec.reflectAccountId === accountId) return undefined;
          const hook: BeforeCompactHook = async (event) => {
            const messages = extractRoleMessages(event);
            if (messages.length === 0) return;
            // 虚拟时间这里取 reflection 的默认起点：钩子发生在压缩时刻，本环无 per-agent 全局
            // 虚拟时钟可读（§10.5 的「抽取时刻虚拟时钟」需场景生命周期接线后才有权威值）。
            await reflection.harvest(rec.agentId, { messages });
          };
          return hook;
        },
      });

  const roleMesh: RoleMesh = await createRoleMesh({
    dbPath: meshDbPath,
    devMode: o.devMode,
    limits: o.limits,
    streamPort: o.fake?.streamPort ? new FakeStreamPort() : undefined,
    // O07：多进程部署透传（缺省 undefined ⇒ 单实例排他，行为不变）。
    transport: o.mesh?.transport,
    transportOptions: o.mesh?.transportOptions,
    recoverDeadEndpoints: o.mesh?.recoverDeadEndpoints,
    busyTimeoutMs: o.mesh?.busyTimeoutMs,
    seedRegistry: seed,
    floorState,
    registry,
    // R11 边界审计：mesh_send 被 mesh 以附录 D reject 十项之一拒绝时，写成一条 boundary_events。
    boundaryAudit: makeBoundaryAudit({ db: roleDb.db, registry, now: nowReal }),
    domainHandlersFor: async (accountId) => {
      // 自省流只挂 reflect_result；设施流挂四设施工具；对话流挂 remember/recall/note_self +
      // identity_read / protocol_query（§3.8 分叉 / R08 / R11）。owner 在装配期烤入本人 id。
      const kind = registry.kindOf(accountId);
      if (kind === "reflect") return reflection.reflectResultHandlerFor(accountId);
      if (kind === "facility") {
        const facility = registry.byAccountId(accountId);
        if (!facility) return {};
        return makeFacilityDomainTools({
          db: roleDb.db,
          root: o.root,
          facilityId: facility.agentId,
          now: nowReal,
        });
      }
      const memoryHandlers = await memory.domainHandlersFor(accountId);
      const rec = registry.byAccountId(accountId);
      if (!rec) return memoryHandlers;
      const identityHandlers = makeIdentityDomainTools({
        db: roleDb.db,
        root: o.root,
        agentId: rec.agentId,
      });
      return { ...memoryHandlers, ...identityHandlers };
    },
    // A19：mesh_send 装饰补齐三字段的来源——本环同一账本，sceneId/turn/virtualTs 在
    // 编曲器 cue 前写入；账号不在场景时退 {}（非场景事件无 sceneId）。
    extProvider: (accountId) => sceneExt.extFor(accountId) ?? {},
    backend,
  });

  memory.attach(roleMesh.mesh);
  reflection.attach(roleMesh.mesh);
  // R19 重启恢复：启动即终结上次进程崩溃遗留的 running 自省批（failed/interrupted），
  //   不伪造完成；A21 成功游标只认 done，这些批的证据窗会由下次 maybe 重新成批。
  reflection.recoverInterrupted();

  // R33（§18.2）：空库/首启（无映射且无锚点）时在此建立配对锚点账号；其后所有已注册
  // 映射都会带上 mesh_instance_tag = 配对 id，读取路径据此回读核对。错库已在上面拒绝。
  if (pairing.state === "vacant") {
    await establishPairingAnchor(roleMesh.mesh, pairing.pairing.anchorAccount, pairing.pairing.pairingId);
  }

  const unsubEvents = forwardMeshEvents(roleMesh.mesh, o.onEvent);

  // R31：内部健康保护独立于宿主 onEvent——无条件订阅 policy_degraded / invariant_violated，
  //   fail-closed 判定与记忆停写不依赖可选转发回调（§26.1 三条必订事件之二；其一
  //   message_consumed 已由 MemoryService.attach 接住）。
  const unsubHealth: Array<() => void> = [
    roleMesh.mesh.on("policy_degraded", (p) => health.onPolicyDegraded(p)),
    roleMesh.mesh.on("invariant_violated", (p) => health.onInvariantViolated(p)),
  ];

  const inspect: InspectApi = {
    async checkInvariants() {
      const roleReport = checkRoleInvariants(roleDb.db);
      return { mesh: await roleMesh.mesh.observer.checkInvariants(), role: roleReport };
    },
    async checkMeshConsistency() {
      return checkMeshConsistency(roleDb.db, o.root);
    },
    async scanDanglingMessages(opts) {
      return scanDanglingMessages(roleDb.db, meshDbPath, opts);
    },
    async costMetrics(opts) {
      return costMetricsExcludingReflect(roleDb.db, meshDbPath, opts);
    },
    async memoryTimeline(ownerAgent, opts) {
      return buildMemoryTimeline(roleDb.db, meshDbPath, ownerAgent, opts);
    },
    async impressionEvolution(ownerAgent, subjectType, subjectId) {
      return buildImpressionEvolution(roleDb.db, ownerAgent, subjectType, subjectId);
    },
    async costView(opts) {
      const meshCounters = await readMeshCounterSnapshot(
        roleMesh.mesh.observer,
        opts?.since,
      );
      return buildCostView(roleDb.db, meshDbPath, { ...opts, meshCounters });
    },
  };

  const agents: AgentApi = makeAgentApi(
    {
      root: o.root,
      roleDb: roleDb.db,
      knowledge,
      pairingId: pairing.pairing.pairingId,
      registerProjection: (input) => roleMesh.registerProjection(input),
      registerReflect: (input) => roleMesh.registerReflect(input),
      modelDefaults: o.modelDefaults,
      onModelConfigUpdated: (input) => bindings.applyModelConfig(input),
      onRespec: (input) =>
        bindings.register(input.agentId, input.spec, { reflectAccountId: input.reflectAccountId ?? undefined }),
    },
    (r) => {
      // create 成功后注册编译产物绑定（system prompt 现成，直塞缓存，免重编译 §18.2.1）。
      // A03：一并对自省流账号注册绑定（独立 reflection 模型），避免 resolve(A:reflect) 落空。
      bindings.register(r.agentId, r.spec, { reflectAccountId: r.mesh.reflectAccountId });
      o.onEvent?.({
        type: "agent_registered",
        agentId: r.agentId,
        agentType: "role",
        accountId: r.mesh.accountId,
        endpointId: r.mesh.endpointId,
        reflectAccountId: r.mesh.reflectAccountId,
      });
    },
  );

  async function registerAgent(input: RegisterAgentInput): Promise<RegisteredAgentMeshIds> {
    const rec = await roleMesh.registerAgent(input);
    o.onEvent?.({
      type: "agent_registered",
      agentId: rec.agentId,
      agentType: rec.agentType,
      accountId: rec.accountId,
      endpointId: rec.endpointId,
      reflectAccountId: rec.reflectAccountId,
    });
    return rec;
  }

  // ── 场景 + 设施门面（P2 · §7 / §3.2）──
  const scenes = makeSceneApi({
    registry: roleMesh.registry,
    orchestrator: createSceneOrchestrator({
      mesh: roleMesh.mesh,
      dao: new ScenesDao(roleDb.db),
      floorState,
      extRegistry: sceneExt,
      usageForTurn: o.fake?.usageForTurn,
      // A07：真实场景用量——同一 backend 实例的 harness.usage 回读（累计 usage，σ 桶），
      // 编曲器做差得每轮增量，驱动预算熔断并分 input/output 上抛 onCost。fake/无 LLM 时
      // backend undefined → 不注入（保持 P2 无 LLM 语义）。
      usageTotalFor: backend ? (addressee) => backend.usageBreakdownFor(addressee) : undefined,
      onCost: o.onCost,
      // R16/Q02：close 收敛在途后调日终；箭头闭包保住 this（DayEndRunner 见 scene/types）。
      dayEnd: (opts) => dayEnd.runForScene(opts),
      // R30/G4 devMode 关场校验：close 在日终后跑一遍 A1–A11（含 A2'）分区不变量；
      // 生产（非 devMode）不注入 → 跳过自检，只返回 SceneRunResult.invariantViolations=[]。
      invariantCheck: o.devMode ? () => checkRoleInvariants(roleDb.db).violations : undefined,
    }),
  });

  const facilities = makeFacilityApi(
    {
      root: o.root,
      roleDb: roleDb.db,
      modelDefaults: o.modelDefaults,
      pairingId: pairing.pairing.pairingId,
      registerProjection: (input) => roleMesh.registerProjection(input),
    },
    (r) => {
      o.onEvent?.({
        type: "agent_registered",
        agentId: r.facilityId,
        agentType: "facility",
        accountId: r.accountId,
        endpointId: r.endpointId,
      });
    },
  );

  // ── 自省门面（P4 · §13）──
  const reflect: ReflectApi = {
    run: (agentId, opts) => reflection.run(agentId, opts ?? { trigger: "manual" }),
    maybe: (agentId, trigger, opts) => reflection.maybe(agentId, trigger, opts),
    runAll: (opts) => reflection.runAll(opts),
    read: (agentId) => reflection.read(agentId),
  };

  let closePromise: Promise<void> | undefined;
  // A37：关闭按阶段推进，各阶段只在「成功」后打上完成标记——中途失败（如 roleMesh.close()
  // 抛错但 roleDb 尚未关）时，第二次 close() 重跑 doClose、只重试还没成功的阶段。旧实现把
  // 首个失败的 promise 永久缓存，第二次 close 直接返回同一拒绝 promise，资源无法重试释放。
  let unsubDone = false;
  let meshClosed = false;
  let roleDbClosed = false;

  async function doClose(): Promise<void> {
    let firstErr: unknown;
    const guard = async (run: () => void | Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        firstErr ??= err;
      }
    };
    // M04/A37：mesh v0.2.0 close() 自行等在途 handoff 收敛（port.status(id).inFlight）后释放
    // 端口/实例锁/库，再抛首个错误。旧 consumeUndrainedDeliveries 把 delivered 全标 consumed
    // 属伪造消费，已随 drain.ts 移除。这里闭环：任一步失败仍继续关 roleDb，首个错误在全部
    // 收尾后重抛；失败的阶段可在下一次 close 重试，连接最终释放。
    await guard(() => {
      if (!unsubDone) {
        unsubEvents();
        for (const u of unsubHealth) u();
        unsubHealth.length = 0;
        unsubDone = true;
      }
    });
    await guard(async () => {
      if (!meshClosed) {
        await roleMesh.close();
        meshClosed = true;
      }
    });
    await guard(async () => {
      if (!roleDbClosed) {
        roleDb.close();
        roleDbClosed = true;
      }
    });
    if (firstErr) throw firstErr;
  }

  const runtime: RuntimeInternals = {
    blueprints: makeBlueprintApi({ root: o.root }),
    agents,
    facilities,
    scenes,
    reflect,
    memory: makeMemoryApi(roleDb.db, memoryDao),
    inspect,
    replay: makeReplayApi(roleDb.db),
    agentMeta,
    sceneExt,
    health,
    dayEnd,
    mesh: roleMesh.mesh,
    registry: roleMesh.registry,
    registerAgent,
    close() {
      if (!closePromise) {
        closePromise = doClose().catch((err) => {
          // A37：失败后清空缓存，下一次 close() 重跑 doClose 释放尚未成功的资源；并发 close
          // 复用同一在途 promise（不会并行关两次）。
          closePromise = undefined;
          throw err;
        });
      }
      return closePromise;
    },
  };

  return runtime;
}

/**
 * 公开入口（R01 / §2.3）：只返回 `Runtime` 门面——mesh / registry / registerAgent /
 * agentMeta / sceneExt / health / dayEnd 等内部句柄不进入返回值，JavaScript 宿主亦无法触达。
 * 内部测试经 `createRuntimeInternals`（本文件导出，非 index）取得全量句柄。
 */
export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  const r = await createRuntimeInternals(o);
  return {
    blueprints: r.blueprints,
    agents: r.agents,
    facilities: r.facilities,
    scenes: r.scenes,
    reflect: r.reflect,
    memory: r.memory,
    inspect: r.inspect,
    replay: r.replay,
    close: r.close,
  };
}