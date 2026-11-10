// ═══════════════════════════════════════════════════════════════════════════
// mesh 一致性核对（R10 / §4.6 契约 4）：AgentSpec ↔ mesh 投影的五条断言
//
// 契约 4 只能**单向核对**（§4.6.1 明确承认）：mesh 不提供按 id 读账号的接口，B/C/D
// 拿不到 mesh 侧字段值，只能退化为本环库内核对。这里实现可诚实下判的四条：
//   · A（映射恒等）：mesh_account_id === agent_id，reflect 列 === `<agentId>:reflect`；
//   · B（疑似缺失）：status='registering' 视作 ACCOUNT/ENDPOINT 缺失的疑似项，交给 reconcile 幂等重放；
//   · C/D（投影漂移）：以 `registered_projection`（上次成功注册的投影快照）为 mesh 侧唯一字段值
//     证据，重编译当前 spec 后 diff——displayName 等变化记 FIELD_DRIFT，topology 变化记
//     TOPOLOGY_DRIFT。
// ORPHAN_ACCOUNT 与 REFLECT_ACL_OPEN 需要 mesh 侧全量账号/成员读，且自省会话 id 不落 DB-A，
// 故放入 notChecked，不以 0 占位。
//
// 分层纪律（§22.4 #4）：本文件不 import @pi/agent-mesh（R1），不出现 mesh_ 表名（R2）。
// ═══════════════════════════════════════════════════════════════════════════

import { join } from "node:path";

import type Database from "better-sqlite3";

import { compileIdentity } from "../compile/identity-loader.js";
import { diffMeshProjection } from "../compile/types.js";
import type { AgentSpecMeshProjection, ModelConfig } from "../compile/types.js";
import { COMPILER_VERSION } from "../compile/version.js";
import type { MeshConsistencyAgent, MeshConsistencyFinding, MeshConsistencyReport } from "../runtime/types.js";

interface AgentRow {
  agent_id: string;
  agent_type: string;
  status: string;
  identity_dir: string | null;
  model_config_json: string | null;
  mesh_account_id: string | null;
  mesh_reflect_account_id: string | null;
  registered_projection: string | null;
}

const NOT_CHECKED = [
  "ORPHAN_ACCOUNT：mesh 侧有 <agentId>[:reflect] 而本环无行 —— 需 mesh 侧全量账号读，本环库内不可判",
  "REFLECT_ACL_OPEN：reflect direct 会话成员集是否恰为 {self, self:reflect} —— 自省会话 id 不落 DB-A，需 mesh.members",
];

function assertA(row: AgentRow): MeshConsistencyFinding[] {
  const out: MeshConsistencyFinding[] = [];
  if (row.status === "active" && row.mesh_account_id === null) {
    out.push({ code: "MAPPING_MISSING", field: "mesh_account_id", repair: "reconcile" });
  }
  if (row.mesh_account_id !== null && row.mesh_account_id !== row.agent_id) {
    // §4.6.1 断言 A：改 id 等于换身份，只能 manual。
    out.push({
      code: "MAPPING_MISSING",
      field: "mesh_account_id",
      expected: row.agent_id,
      actual: row.mesh_account_id,
      repair: "manual",
    });
  }
  const expectReflect = `${row.agent_id}:reflect`;
  if (row.mesh_reflect_account_id !== null && row.mesh_reflect_account_id !== expectReflect) {
    out.push({
      code: "MAPPING_MISSING",
      field: "mesh_reflect_account_id",
      expected: expectReflect,
      actual: row.mesh_reflect_account_id,
      repair: "manual",
    });
  }
  return out;
}

function assertB(row: AgentRow): MeshConsistencyFinding[] {
  if (row.status !== "registering") return [];
  // §4.6.1 B：拿不到 mesh 侧字段值，退化为 status='registering' 疑似项，交给 reconcile 幂等重放。
  return [
    { code: "ACCOUNT_MISSING", field: "status", expected: "active", actual: "registering", repair: "reconcile" },
    { code: "ENDPOINT_MISSING", field: "status", expected: "active", actual: "registering", repair: "reconcile" },
  ];
}

/** C/D：以注册快照为基准，重编译当前 spec 后 diff mesh 投影。编译失败（缺模板/坏配置）则跳过该项。 */
async function assertCD(row: AgentRow, root: string): Promise<MeshConsistencyFinding[]> {
  if (row.registered_projection === null) return [];
  if (row.status === "registering") return []; // 尚未注册成功，无有效快照可比
  if (!row.identity_dir || !row.model_config_json) return [];

  let prev: AgentSpecMeshProjection;
  try {
    prev = JSON.parse(row.registered_projection) as AgentSpecMeshProjection;
  } catch {
    return []; // 快照损坏：无基线，不误报
  }

  let spec;
  try {
    spec = await compileIdentity(join(root, row.identity_dir), {
      agentId: row.agent_id,
      modelConfig: JSON.parse(row.model_config_json) as ModelConfig,
      compilerVersion: COMPILER_VERSION,
    });
  } catch {
    return []; // 当前实例模板无法编译——恢复期自有校验，此处不二次判罚
  }

  return diffMeshProjection(prev, spec.mesh).map<MeshConsistencyFinding>((d) =>
    d.kind === "topology"
      ? { code: "TOPOLOGY_DRIFT", field: "topology", expected: d.from, actual: d.to, repair: "recreate_endpoint" }
      : { code: "FIELD_DRIFT", field: d.field, expected: d.from, actual: d.to, repair: "respec" },
  );
}

/** R10 一致性报告：逐个 Agent 拼 A/B/C/D 断言（C/D 需重编译，异步）。 */
export async function checkMeshConsistency(db: Database.Database, root: string): Promise<MeshConsistencyReport> {
  const rows = db
    .prepare(
      `SELECT agent_id, agent_type, status, identity_dir, model_config_json,
              mesh_account_id, mesh_reflect_account_id, registered_projection
         FROM agents ORDER BY created_at`,
    )
    .all() as AgentRow[];

  const agents: MeshConsistencyAgent[] = [];
  for (const row of rows) {
    const findings: MeshConsistencyFinding[] = [...assertA(row), ...assertB(row)];
    if (row.agent_type === "role") {
      findings.push(...(await assertCD(row, root)));
    }
    if (findings.length > 0) agents.push({ agentId: row.agent_id, findings });
  }

  return { checkedAt: new Date().toISOString(), notChecked: NOT_CHECKED, agents };
}