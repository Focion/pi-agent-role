// ═══════════════════════════════════════════════════════════════════════════
// facilities 命名空间（R11 / §3.2 / §5.5）—— 设施 Agent 创建与恢复
//
// 设施不是 persona：无身份编译（identityId），但有设施自己的编译器（compileFacility，
// §5.5）。create() 与 agents.create() 共用同一套「物化 → 编译 → 落库 → 注册 mesh → 转正」
// 骨架，只是：
//   · 落库 agent_type='facility'、identity_id=NULL、role=NULL；
//   · 编译产物 → agent_state（facility_constraints / facility_live / facility_meta），
//     运行期四工具的 enforce 从 agent_state 读规则与数字状态（§6.1 与模板脱钩）；
//   · mesh 投影 initiate:[]、defaultGrade:"steer"（§3.2 只应答不发起）；
//   · 无自省流、无知识种入（设施无主观记忆 C7）。
//
// 恢复期（§4.2.4）不用单独实装：设施就是 agents 表里 agent_type='facility' 的行，
// loadRegisteredAgents 原样读回并 seed 进注册表；restart 后域名工具经 registry.kindOf
// 分叉到 facility 四工具（§3.8）。故 create 落库必须带完整 mesh 映射，恢复才认领得到。
//
// 分层纪律（§22.4 #4）：本文件属 src/runtime/**，不 import `@pi/agent-mesh`；mesh 注册
// 经注入的 registerProjection 闭包触达（类型经 ../mesh/bootstrap.js 再出口）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import type Database from "better-sqlite3";

import { COMPILER_VERSION } from "../compile/version.js";
import { fingerprintOf, sha256Hex } from "../compile/fingerprint.js";
import { compileFacility } from "../compile/facility-loader.js";
import { materialize } from "../compile/materialize.js";
import { resolveModelConfig } from "../compile/model-resolver.js";
import { readYamlFile } from "../compile/yaml.js";
import { SPEC_VERSION } from "../compile/types.js";
import type { FacilitySpec, ModelConfig, ModelConfigSource } from "../compile/types.js";
import type { ProjectedMeshIds, RegisterProjectionInput } from "../mesh/bootstrap.js";
import { BlueprintNotFound, SpecVersionMismatch, ValidationError } from "./errors.js";
import type { CreateFacilityInput, CreateFacilityResult, ReconcileRegistrationResult } from "./types.js";

/** 蓝本内可选的模型默认文件（§5.4 第 2 层 blueprint；与角色共用同名文件）。 */
const MODEL_DEFAULTS_FILE = "model_defaults.yaml";

export interface FacilityApiDeps {
  root: string;
  roleDb: Database.Database;
  modelDefaults?: Partial<ModelConfig>;
  /** R33 双库配对标识：create 落库时写进 agents.mesh_instance_tag。 */
  pairingId: string;
  registerProjection(input: RegisterProjectionInput): Promise<ProjectedMeshIds>;
  now?: () => string;
}

/** 参与落 agent_specs 的设施编译文件（required → cold_start，optional → lazy）。 */
const FACILITY_SPEC_FILES: Array<{ file: string; kind: "cold_start" | "lazy" }> = [
  { file: "manifest", kind: "cold_start" },
  { file: "facility", kind: "cold_start" },
  { file: "protocol", kind: "cold_start" },
  { file: "constraints", kind: "cold_start" },
  { file: "records", kind: "lazy" },
  { file: "thresholds", kind: "lazy" },
];

/** §9.4 同源：覆盖 assemble() 全部输入的设施 spec 指纹。 */
export function facilitySpecHashOf(spec: FacilitySpec): string {
  return fingerprintOf([
    spec.promptVersion,
    spec.systemPrompt,
    JSON.stringify(spec.modelConfig),
    JSON.stringify(spec.domainTools),
    JSON.stringify(spec.constraints),
    JSON.stringify(spec.protocol),
    JSON.stringify(spec.mesh),
    JSON.stringify(spec.stateSchema),
    JSON.stringify(spec.initialState),
  ]);
}

/** 逐文件落 agent_specs 快照（设施：cold_start 4 必读 + lazy 2 可选）。content 恒 NULL。 */
function writeFacilitySpecRows(
  db: Database.Database,
  facilityId: string,
  instanceDir: string,
  now: string,
): void {
  const upsert = db.prepare(
    `INSERT INTO agent_specs (agent_id, spec_path, spec_hash, spec_kind, content, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(agent_id, spec_path) DO UPDATE
       SET spec_hash = excluded.spec_hash, spec_kind = excluded.spec_kind, updated_at = excluded.updated_at`,
  );
  for (const { file, kind } of FACILITY_SPEC_FILES) {
    const p = join(instanceDir, `${file}.yaml`);
    if (!existsSync(p)) continue;
    upsert.run(facilityId, `${file}.yaml`, sha256Hex(readFileSync(p)), kind, now);
  }
}

/** 步骤 1 之前：解析蓝本目录（与 roles 同规则）。 */
function resolveBlueprintDir(root: string, blueprint: string): string {
  const dir = isAbsolute(blueprint) ? blueprint : join(root, blueprint);
  if (!existsSync(dir)) throw new BlueprintNotFound(blueprint);
  return dir;
}

async function runFacilityCreate(
  input: CreateFacilityInput,
  deps: FacilityApiDeps,
): Promise<CreateFacilityResult> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const db = deps.roleDb;

  // 幂等/独占：facilityId 已存在即拒绝（§4.2.3 本环是映射唯一持有方）。
  const existing = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(input.facilityId);
  if (existing) throw new ValidationError(`agent already exists: ${input.facilityId}`);

  // 步骤 1–2：解析蓝本 → 物化实例模板（facility/，§6.1）。
  const blueprintDir = resolveBlueprintDir(deps.root, input.blueprint);
  const overlay = input.overlay as Record<string, unknown> | undefined;
  const mat = await materialize({
    blueprintDir,
    root: deps.root,
    agentId: input.facilityId,
    targetDirName: "facility",
    overlay,
  });

  // 步骤 3–6：解析模型 → 编译 → 指纹 → 单事务落库（失败整体真回滚：删目录）。
  let spec: FacilitySpec;
  let modelConfig: ModelConfig;
  let source: ModelConfigSource;
  let displayName: string;
  let specHash: string;
  let projection: FacilitySpec["mesh"];
  try {
    const blueprintModelDefaults = readYamlFile<Partial<ModelConfig>>(
      join(blueprintDir, MODEL_DEFAULTS_FILE),
      { optional: true, label: `${blueprintDir}/${MODEL_DEFAULTS_FILE}` },
    );
    const resolved = resolveModelConfig({
      runtimeDefault: deps.modelDefaults,
      blueprint: blueprintModelDefaults,
      createArg: { model: input.model, tokenBudget: input.tokenBudget },
    });
    modelConfig = resolved.modelConfig;
    source = resolved.source;

    spec = await compileFacility(mat.identityDir, {
      facilityId: input.facilityId,
      modelConfig,
      compilerVersion: COMPILER_VERSION,
    });
    if (spec.specVersion !== SPEC_VERSION) throw new SpecVersionMismatch(SPEC_VERSION, spec.specVersion);
    displayName = input.displayName ?? spec.mesh.displayName;
    specHash = facilitySpecHashOf(spec);
    projection = { ...spec.mesh, displayName };

    const identityDirRel = relative(deps.root, mat.identityDir);
    const rawFacility = readYamlFile<{ report_target?: string }>(join(mat.identityDir, "facility.yaml"), {
      optional: true,
    });

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO agents
           (agent_id, agent_type, identity_id, blueprint_dir, blueprint_hash, overlay_json,
            identity_dir, projected_at, role, display_name,
            model_config_json, model_config_source_json, model_preset, registered_projection,
            spec_hash, mesh_instance_tag, status, created_at)
         VALUES (?, 'facility', NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, 'registering', ?)`,
      ).run(
        input.facilityId,
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

      writeFacilitySpecRows(db, input.facilityId, mat.identityDir, now);

      // 编译产物 → agent_state（运行期四工具 enforce 从这里读，与模板脱钩 §6.1）。
      const insState = db.prepare(
        `INSERT INTO agent_state (agent_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)`,
      );
      insState.run(input.facilityId, "facility_constraints", JSON.stringify(spec.constraints), now);
      insState.run(input.facilityId, "facility_live", JSON.stringify(spec.initialState.liveState), now);
      insState.run(
        input.facilityId,
        "facility_meta",
        JSON.stringify({
          name: spec.displayName,
          type: spec.facilityType,
          report_target: rawFacility?.report_target,
        }),
        now,
      );
    });
    tx();
  } catch (err) {
    rmSync(mat.identityDir, { recursive: true, force: true });
    throw err;
  }

  // 步骤 7：注册 mesh 只应答 Account（initiate:[] / steer / 四工具面）。失败 → 前向恢复。
  const projected = await deps.registerProjection({
    agentId: input.facilityId,
    agentType: "facility",
    displayName,
    capabilities: projection.capabilities,
    initiate: projection.initiate,
    defaultGrade: projection.defaultGrade,
    topology: projection.topology,
    profileRef: projection.profileRef,
  });

  // 步骤 8：回写映射 + 转正。
  db.prepare(
    `UPDATE agents
        SET mesh_account_id = ?, mesh_endpoint_id = ?, mesh_registered_at = ?,
            registered_projection = ?, status = 'active'
      WHERE agent_id = ?`,
  ).run(
    projected.accountId,
    projected.endpointId,
    now,
    JSON.stringify(projection),
    input.facilityId,
  );

  return {
    facilityId: input.facilityId,
    promptVersion: spec.promptVersion,
    blueprintId: basename(blueprintDir),
    blueprintHash: mat.blueprintHash,
    modelConfig,
    modelConfigSource: source,
    accountId: projected.accountId,
    endpointId: projected.endpointId,
  };
}

/** §4.2.4：设施的前向恢复（与角色共用 registered_projection 重放 + registerProjection 幂等）。 */
async function runFacilityReconcile(
  db: Database.Database,
  deps: FacilityApiDeps,
  opts: { facilityIds?: string[] } = {},
): Promise<ReconcileRegistrationResult[]> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const rows = opts.facilityIds?.length
    ? db
        .prepare(
          `SELECT agent_id, registered_projection, status FROM agents
             WHERE agent_type = 'facility' AND status = 'registering' AND agent_id IN (${opts.facilityIds
               .map(() => "?")
               .join(",")})`,
        )
        .all(...opts.facilityIds)
    : db
        .prepare(
          "SELECT agent_id, registered_projection, status FROM agents WHERE agent_type = 'facility' AND status = 'registering'",
        )
        .all();

  const out: ReconcileRegistrationResult[] = [];
  for (const row of rows as Array<{ agent_id: string; registered_projection: string | null; status: string }>) {
    const before = row.status === "active" ? "active" : "registering";
    const actions: string[] = [];
    try {
      if (!row.registered_projection) throw new ValidationError(`no registered_projection for ${row.agent_id}`);
      const p = JSON.parse(row.registered_projection) as RegisterProjectionInput;
      const projected = await deps.registerProjection({
        agentId: row.agent_id,
        agentType: "facility",
        displayName: p.displayName,
        capabilities: p.capabilities,
        initiate: p.initiate,
        defaultGrade: p.defaultGrade,
        topology: p.topology,
        profileRef: p.profileRef,
      });
      actions.push("account_created", "endpoint_created");
      db.prepare(
        `UPDATE agents
            SET mesh_account_id = ?, mesh_endpoint_id = ?, mesh_registered_at = ?, status = 'active'
           WHERE agent_id = ?`,
      ).run(projected.accountId, projected.endpointId, now, row.agent_id);
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

/** 组装公开 FacilityApi（R11：create + reconcile）；create 结果经 onCreated 上抛给 runtime。 */
export function makeFacilityApi(
  deps: FacilityApiDeps,
  onCreated?: (r: CreateFacilityResult) => void,
): {
  create(input: CreateFacilityInput): Promise<CreateFacilityResult>;
  reconcileRegistrations(opts?: { facilityIds?: string[] }): Promise<ReconcileRegistrationResult[]>;
} {
  return {
    async create(input: CreateFacilityInput): Promise<CreateFacilityResult> {
      const result = await runFacilityCreate(input, deps);
      onCreated?.(result);
      return result;
    },
    reconcileRegistrations(opts?: { facilityIds?: string[] }): Promise<ReconcileRegistrationResult[]> {
      return runFacilityReconcile(deps.roleDb, deps, opts);
    },
  };
}