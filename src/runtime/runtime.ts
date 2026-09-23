// ═══════════════════════════════════════════════════════════════════════════
// createRuntime 装配（§2.3 + §12.1）：打开 DB-A → 回填恢复 → 装配 mesh（DB-B）→ 接线事件
//
// 1. openRoleDb：DB-A（14 张表）迁移 + 断言无 mesh_ 对象（§18.7 P10）。
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

import { openRoleDb } from "../db/db.js";
import { scanDanglingMessages } from "../inspect/dangling-scan.js";
import { costMetricsExcludingReflect } from "../inspect/cost.js";
import { checkRoleInvariants } from "../inspect/invariant-sql.js";
import { buildMemoryTimeline } from "../observe/timeline.js";
import { buildImpressionEvolution } from "../observe/profile-history.js";
import { buildCostView } from "../observe/cost-view.js";
import type { RegisteredAgentMeshIds } from "../mesh/accounts.js";
import { RoleAccountRegistry } from "../mesh/accounts.js";
import { createRoleMesh, type RegisterAgentInput, type RoleMesh } from "../mesh/bootstrap.js";
import { consumeUndrainedDeliveries } from "../mesh/drain.js";
import { readMeshCounterSnapshot } from "../mesh/counters-lookup.js";
import { forwardMeshEvents } from "../mesh/events.js";
import { FakeStreamPort } from "../mesh/fake-stream-port.js";
import type { MeshHost } from "../mesh/public-types.js";
import { createPiBackend } from "../mesh/pi-backend.js";
import type { BeforeCompactHook, SessionBeforeCompactEvent } from "../mesh/session-factory.js";
import { MemoryDao } from "../memory/dao.js";
import { MemoryService } from "../memory/service.js";
import { KnowledgeDao } from "../knowledge/dao.js";
import { KnowledgeService } from "../knowledge/service.js";
import { ReflectionDao } from "../reflect/dao.js";
import { ReflectionService } from "../reflect/service.js";
import { makeFloorStateController } from "../scene/floor-state.js";
import { createSceneOrchestrator } from "../scene/orchestrator.js";
import { ScenesDao } from "../scene/scenes-dao.js";
import { loadRegisteredAgents, makeAgentApi, type RehydratedAgent } from "./agents.js";
import { makeBlueprintApi } from "./blueprints.js";
import { makeFacilityApi } from "./facilities.js";
import { makeBindingResolver } from "./pi-bindings.js";
import { makeSceneApi } from "./scenes.js";

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
  registerAgent(input: RegisterAgentInput): Promise<RegisteredAgentMeshIds>;
}

/**
 * 从 compression 范围里抽出角色消息（§15.4 H1）：只取 `custom_message` + `customType
 * === "mesh.msg"` 的条目，其余（工具调用 / 模型切换 / 先前 compaction 摘要）不提炼。
 * mesh 条目的 details 是 `{ envelope }`，msg id 用于 H2 去重，text 是交给自省流提炼的原文。
 */
function extractRoleMessages(event: SessionBeforeCompactEvent): Array<{ msgId: string; text: string }> {
  const out: Array<{ msgId: string; text: string }> = [];
  for (const entry of event.branchEntries) {
    if (entry.type !== "custom_message" || entry.customType !== "mesh.msg") continue;
    const details = entry.details as { envelope?: { id?: unknown; payload?: { text?: unknown } } } | undefined;
    const envelope = details?.envelope;
    const id = envelope?.id;
    if (typeof id !== "string") continue;
    const text = typeof envelope?.payload?.text === "string" ? envelope.payload.text : "";
    if (text.trim().length === 0) continue;
    out.push({ msgId: id, text });
  }
  return out;
}

export async function createRuntime(o: RuntimeOptions): Promise<RuntimeInternals> {
  const roleDb = openRoleDb(o.db, { devMode: o.devMode });
  const meshDbPath = o.meshDb ?? join(o.root, "mesh.db");

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

  // 注册表预建（P3）：记忆服务要在 createRoleMesh 之前就拿着同一个注册表闭包，
  // 反查 owner 分区（accountId → agentId）。createRoleMesh 往里 seed + 后续回填。
  const registry = new RoleAccountRegistry();
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
  });
  // 自省（P4）：与记忆服务同 registry / 同 db，复用一个 MemoryDao 写巩固与自我洞察。
  const reflection = new ReflectionService({
    dao: new ReflectionDao({ db: roleDb.db, nowReal }),
    memoryDao,
    knowledge,
    registry,
    policyOf: (accountId) => bindings.memoryPolicyOf(accountId),
  });

  const roleMesh: RoleMesh = await createRoleMesh({
    dbPath: meshDbPath,
    devMode: o.devMode,
    limits: o.limits,
    streamPort: o.fake?.streamPort ? new FakeStreamPort() : undefined,
    seedRegistry: seed,
    floorState,
    registry,
    domainHandlersFor: async (accountId) => {
      // 自省流只挂 reflect_result；对话流挂 remember/recall（§3.8 分叉）。
      if (registry.kindOf(accountId) === "reflect") return reflection.reflectResultHandlerFor(accountId);
      return memory.domainHandlersFor(accountId);
    },
    // 会话后端：real pi（逐账号模型/提示绑定）除非显式 `fake.sessions`。
    // `fake.streamPort` 用 FakeStreamPort，session 工厂根本不会被调用，后端惰性无害。
    backend: o.fake?.sessions ? undefined : createPiBackend({
      resolveBinding: (accountId) => bindings.resolve(accountId),
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
    }),
  });

  memory.attach(roleMesh.mesh);
  reflection.attach(roleMesh.mesh);

  const unsubEvents = forwardMeshEvents(roleMesh.mesh, o.onEvent);

  const inspect: InspectApi = {
    async checkInvariants() {
      const roleReport = checkRoleInvariants(roleDb.db);
      return { mesh: await roleMesh.mesh.observer.checkInvariants(), role: roleReport };
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
      registerProjection: (input) => roleMesh.registerProjection(input),
      registerReflect: (input) => roleMesh.registerReflect(input),
      modelDefaults: o.modelDefaults,
    },
    (r) => {
      // create 成功后注册编译产物绑定（system prompt 现成，直塞缓存，免重编译 §18.2.1）。
      bindings.register(r.agentId, r.spec);
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
      // abort（I22）走 beforeClearQueue：被点名者 accountId → 主 Endpoint（注册表闭包 O(1)）。
      endpointOf: (accountId) => roleMesh.registry.byAccountId(accountId)?.endpointId,
    }),
  });

  const facilities = makeFacilityApi({
    registerAgent: (input) => registerAgent(input),
  });

  // ── 自省门面（P4 · §13）──
  const reflect: ReflectApi = {
    run: (agentId, opts) => reflection.run(agentId, opts ?? { trigger: "manual" }),
    maybe: (agentId, trigger, opts) => reflection.maybe(agentId, trigger, opts),
    runAll: (opts) => reflection.runAll(opts),
    read: (agentId) => reflection.read(agentId),
  };

  let closed = false;
  const runtime: RuntimeInternals = {
    blueprints: makeBlueprintApi({ root: o.root }),
    agents,
    facilities,
    scenes,
    reflect,
    memory: {},
    inspect,
    agentMeta,
    mesh: roleMesh.mesh,
    registry: roleMesh.registry,
    registerAgent,
    async close() {
      if (closed) return;
      closed = true;
      unsubEvents();
      // §12.1 排残：observer/silent 投递恒无 turn_end，delivered 残余不经宿主结清
      // 会让 mesh.close() 白等整个 handoffTimeoutMs（详见 mesh/drain.ts）。
      await consumeUndrainedDeliveries(roleMesh.mesh, meshDbPath);
      await roleMesh.close();
      roleDb.close();
    },
  };

  return runtime;
}