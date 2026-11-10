// ═══════════════════════════════════════════════════════════════════════════
// 设施四工具处理器（R11 / §5.5 / 附录 F 第 7–10 号）
//
//   · facility_query   —— 只读设施模型（按功能域映射到实例模板文件，identity_read 同构）；
//   · facility_report  —— 聚合 facility_records 流水（不暴露原始流水）；
//   · facility_enforce —— 判定规则 { allowed, reason, escalation? }（不发消息）；
//   · facility_record  —— 仅追加一条事实流水（不经 LLM 改写，设施无主观记忆 C7）。
//
// 闭包持有 owner 分区键（facilityId 在装配期烤入，绝不来自入参），写读只经 DB-A。
// 编译产物（constraints / liveState）在 create 时落 agent_state（与模板脱钩，§6.1），
// 运行期 enforce 从 agent_state 读规则与数字状态、从 facility_records 算占用——不经 LLM。
//
// 失败语义是本环定义的（附录 F 显式标注）：ARG_INVALID / FACILITY_NOT_IN_SCENE /
// RULE_UNDEFINED；形状复刻 `{ error: { code, message, hint? } }`，不写进任何 mesh 原因码。
//
// 分层纪律：本文件属 src/runtime/**，不 import @pi/agent-mesh（R1）、不出现 mesh_ 表名（R2）、
// 不出现环境字段 `ext` 的点访问（R3）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { FACILITY_DOMAIN_FILES } from "../compile/facility-loader.js";
import { assertSafeSegment } from "../compile/path-guard.js";
import { parseYamlText } from "../compile/yaml.js";
import type { MeshToolResult } from "../mesh/public-types.js";
import type { ToolExecute } from "../mesh/tools.js";
import { newId } from "./id.js";

/** 设施领域工具的装配依赖：db + 实例模板根 + 分区键（装配期烤入，不来自入参）。 */
export interface FacilityToolDeps {
  db: Database.Database;
  root: string;
  /** 本人 facilityId（由 domainHandlersFor(accountId) 装配闭包烤入）。 */
  facilityId: string;
  now?: () => string;
}

const FACILITY_DOMAINS = ["basic", "time", "capacity", "rules", "services", "resources", "pricing", "relations"] as const;
const RECORD_KINDS = ["usage", "incident", "maintenance"] as const;

/** 本环定义的工具错误。 */
function toolError(code: string, message: string, hint?: string): MeshToolResult {
  const error: { code: string; message: string; hint?: string } = { code, message };
  if (hint !== undefined) error.hint = hint;
  return { content: JSON.stringify({ error }) };
}

/** 结构化成功返回（content 为 JSON 字符串，details 供观测）。 */
function ok(payload: Record<string, unknown>, details?: Record<string, unknown>): MeshToolResult {
  return {
    content: JSON.stringify(payload),
    details: { ...(details ?? {}), ok: true },
  };
}

interface FacilityAgentRow {
  identity_dir: string | null;
}

/** 读设施行的实例模板目录相对路径（root 相对）。 */
function identityDirOf(db: Database.Database, facilityId: string): string | null {
  const row = db
    .prepare<[string], FacilityAgentRow>("SELECT identity_dir FROM agents WHERE agent_id = ?")
    .get(facilityId);
  return row?.identity_dir ?? null;
}

/** 校验入参 facilityId 与本人（分区键）一致——本环定义的作用域锁死（SCOPE 语义）。 */
function scopeCheck(deps: FacilityToolDeps, facilityId: unknown): MeshToolResult | null {
  if (typeof facilityId !== "string" || facilityId.trim().length === 0) {
    return toolError("ARG_INVALID", "facilityId 必填（非空）。");
  }
  if (facilityId !== deps.facilityId) {
    return toolError(
      "FACILITY_NOT_IN_SCENE",
      `设施 "${facilityId}" 不在当前作用域内。`,
      `当前作用域设施：${deps.facilityId}`,
    );
  }
  return null;
}

// ─── facility_query（§5.5 L1 / 附录 F 第 7 号）───────────────────────────────

function makeFacilityQuery(deps: FacilityToolDeps): ToolExecute {
  return async (_toolCallId, params) => {
    const scope = scopeCheck(deps, params.facilityId);
    if (scope) return scope;

    const domain = params.domain;
    if (typeof domain !== "string" || !(FACILITY_DOMAINS as readonly string[]).includes(domain)) {
      return toolError(
        "ARG_INVALID",
        `domain 必填且 ∈ {${FACILITY_DOMAINS.join(" | ")}}。`,
        `收到：${JSON.stringify(domain)}`,
      );
    }

    const file = FACILITY_DOMAIN_FILES[domain];
    if (file === undefined) {
      // resources / pricing / relations 是合法域但扁平 schema 无对应文件（§5.5 差异说明）。
      return ok(
        { facilityId: deps.facilityId, domain, unavailable: true },
        { note: "本设施的扁平蓝本未提供此功能域文件。" },
      );
    }

    const identityDir = identityDirOf(deps.db, deps.facilityId);
    if (!identityDir) {
      return toolError("SECTION_MISSING", "本人实例模板目录不存在。");
    }
    try {
      assertSafeSegment(file, "domain");
    } catch {
      return toolError("ARG_INVALID", `功能域映射到非法文件名："${file}"。`);
    }
    const path = join(deps.root, identityDir, `${file}.yaml`);
    if (!existsSync(path)) {
      return toolError("SECTION_MISSING", `功能域 "${domain}" 的模板文件缺失。`);
    }

    // 解析成结构化数据返回（只读模型，与 identity_read 同构，§5.3 三要点：路径由闭包+白名单拼出）。
    const raw = readFileSync(path, "utf8");
    const structured = parseYamlText<unknown>(raw, path);
    return ok(
      { facilityId: deps.facilityId, domain, data: structured },
      { tokenEstimate: Math.ceil(Buffer.byteLength(raw, "utf8") / 4), source: "instance_template" },
    );
  };
}

// ─── facility_report（§16.3 / 附录 F 第 8 号）────────────────────────────────

function makeFacilityReport(deps: FacilityToolDeps): ToolExecute {
  return async (_toolCallId, params) => {
    const scope = scopeCheck(deps, params.facilityId);
    if (scope) return scope;

    let window: number | undefined;
    if (params.window !== undefined) {
      const w = typeof params.window === "number" && Number.isFinite(params.window) ? Math.floor(params.window) : NaN;
      if (!Number.isInteger(w) || w <= 0) {
        return toolError("ARG_INVALID", `window 必须是正整数（最近 N 条），收到：${JSON.stringify(params.window)}。`);
      }
      window = w;
    }

    // 聚合计数（不暴露原始流水，§16.3）。
    const rows = deps.db.prepare<[string], { kind: string; c: number }>(
      `SELECT kind, COUNT(*) AS c FROM facility_records WHERE owner_agent = ? GROUP BY kind`,
    ).all(deps.facilityId);
    const agg = { usage: 0, incident: 0, maintenance: 0 };
    let total = 0;
    for (const r of rows) {
      if (r.kind === "usage" || r.kind === "incident" || r.kind === "maintenance") {
        agg[r.kind] += r.c;
        total += r.c;
      }
    }

    return ok(
      { facilityId: deps.facilityId, total, byKind: agg, window: window ?? null },
      { window },
    );
  };
}

// ─── facility_record（§16.3 / 附录 F 第 10 号）──────────────────────────────

function makeFacilityRecord(deps: FacilityToolDeps): ToolExecute {
  return async (_toolCallId, params) => {
    const scope = scopeCheck(deps, params.facilityId);
    if (scope) return scope;

    const kind = params.kind;
    if (typeof kind !== "string" || !(RECORD_KINDS as readonly string[]).includes(kind)) {
      return toolError("ARG_INVALID", `kind 必填且 ∈ {${RECORD_KINDS.join(" | ")}}。`);
    }
    const data = params.data;
    if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) {
      return toolError("ARG_INVALID", "data 必填（结构化对象）。");
    }

    const now = (deps.now ?? (() => new Date().toISOString()))();
    const recordId = newId("fr");
    deps.db
      .prepare(
        `INSERT INTO facility_records (record_id, owner_agent, kind, data_json, scene_id, virtual_ts, real_ts)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(recordId, deps.facilityId, kind, JSON.stringify(data), now);

    // 仅追加、不经 LLM 改写：返回值极短，只回 recordId。
    return ok({ ok: true, recordId }, { kind });
  };
}

// ─── facility_enforce（§3.8 / 附录 F 第 9 号）───────────────────────────────

/** create 时落 agent_state 的约束键。 */
const KEY_CONSTRAINTS = "facility_constraints";
const KEY_LIVE = "facility_live";
const KEY_META = "facility_meta";

function stateJson<T>(db: Database.Database, facilityId: string, key: string): T | null {
  const row = db
    .prepare<[string, string], { value_json: string | null }>(
      "SELECT value_json FROM agent_state WHERE agent_id = ? AND key = ?",
    )
    .get(facilityId, key);
  if (!row?.value_json) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

function makeFacilityEnforce(deps: FacilityToolDeps): ToolExecute {
  return async (_toolCallId, params) => {
    const scope = scopeCheck(deps, params.facilityId);
    if (scope) return scope;

    const action = params.action;
    if (typeof action !== "string" || action.trim().length === 0) {
      return toolError("ARG_INVALID", "action 必填（规则 id 或规则文本关键字）。");
    }

    const constraints = stateJson(
      deps.db,
      deps.facilityId,
      KEY_CONSTRAINTS,
    ) as Array<{ id: string; text: string; severity: string; violationResponse?: string }> | null;
    if (!constraints || constraints.length === 0) {
      return toolError("RULE_UNDEFINED", `rules 未覆盖该 action："${action}"。`);
    }

    // 规则解析：优先 id 精确匹配，其次 text 子串（action 作为关键字）。
    const rule =
      constraints.find((c) => c.id === action) ??
      constraints.find((c) => c.text.includes(action) || action.includes(c.text));

    if (!rule) {
      return toolError("RULE_UNDEFINED", `rules 未覆盖该 action："${action}"。`);
    }

    // 数字门：容量阈值是扁平 schema 唯一的数值型物理约束。若当前占用（usage 流水条数）
    // 已触顶，且该规则是硬性约束，则判定 allowed=false（「座位已满」）。
    const meta = stateJson<{ report_target?: string }>(deps.db, deps.facilityId, KEY_META);
    const live = stateJson<{ capacity?: unknown; time_window?: unknown }>(deps.db, deps.facilityId, KEY_LIVE);
    const capacity = typeof live?.capacity === "number" && live.capacity > 0 ? live.capacity : undefined;

    let allowed = true;
    let reason = rule.text;
    let escalation = meta?.report_target;

    if (capacity !== undefined && rule.severity === "hard") {
      const usage = (deps.db
        .prepare<[string], { c: number }>(
          "SELECT COUNT(*) AS c FROM facility_records WHERE owner_agent = ? AND kind = 'usage'",
        )
        .get(deps.facilityId) as { c: number }).c;
      if (usage >= capacity) {
        allowed = false;
        reason = `已达容量上限（占用 ${usage}/${capacity}）：${rule.text}`;
        if (rule.violationResponse) reason += `（违反响应：${rule.violationResponse}）`;
      }
    }

    const result: Record<string, unknown> = { allowed, reason };
    if (escalation !== undefined) result.escalation = escalation;
    return ok(result, { action, agent: params.agent, time: params.time });
  };
}

/** R11：装配设施四工具处理器（owner 锁死本人 facilityId）。 */
export function makeFacilityDomainTools(deps: FacilityToolDeps): {
  facility_query: ToolExecute;
  facility_report: ToolExecute;
  facility_enforce: ToolExecute;
  facility_record: ToolExecute;
} {
  return {
    facility_query: makeFacilityQuery(deps),
    facility_report: makeFacilityReport(deps),
    facility_enforce: makeFacilityEnforce(deps),
    facility_record: makeFacilityRecord(deps),
  };
}