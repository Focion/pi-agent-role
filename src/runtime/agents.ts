// ═══════════════════════════════════════════════════════════════════════════
// agents 命名空间（§4.2 八步）—— 创建角色 Agent 的唯一编排点
//
// create() = 校验 → 物化(C5) → 解析模型(C6) → 编译(§5.1) → 指纹 → 落库(单事务)
//            → 注册 mesh dialogue Account/Endpoint(§4.2.1) → 回写映射转正。
// 第 7 步之后的失败只能前向恢复（§4.2.4，mesh 无删账号 API），由 reconcileRegistrations
// 幂等补齐；自省流（reflect Account/Endpoint/ensureDirect）在 P4 单独注册。
//
// 本文件属于 `src/runtime/**`：不得 import `@pi/agent-mesh`（§22.4 #4）。mesh 注册
// 经 runtime.ts 注入的 registerProjection 闭包触达，类型经 `../mesh/bootstrap.js` 再出口。
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import type Database from "better-sqlite3";

import { fingerprintOf, sha256Hex } from "../compile/fingerprint.js";
import { compileIdentity } from "../compile/identity-loader.js";
import { materialize } from "../compile/materialize.js";
import { applyRuntimeModelOverride, resolveModelConfig } from "../compile/model-resolver.js";
import { assertSafeSegment } from "../compile/path-guard.js";
import { SPEC_VERSION, diffMeshProjection } from "../compile/types.js";
import type {
  AgentSpec,
  AgentSpecMeshProjection,
  ModelConfig,
  ModelConfigOverride,
  ModelConfigSource,
} from "../compile/types.js";
import { COMPILER_VERSION } from "../compile/version.js";
import { readYamlFile } from "../compile/yaml.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { ProjectedMeshIds, RegisterProjectionInput, RegisterReflectInput } from "../mesh/bootstrap.js";
import { BlueprintNotFound, SpecVersionMismatch, ValidationError } from "./errors.js";
import { reconcile, reproject } from "./projector.js";
import type {
  CreateAgentInput,
  CreateAgentResult,
  CreateBatchItemResult,
  DeleteAgentResult,
  ReconcileRegistrationResult,
  RespecResult,
  RestoreResult,
  RetireResult,
  SetModelConfigResult,
} from "./types.js";

/** 蓝本内可选的模型默认文件（§5.4 第 2 层 blueprint）。 */
const MODEL_DEFAULTS_FILE = "model_defaults.yaml";

/** 恢复期从 DB-A 读出的一个已注册 Agent（§18.2 注册组）。 */
export interface RehydratedAgent {
  agentId: string;
  agentType: "role" | "facility" | "system";
  identityId: string | null;
  blueprintDir: string;
  blueprintHash: string;
  identityDir: string | null;
  role: string | null;
  displayName: string | null;
  modelConfig: ModelConfig;
  modelConfigSource: ModelConfigSource;
  specHash: string | null;
  status: string;
  meshAccountId: string | null;
  meshEndpointId: string | null;
  reflectAccountId: string | null;
  reflectEndpointId: string | null;
}

export interface AgentApiDeps {
  root: string;
  roleDb: Database.Database;
  /** 知识种入（§17.4 来源 1：academic.yaml 薄弱项 → knowledge_items）。 */
  knowledge: KnowledgeService;
  /** R33 双库配对标识：create() 落库时写进 agents.mesh_instance_tag，供读取路径核对。 */
  pairingId: string;
  registerProjection(input: RegisterProjectionInput): Promise<ProjectedMeshIds>;
  registerReflect(input: RegisterReflectInput): Promise<{
    reflectAccountId: string;
    reflectEndpointId: string;
    reflectConversationId: string;
  }>;
  modelDefaults?: Partial<ModelConfig>;
  now?: () => string;
  /** R06 setModelConfig：写完模型覆盖后同步内存（agentMeta + 已缓存主/自省绑定），安全 evict/warm。 */
  onModelConfigUpdated(input: {
    agentId: string;
    modelConfig: ModelConfig;
    mainAccountId: string | null;
    reflectAccountId: string | null;
  }): void;
  /** R10 respec：重编译 spec 后同步内存绑定（新的 system prompt 立即生效，主/自省同源）。可选：
   *  单测可省略，只验证 DB 快照路径；宿主装配时必接 bindings.register。 */
  onRespec?(input: { agentId: string; spec: AgentSpec; reflectAccountId: string | null }): void;
}

/** §9.4 spec 指纹：覆盖 assemble() 的全部输入（systemPrompt+model+thinkingLevel+customTools+settings）。 */
export function specHashOf(spec: AgentSpec): string {
  return fingerprintOf([
    spec.promptVersion,
    spec.systemPrompt,
    JSON.stringify(spec.modelConfig),
    JSON.stringify(spec.toolPolicy),
    JSON.stringify(spec.constraints),
    JSON.stringify(spec.protocol),
    JSON.stringify(spec.mesh),
    JSON.stringify(spec.memoryPolicy),
    JSON.stringify(spec.initialState),
  ]);
}

/** 参与编译的落地文件：冷启动 6 个 + 按需段（§5.1）。spec_path 统一带 `.yaml` 后缀。 */
function compiledFiles(spec: AgentSpec): Array<{ path: string; kind: "cold_start" | "lazy" }> {
  const files: Array<{ path: string; kind: "cold_start" | "lazy" }> = spec.coldStartFiles.map((n) => ({
    path: `${n}.yaml`,
    kind: "cold_start" as const,
  }));
  for (const ls of spec.lazySections) files.push({ path: `${ls.section}.yaml`, kind: "lazy" });
  return files;
}

/** 逐文件落 agent_specs 快照（create 与 respec 共用）。content 恒 NULL（不存全文，§18.2.1）。
 *  idempotent：主键 (agent_id, spec_path) 冲突时更新 hash/kind。 */
function writeSpecRows(
  db: Database.Database,
  agentId: string,
  spec: AgentSpec,
  identityDir: string,
  now: string,
): void {
  const upsert = db.prepare(
    `INSERT INTO agent_specs (agent_id, spec_path, spec_hash, spec_kind, content, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(agent_id, spec_path) DO UPDATE
       SET spec_hash = excluded.spec_hash, spec_kind = excluded.spec_kind, updated_at = excluded.updated_at`,
  );
  for (const f of compiledFiles(spec)) {
    const p = join(identityDir, f.path);
    const hash = existsSync(p) ? sha256Hex(readFileSync(p)) : "";
    upsert.run(agentId, f.path, hash, f.kind, now);
  }
}

/** 写注册组生命周期审计（state_writes target='agent'）：退役/恢复/删除/respec 都留一行谁在何时改了什么。 */
function writeLifecycleAudit(
  db: Database.Database,
  agentId: string,
  op: "respec" | "retire" | "restore" | "delete",
  before: unknown,
  after: unknown,
  now: string,
): void {
  db.prepare(
    `INSERT INTO state_writes
       (write_id, owner_agent, target, target_id, op, reason, before_json, after_json, actor, real_ts)
     VALUES (?, ?, 'agent', ?, ?, NULL, ?, ?, 'host', ?)`,
  ).run(
    randomUUID(),
    agentId,
    agentId,
    op,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    now,
  );
}

/** 步骤 1 之前：解析蓝本目录。相对 path 以 root 为基；不存在抛 BlueprintNotFound。 */
function resolveBlueprintDir(root: string, blueprint: string): string {
  const dir = isAbsolute(blueprint) ? blueprint : join(root, blueprint);
  if (!existsSync(dir)) throw new BlueprintNotFound(blueprint);
  return dir;
}

async function runCreate(
  input: CreateAgentInput,
  deps: AgentApiDeps,
): Promise<{ result: CreateAgentResult; spec: AgentSpec }> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const db = deps.roleDb;

  // 幂等/独占：agentId 已存在即拒绝（§4.2.3 本环是映射唯一持有方）。
  const existing = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(input.agentId);
  if (existing) throw new ValidationError(`agent already exists: ${input.agentId}`);

  // 步骤 1–2：解析蓝本 → 物化实例模板（C5）。物化自身失败时目录未成，无需清理。
  const blueprintDir = resolveBlueprintDir(deps.root, input.blueprint);
  const overlay = input.overlay as Record<string, unknown> | undefined;
  const mat = await materialize({
    blueprintDir,
    root: deps.root,
    agentId: input.agentId,
    overlay,
  });

  // 步骤 3–6：解析模型 → 编译 → 指纹 → 单事务落库。这一区间失败可整体真回滚（§4.2.4
  // 前 6 步）：删目录，不留任何本环痕迹。
  let spec: AgentSpec;
  let modelConfig: ModelConfig;
  let source: ModelConfigSource;
  let displayName: string;
  let specHash: string;
  // A05：注册意图在落库前就算好——即便第 7/7.5 步（mesh 注册）失败，DB 也保留完整投影，
  // reconcile 凭它前向补齐，而不是靠删角色行重建。
  let projection: AgentSpec["mesh"];
  try {
    const blueprintModelDefaults = readYamlFile<Partial<ModelConfig>>(
      join(blueprintDir, MODEL_DEFAULTS_FILE),
      { optional: true, label: `${blueprintDir}/${MODEL_DEFAULTS_FILE}` },
    );
    const resolved = resolveModelConfig({
      runtimeDefault: deps.modelDefaults,
      blueprint: blueprintModelDefaults,
      createArg: { model: input.model, reflectModel: input.reflectModel, tokenBudget: input.tokenBudget },
    });
    modelConfig = resolved.modelConfig;
    source = resolved.source;

    // 步骤 4–5：编译（源是实例模板而非蓝本，§4.2 步骤 4）+ promptVersion 指纹。
    spec = await compileIdentity(mat.identityDir, {
      agentId: input.agentId,
      modelConfig,
      compilerVersion: COMPILER_VERSION,
    });
    displayName = input.displayName ?? spec.mesh.displayName;
    specHash = specHashOf(spec);
    projection = { ...spec.mesh, displayName };

    // 步骤 6：单事务写 agents + agent_specs + agent_state，status='registering'。
    const identityDirRel = relative(deps.root, mat.identityDir);
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO agents
           (agent_id, agent_type, identity_id, blueprint_dir, blueprint_hash, overlay_json,
            identity_dir, projected_at, role, display_name,
            model_config_json, model_config_source_json, model_preset, registered_projection,
            spec_hash, mesh_instance_tag, status, created_at)
         VALUES (?, 'role', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, 'registering', ?)`,
      ).run(
        input.agentId,
        spec.identityId,
        input.blueprint,
        mat.blueprintHash,
        input.overlay !== undefined ? JSON.stringify(input.overlay) : null,
        identityDirRel,
        now,
        displayName,
        JSON.stringify(modelConfig),
        JSON.stringify(source),
        JSON.stringify(projection),
        specHash,
        deps.pairingId,
        now,
      );

      writeSpecRows(db, input.agentId, spec, mat.identityDir, now);

      const insState = db.prepare(
        `INSERT INTO agent_state (agent_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)`,
      );
      const st = spec.initialState;
      insState.run(input.agentId, "mood", JSON.stringify(st.mood), now);
      insState.run(input.agentId, "mood_intensity", JSON.stringify(st.moodIntensity), now);
      insState.run(input.agentId, "energy", JSON.stringify(st.energy), now);
      insState.run(input.agentId, "trust_defaults", JSON.stringify(st.trustDefaults), now);
      insState.run(input.agentId, "knowledge_seed", JSON.stringify(st.knowledgeSeed), now);

      // §17.4 来源 1：薄弱项种入知识表（幂等）——与 agents 落库同事务，全有或全无。
      deps.knowledge.seedFromTemplate(input.agentId, st.knowledgeSeed);
    });
    tx();
  } catch (err) {
    // 步骤 3–6 真回滚：删物化目录。落库在单事务内，SQLite 已保证无半行。
    rmSync(mat.identityDir, { recursive: true, force: true });
    throw err;
  }

  // 步骤 7：注册 mesh dialogue Account/Endpoint（identity 编译器 → stream/unified，§4.2.1）。
  const projected = await deps.registerProjection({
    agentId: input.agentId,
    agentType: "role",
    displayName,
    capabilities: projection.capabilities,
    initiate: projection.initiate,
    defaultGrade: projection.defaultGrade,
    topology: projection.topology,
    profileRef: projection.profileRef,
  });

  // 步骤 7.5：注册自省流（reflect Account/Endpoint/ensureDirect，§4.4）。与第 7 步同属
  // 「注册 mesh」区间——本步失败只能前向恢复（reconcile 补自省流）。
  const reflected = await deps.registerReflect({ agentId: input.agentId, displayName });

  // 步骤 8：回写映射 + 转正（§4.2.4：本步失败 → 前向恢复，不回滚）。
  db.prepare(
    `UPDATE agents
       SET mesh_account_id = ?, mesh_endpoint_id = ?, mesh_registered_at = ?,
           mesh_reflect_account_id = ?, mesh_reflect_endpoint_id = ?,
           registered_projection = ?, status = 'active'
     WHERE agent_id = ?`,
  ).run(
    projected.accountId,
    projected.endpointId,
    now,
    reflected.reflectAccountId,
    reflected.reflectEndpointId,
    JSON.stringify(projection),
    input.agentId,
  );

  const result: CreateAgentResult = {
    agentId: input.agentId,
    promptVersion: spec.promptVersion,
    blueprintId: basename(blueprintDir),
    blueprintHash: mat.blueprintHash,
    modelConfig,
    modelConfigSource: source,
    mesh: {
      accountId: projected.accountId,
      endpointId: projected.endpointId,
      reflectAccountId: reflected.reflectAccountId,
      reflectEndpointId: reflected.reflectEndpointId,
      reflectConversationId: reflected.reflectConversationId,
    },
  };
  return { result, spec };
}

/** §4.2.4：扫描 status='registering' 的行，逐个 ensureRegistered 并转正（幂等、可重复）。 */
async function runReconcile(
  db: Database.Database,
  deps: AgentApiDeps,
  opts: { agentIds?: string[] } = {},
): Promise<ReconcileRegistrationResult[]> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const rows = opts.agentIds?.length
    ? db
        .prepare(
          `SELECT agent_id, registered_projection, status FROM agents
             WHERE status = 'registering' AND agent_id IN (${opts.agentIds.map(() => "?").join(",")})`,
        )
        .all(...opts.agentIds)
    : db.prepare("SELECT agent_id, registered_projection, status FROM agents WHERE status = 'registering'").all();

  const out: ReconcileRegistrationResult[] = [];
  for (const row of rows as Array<{ agent_id: string; registered_projection: string | null; status: string }>) {
    const before = row.status === "active" ? "active" : "registering";
    const actions: string[] = [];
    try {
      if (!row.registered_projection) throw new ValidationError(`no registered_projection for ${row.agent_id}`);
      const p = JSON.parse(row.registered_projection) as RegisterProjectionInput;
      const projected = await deps.registerProjection({
        agentId: row.agent_id,
        agentType: "role",
        displayName: p.displayName,
        capabilities: p.capabilities,
        initiate: p.initiate,
        defaultGrade: p.defaultGrade,
        topology: p.topology,
        profileRef: p.profileRef,
      });
      actions.push("account_created", "endpoint_created");
      // P4：补齐自省流（幂等：注册表已带则跳过 account/endpoint 重建）。
      const reflected = await deps.registerReflect({ agentId: row.agent_id, displayName: p.displayName });
      actions.push("reflect_registered");
      db.prepare(
        `UPDATE agents
            SET mesh_account_id = ?, mesh_endpoint_id = ?, mesh_registered_at = ?,
                mesh_reflect_account_id = ?, mesh_reflect_endpoint_id = ?, status = 'active'
           WHERE agent_id = ?`,
      ).run(
        projected.accountId,
        projected.endpointId,
        now,
        reflected.reflectAccountId,
        reflected.reflectEndpointId,
        row.agent_id,
      );
      out.push({ agentId: row.agent_id, before, actions, after: "active" });
    } catch (err) {
      out.push({
        agentId: row.agent_id,
        before,
        actions,
        after: "failed",
        error: { code: (err as Error).name, message: (err as Error).message },
      });
    }
  }
  return out;
}

/** R06 setModelConfig（§5.4 / E09）：在已定稿模型配置上合并运行期覆盖，写回 DB，再同步内存绑定。
 *  只改模型段（dialogue/reflection/budget），不碰 identity/spec/respec——主/自省按 patch 独立覆盖。 */
function runSetModelConfig(
  agentId: string,
  patch: ModelConfigOverride,
  deps: AgentApiDeps,
): SetModelConfigResult {
  const db = deps.roleDb;
  const row = db
    .prepare<[string], {
      mesh_account_id: string | null;
      mesh_reflect_account_id: string | null;
      model_config_json: string | null;
      model_config_source_json: string | null;
    }>(
      `SELECT mesh_account_id, mesh_reflect_account_id, model_config_json, model_config_source_json
         FROM agents WHERE agent_id = ?`,
    )
    .get(agentId);
  if (!row) throw new ValidationError(`agent does not exist: ${agentId}`);
  if (!row.model_config_json) throw new ValidationError(`agent has no persisted model config: ${agentId}`);

  const current = JSON.parse(row.model_config_json) as ModelConfig;
  const currentSource = (row.model_config_source_json ? JSON.parse(row.model_config_source_json) : {}) as ModelConfigSource;
  const { modelConfig, source } = applyRuntimeModelOverride(current, currentSource, patch);

  db.prepare("UPDATE agents SET model_config_json = ?, model_config_source_json = ? WHERE agent_id = ?").run(
    JSON.stringify(modelConfig),
    JSON.stringify(source),
    agentId,
  );

  // 同步内存（agentMeta 行 + 已缓存主/自省绑定），下一次 resolve 即用新模型（warm 等价，无需真模型）。
  deps.onModelConfigUpdated({
    agentId,
    modelConfig,
    mainAccountId: row.mesh_account_id,
    reflectAccountId: row.mesh_reflect_account_id,
  });

  return { agentId, modelConfig, modelConfigSource: source };
}

/** respec 时的行载荷：标识身份不可变字段 + 编译输入 + 上次注册投影快照。 */
interface RespecRow {
  status: string;
  identity_id: string | null;
  identity_dir: string | null;
  model_config_json: string | null;
  spec_hash: string | null;
  mesh_reflect_account_id: string | null;
  registered_projection: string | null;
}

/**
 * R10 respec（§4.6.2 前半）：从实例模板重编译 spec 并写新快照，只处理 mesh 不认识的部分
 * （systemPrompt/lazySections/constraints/…）。身份字段（identityId/mesh.accountId）变化一律
 * 拒绝、不自动迁移；mesh 投影的 displayName/capabilities/initiate/defaultGrade/topology 变化
 * 只在返回里报告 pendingMeshDrift——mesh 无 updateAccount，静默继续会留下「spec 改了行为没改」。
 */
async function runRespec(agentId: string, deps: AgentApiDeps): Promise<RespecResult> {
  const db = deps.roleDb;
  const row = db.prepare(
    `SELECT status, identity_id, identity_dir, model_config_json, spec_hash,
            mesh_reflect_account_id, registered_projection
       FROM agents WHERE agent_id = ?`,
  ).get(agentId) as RespecRow | undefined;
  if (!row) throw new ValidationError(`agent not found: ${agentId}`);
  if (row.status === "retired") throw new ValidationError(`agent is retired: ${agentId}`);
  if (row.status !== "active") throw new ValidationError(`cannot respec agent in status '${row.status}': ${agentId}`);
  if (!row.identity_dir || !row.model_config_json) {
    throw new ValidationError(`agent has no instance template / model config: ${agentId}`);
  }

  const identityDir = join(deps.root, row.identity_dir);
  const modelConfig = JSON.parse(row.model_config_json) as ModelConfig;
  const spec = await compileIdentity(identityDir, { agentId, modelConfig, compilerVersion: COMPILER_VERSION });

  // 身份字段不变量：版本不匹配 → 拒绝；identityId 漂移 → 拒绝（不自动迁移，要求新建 Agent）。
  if (spec.specVersion !== SPEC_VERSION) throw new SpecVersionMismatch(SPEC_VERSION, spec.specVersion);
  if (row.identity_id !== null && spec.identityId !== row.identity_id) {
    throw new ValidationError(
      `identity field changed for ${agentId} (identityId ${row.identity_id} → ${spec.identityId}); ` +
        "no auto-migration — create a new agent instead",
    );
  }
  if (spec.mesh.accountId !== agentId) {
    throw new ValidationError(`compiled mesh.accountId ${spec.mesh.accountId} ≠ agentId ${agentId}`);
  }

  const newSpecHash = specHashOf(spec);
  const specHashChanged = newSpecHash !== (row.spec_hash ?? "");

  // mesh 投影漂移：以注册时落库的投影快照为唯一 mesh 侧字段值证据（§4.6.1 C/D）。
  let pendingMeshDrift: RespecResult["pendingMeshDrift"] = [];
  if (row.registered_projection) {
    try {
      const prev = JSON.parse(row.registered_projection) as AgentSpecMeshProjection;
      pendingMeshDrift = diffMeshProjection(prev, spec.mesh).map((d) =>
        d.kind === "topology"
          ? { field: "topology", from: d.from, to: d.to, repair: "recreate_endpoint" as const }
          : { field: d.field, from: d.from, to: d.to, repair: "respec" as const },
      );
    } catch {
      // 投影快照损坏视为无基线，不据此误报；C/D 交由 checkMeshConsistency 兜底。
      pendingMeshDrift = [];
    }
  }

  if (specHashChanged) {
    const now = (deps.now ?? (() => new Date().toISOString()))();
    const tx = db.transaction(() => {
      writeSpecRows(db, agentId, spec, identityDir, now);
      db.prepare("UPDATE agents SET spec_hash = ? WHERE agent_id = ?").run(newSpecHash, agentId);
      writeLifecycleAudit(db, agentId, "respec", { specHash: row.spec_hash }, { specHash: newSpecHash }, now);
    });
    tx();
  }

  // 同步内存绑定：新 system prompt 立即生效（主/自省同源），无需真模型。
  deps.onRespec?.({ agentId, spec, reflectAccountId: row.mesh_reflect_account_id });

  return { agentId, promptVersion: spec.promptVersion, specHashChanged, pendingMeshDrift };
}

/** R10 可恢复退役（§4.6.2）：status→'retired'，保留 role 侧全部行与 mesh 历史。幂等。 */
function runRetire(agentId: string, deps: AgentApiDeps): RetireResult {
  const db = deps.roleDb;
  const row = db.prepare("SELECT status, retired_at FROM agents WHERE agent_id = ?").get(agentId) as
    | { status: string; retired_at: string | null }
    | undefined;
  if (!row) throw new ValidationError(`agent not found: ${agentId}`);
  if (row.status === "retired") {
    return { agentId, status: "retired", retiredAt: row.retired_at, alreadyRetired: true };
  }
  if (row.status !== "active") throw new ValidationError(`cannot retire agent in status '${row.status}': ${agentId}`);

  const now = (deps.now ?? (() => new Date().toISOString()))();
  db.prepare("UPDATE agents SET status = 'retired', retired_at = ? WHERE agent_id = ?").run(now, agentId);
  writeLifecycleAudit(db, agentId, "retire", { status: "active" }, { status: "retired", retiredAt: now }, now);
  return { agentId, status: "retired", retiredAt: now, alreadyRetired: false };
}

/** R10 恢复退役 Agent（不重新注册 mesh——账号从未删除，只是恢复 role 侧 active）。 */
function runRestore(agentId: string, deps: AgentApiDeps): RestoreResult {
  const db = deps.roleDb;
  const row = db.prepare("SELECT status, retired_at FROM agents WHERE agent_id = ?").get(agentId) as
    | { status: string; retired_at: string | null }
    | undefined;
  if (!row) throw new ValidationError(`agent not found: ${agentId}`);
  if (row.status !== "retired") throw new ValidationError(`agent is not retired (status '${row.status}'): ${agentId}`);

  const now = (deps.now ?? (() => new Date().toISOString()))();
  db.prepare("UPDATE agents SET status = 'active', retired_at = NULL WHERE agent_id = ?").run(agentId);
  writeLifecycleAudit(db, agentId, "restore", { status: "retired" }, { status: "active" }, now);
  return { agentId, status: "active" };
}

/** 分工区表 → 分区键列名（R10 delete：仅删 role 侧行，mesh 历史不动）。 */
function deleteAgentRows(db: Database.Database, agentId: string): void {
  const byOwner = [
    "agent_state", "agent_specs", "knowledge_events", "episodes", "subject_profiles",
    "knowledge_items", "reflections", "state_writes", "retrieval_log", "boundary_events",
    "facility_records", "memory_decisions",
  ] as const;
  const columnOf = (t: string): "agent_id" | "owner_agent" =>
    t === "agent_state" || t === "agent_specs" ? "agent_id" : "owner_agent";
  const tx = db.transaction(() => {
    // 有外键的表先删子行：knowledge_events（→ knowledge_items、episodes）、
    // episode_subjects（→ episodes 的挂起主体，无外键但一并清理）。
    db.prepare("DELETE FROM episode_subjects WHERE episode_id IN (SELECT episode_id FROM episodes WHERE owner_agent = ?)").run(agentId);
    for (const t of byOwner) {
      db.prepare(`DELETE FROM ${t} WHERE ${columnOf(t)} = ?`).run(agentId);
    }
    db.prepare("DELETE FROM agents WHERE agent_id = ?").run(agentId);
  });
  tx();
}

/** R10 永久删除（§4.6.2）：删 role 侧全部行 + 实例目录；mesh 账号/历史保留（无删账号 API）。不可逆，
 *  不留 role 侧审计（state_writes 随 owner 一并删除；mesh 侧消息/投递记录是唯一留存痕迹）。 */
function runDeleteAgent(agentId: string, deps: AgentApiDeps): DeleteAgentResult {
  const db = deps.roleDb;
  const row = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(agentId);
  if (!row) throw new ValidationError(`agent not found: ${agentId}`);

  deleteAgentRows(db, agentId);

  // 实例目录（identity + sessions 等 role 侧产物）一并清理；agentId 段校验防穿越。
  assertSafeSegment(agentId, "agentId");
  rmSync(join(deps.root, "agents", agentId), { recursive: true, force: true });

  return { agentId, deleted: true };
}

/** 恢复期加载：读 DB-A 已 active 且已注册的 Agent（供 registry 种子 + spec 快照）。 */
export function loadRegisteredAgents(db: Database.Database): RehydratedAgent[] {
  const rows = db
    .prepare(
      `SELECT agent_id, agent_type, identity_id, blueprint_dir, blueprint_hash, identity_dir,
              role, display_name, model_config_json, model_config_source_json, spec_hash,
              status, mesh_account_id, mesh_endpoint_id, mesh_reflect_account_id, mesh_reflect_endpoint_id
         FROM agents
        WHERE status = 'active' AND mesh_account_id IS NOT NULL AND mesh_endpoint_id IS NOT NULL
        ORDER BY created_at`,
    )
    .all() as Array<{
    agent_id: string;
    agent_type: RehydratedAgent["agentType"];
    identity_id: string | null;
    blueprint_dir: string;
    blueprint_hash: string;
    identity_dir: string | null;
    role: string | null;
    display_name: string | null;
    model_config_json: string | null;
    model_config_source_json: string | null;
    spec_hash: string | null;
    status: string;
    mesh_account_id: string | null;
    mesh_endpoint_id: string | null;
    mesh_reflect_account_id: string | null;
    mesh_reflect_endpoint_id: string | null;
  }>;

  return rows.map((r) => ({
    agentId: r.agent_id,
    agentType: r.agent_type,
    identityId: r.identity_id,
    blueprintDir: r.blueprint_dir,
    blueprintHash: r.blueprint_hash,
    identityDir: r.identity_dir,
    role: r.role,
    displayName: r.display_name,
    modelConfig: (r.model_config_json ? JSON.parse(r.model_config_json) : undefined) as ModelConfig,
    modelConfigSource: (r.model_config_source_json ? JSON.parse(r.model_config_source_json) : {}) as ModelConfigSource,
    specHash: r.spec_hash,
    status: r.status,
    meshAccountId: r.mesh_account_id,
    meshEndpointId: r.mesh_endpoint_id,
    reflectAccountId: r.mesh_reflect_account_id,
    reflectEndpointId: r.mesh_reflect_endpoint_id,
  }));
}

/** 组装公开 AgentApi（create + reconcile + reproject + reconcile 模板 + R10 respec/退役）；create
 *  结果与 spec 经 onCreated 上抛给 runtime。 */
export function makeAgentApi(
  deps: AgentApiDeps,
  onCreated?: (r: CreateAgentResult & { spec: AgentSpec }) => void,
): {
  create(input: CreateAgentInput): Promise<CreateAgentResult>;
  createBatch(inputs: CreateAgentInput[]): Promise<CreateBatchItemResult[]>;
  reconcileRegistrations(opts?: { agentIds?: string[] }): Promise<ReconcileRegistrationResult[]>;
  reproject(agentId: string): ReturnType<typeof reproject>;
  reconcile(agentId: string): ReturnType<typeof reconcile>;
  setModelConfig(agentId: string, patch: ModelConfigOverride): SetModelConfigResult;
  respec(agentId: string): Promise<RespecResult>;
  retire(agentId: string): RetireResult;
  restore(agentId: string): RestoreResult;
  deleteAgent(agentId: string): DeleteAgentResult;
} {
  const doCreate = async (input: CreateAgentInput): Promise<CreateAgentResult> => {
    const { result, spec } = await runCreate(input, deps);
    onCreated?.({ ...result, spec });
    return result;
  };

  return {
    create(input: CreateAgentInput): Promise<CreateAgentResult> {
      return doCreate(input);
    },
    async createBatch(inputs: CreateAgentInput[]): Promise<CreateBatchItemResult[]> {
      // R04：逐项串行，单行失败不影响后续项；失败按阶段定级，不承诺跨库整批原子回滚。
      const out: CreateBatchItemResult[] = [];
      for (const input of inputs) {
        try {
          const result = await doCreate(input);
          out.push({ agentId: input.agentId, after: "active", result });
        } catch (err) {
          const code = err instanceof Error ? err.name : "Error";
          const message = err instanceof Error ? err.message : String(err);
          // 区分可前向恢复（第 7/7.5 步 mesh 注册失败 → 行仍 registering）与已回滚（第 3–6 步）。
          const row = deps.roleDb
            .prepare("SELECT status FROM agents WHERE agent_id = ?")
            .get(input.agentId) as { status: string } | undefined;
          out.push({
            agentId: input.agentId,
            after: row?.status === "registering" ? "registering" : "failed",
            error: { code, message },
          });
        }
      }
      return out;
    },
    reconcileRegistrations(opts?: { agentIds?: string[] }): Promise<ReconcileRegistrationResult[]> {
      return runReconcile(deps.roleDb, deps, opts);
    },
    reproject(agentId: string) {
      return reproject(deps.roleDb, deps.root, agentId);
    },
    reconcile(agentId: string) {
      return reconcile(deps.roleDb, deps.root, agentId);
    },
    setModelConfig(agentId: string, patch: ModelConfigOverride): SetModelConfigResult {
      return runSetModelConfig(agentId, patch, deps);
    },
    respec(agentId: string): Promise<RespecResult> {
      return runRespec(agentId, deps);
    },
    retire(agentId: string): RetireResult {
      return runRetire(agentId, deps);
    },
    restore(agentId: string): RestoreResult {
      return runRestore(agentId, deps);
    },
    deleteAgent(agentId: string): DeleteAgentResult {
      return runDeleteAgent(agentId, deps);
    },
  };
}