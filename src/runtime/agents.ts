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

import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import type Database from "better-sqlite3";

import { fingerprintOf, sha256Hex } from "../compile/fingerprint.js";
import { compileIdentity } from "../compile/identity-loader.js";
import { materialize } from "../compile/materialize.js";
import { resolveModelConfig } from "../compile/model-resolver.js";
import { COMPILER_VERSION } from "../compile/version.js";
import { readYamlFile } from "../compile/yaml.js";
import type { AgentSpec, ModelConfig, ModelConfigSource } from "../compile/types.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { ProjectedMeshIds, RegisterProjectionInput, RegisterReflectInput } from "../mesh/bootstrap.js";
import { BlueprintNotFound, ValidationError } from "./errors.js";
import type {
  CreateAgentInput,
  CreateAgentResult,
  ReconcileRegistrationResult,
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
  registerProjection(input: RegisterProjectionInput): Promise<ProjectedMeshIds>;
  registerReflect(input: RegisterReflectInput): Promise<{
    reflectAccountId: string;
    reflectEndpointId: string;
    reflectConversationId: string;
  }>;
  modelDefaults?: Partial<ModelConfig>;
  now?: () => string;
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

    // 步骤 6：单事务写 agents + agent_specs + agent_state，status='registering'。
    const identityDirRel = relative(deps.root, mat.identityDir);
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO agents
           (agent_id, agent_type, identity_id, blueprint_dir, blueprint_hash, overlay_json,
            identity_dir, projected_at, role, display_name,
            model_config_json, model_config_source_json, model_preset, spec_hash, status, created_at)
         VALUES (?, 'role', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, 'registering', ?)`,
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
        specHash,
        now,
      );

      const insSpec = db.prepare(
        `INSERT INTO agent_specs (agent_id, spec_path, spec_hash, spec_kind, content, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      );
      for (const f of compiledFiles(spec)) {
        const p = join(mat.identityDir, f.path);
        const hash = existsSync(p) ? sha256Hex(readFileSync(p)) : "";
        insSpec.run(input.agentId, f.path, hash, f.kind, now);
      }

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
  const projection: AgentSpec["mesh"] = { ...spec.mesh, displayName };
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

/** 组装公开 AgentApi（create + reconcile）；create 结果与 spec 经 onCreated 上抛给 runtime。 */
export function makeAgentApi(
  deps: AgentApiDeps,
  onCreated?: (r: CreateAgentResult & { spec: AgentSpec }) => void,
): {
  create(input: CreateAgentInput): Promise<CreateAgentResult>;
  reconcileRegistrations(opts?: { agentIds?: string[] }): Promise<ReconcileRegistrationResult[]>;
} {
  return {
    async create(input: CreateAgentInput): Promise<CreateAgentResult> {
      const { result, spec } = await runCreate(input, deps);
      onCreated?.({ ...result, spec });
      return result;
    },
    reconcileRegistrations(opts?: { agentIds?: string[] }): Promise<ReconcileRegistrationResult[]> {
      return runReconcile(deps.roleDb, deps, opts);
    },
  };
}