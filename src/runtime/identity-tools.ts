// ═══════════════════════════════════════════════════════════════════════════
// identity_read / protocol_query 工具处理器（R08 / §5.3 / 附录 F）
//
// 两个都是只读工具，作用域用 accountId → agentId 闭包锁死到「本人」（装配期烤入 agentId，
// 与 remember/recall 的 ownerAgent 同构，§5.3「身份闭包与 mesh 闭包同构」）：
//   · identity_read：可读 section 白名单 = 编译期 lazySections（agent_specs.spec_kind='lazy'），
//     越白名单拒绝（SECTION_NOT_ALLOWED，本环定义）；路径由 agentId 闭包 + 白名单拼出，
//     不信任入参拼路径（§5.3 三要点）。只读 `<root>/agents/<id>/identity/<section>.yaml`。
//   · protocol_query：读 agents.registered_projection 的 capabilities/initiate（agent_protocol.yaml
//     的交互约定），不读 mesh。
//
// 失败语义是本环定义的，不是 mesh 的（§5.2.2 末）：形状复刻 `{ error: { code, message, hint? } }`。
//
// 分层纪律：本文件属 src/runtime/**，不 import @pi/agent-mesh（R1）、不出现 mesh_ 表名（R2）、
// 不出现环境字段 `ext` 的点访问（R3）。
// ═════════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { assertSafeSegment } from "../compile/path-guard.js";
import type { MeshToolResult } from "../mesh/public-types.js";
import type { ToolExecute } from "../mesh/tools.js";

/** 只读 context：本人 agentId（装配期烤入）+ 实例模板根目录 + role 库。 */
export interface IdentityToolDeps {
  db: Database.Database;
  root: string;
  /** 本人 agentId（由 domainHandlersFor(accountId) 装配闭包烤入，绝不来自入参）。 */
  agentId: string;
}

/** 本环定义的工具错误。 */
function toolError(code: string, message: string, hint?: string): MeshToolResult {
  const error: { code: string; message: string; hint?: string } = { code, message };
  if (hint !== undefined) error.hint = hint;
  return { content: JSON.stringify({ error }) };
}

/** 该 agent 的编译期按需段白名单（section 名，不带 .yaml）。 */
function lazySectionsOf(db: Database.Database, agentId: string): Set<string> {
  const rows = db
    .prepare<[string], { spec_path: string }>(
      `SELECT spec_path FROM agent_specs WHERE agent_id = ? AND spec_kind = 'lazy'`,
    )
    .all(agentId);
  const out = new Set<string>();
  for (const r of rows) {
    if (r.spec_path.endsWith(".yaml")) out.add(r.spec_path.slice(0, -".yaml".length));
  }
  return out;
}

interface AgentRow {
  identity_dir: string | null;
  registered_projection: string | null;
}

function agentRowOf(db: Database.Database, agentId: string): AgentRow | undefined {
  return db
    .prepare<[string], AgentRow>(
      `SELECT identity_dir, registered_projection FROM agents WHERE agent_id = ?`,
    )
    .get(agentId);
}

/** identity_read（§5.3）：白名单内按需段文本。 */
function makeIdentityRead(deps: IdentityToolDeps): ToolExecute {
  return async (_toolCallId, params) => {
    const section = params.section;
    if (typeof section !== "string" || section.trim().length === 0) {
      return toolError("ARG_INVALID", "section 必填（非空段名）。");
    }

    const allowed = lazySectionsOf(deps.db, deps.agentId);
    if (!allowed.has(section)) {
      return toolError(
        "SECTION_NOT_ALLOWED",
        `身份段 "${section}" 不在本人可读白名单内。`,
        `可读段：${[...allowed].sort().join(" / ") || "（无）"}`,
      );
    }

    // 路径由闭包 + 白名单拼出；入参仍过段校验（防注入 '/' 拼漏目录，§5.3 三要点）。
    try {
      assertSafeSegment(section, "section");
    } catch {
      return toolError("SECTION_NOT_ALLOWED", `身份段名非法："${section}"。`);
    }

    const row = agentRowOf(deps.db, deps.agentId);
    if (!row?.identity_dir) {
      return toolError("SECTION_MISSING", "本人实例模板目录不存在。");
    }
    const filePath = join(deps.root, row.identity_dir, `${section}.yaml`);
    if (!existsSync(filePath)) {
      return toolError("SECTION_MISSING", `白名单段 "${section}" 的模板文件缺失。`);
    }

    const text = readFileSync(filePath, "utf8");
    return {
      content: [{ type: "text", text }],
      details: {
        section,
        tokenEstimate: Math.ceil(Buffer.byteLength(text, "utf8") / 4),
        source: "instance_template",
      },
    };
  };
}

/** protocol_query（附录 F 第 5 号）：agent_protocol.yaml 的交互约定（capabilities/initiate）。 */
function makeProtocolQuery(deps: IdentityToolDeps): ToolExecute {
  return async (_toolCallId, params) => {
    const row = agentRowOf(deps.db, deps.agentId);
    if (!row?.registered_projection) {
      return toolError("SCOPE_VIOLATION", "本人没有已注册的规程投影。");
    }
    let projection: { capabilities?: unknown; initiate?: unknown };
    try {
      projection = JSON.parse(row.registered_projection) as { capabilities?: unknown; initiate?: unknown };
    } catch {
      return toolError("SCOPE_VIOLATION", "本人规程投影损坏。");
    }

    const capabilities = Array.isArray(projection.capabilities)
      ? projection.capabilities.filter((x): x is string => typeof x === "string")
      : [];
    const initiate = Array.isArray(projection.initiate)
      ? projection.initiate.filter((x): x is string => typeof x === "string")
      : [];

    // question/topic 只作可观测上下文化，不改变「本人规程」的封闭集合（无逐条规则表）。
    const question = typeof params.question === "string" ? params.question : undefined;
    return {
      content: [{ type: "text", text: JSON.stringify({ capabilities, initiate }) }],
      details: { capabilities, initiate, ...(question !== undefined ? { question } : {}) },
    };
  };
}

/** R08：装配 identity_read + protocol_query 两个只读处理器（owner 锁死本人）。 */
export function makeIdentityDomainTools(deps: IdentityToolDeps): {
  identity_read: ToolExecute;
  protocol_query: ToolExecute;
} {
  return {
    identity_read: makeIdentityRead(deps),
    protocol_query: makeProtocolQuery(deps),
  };
}