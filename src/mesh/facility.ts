// ═══════════════════════════════════════════════════════════════════════════
// 设施工具面（§3.8 设施四工具）——facility Account 的四个领域工具
//
// 设施（facility）不是 persona：无身份编译、无主观记忆。它的工具面 = mesh 内建子集
// （BUILTIN_WHITELIST.facility）+ 这里四个领域工具。全部封闭定义在 tools.ts：
//   facility_query   / facility_report / facility_enforce / facility_record
//
// constraints：
//   · 应答必须携带当前 correlationId（§3.2）——facility 只应答、不主动发起。
//   · 产生消息的工具只有 facility_enforce（kind:"event"，走 Router.route，§21.4 ②）。
//
// 分层纪律：本文件在 src/mesh/**，允许 import `@pi/agent-mesh`（type-only 在此经
// tools.js 的 ToolDefinition）。
// ═══════════════════════════════════════════════════════════════════════════

import type { ToolDefinition } from "@pi/agent-mesh/core";

import { makeDomainTool, type DomainToolHandlers } from "./tools.js";

export type FacilityToolHandlers = Pick<
  DomainToolHandlers,
  "facility_query" | "facility_report" | "facility_enforce" | "facility_record"
>;

const FACILITY_TOOL_NAMES = [
  "facility_query",
  "facility_report",
  "facility_enforce",
  "facility_record",
] as const;

/** 构建 facility Account 的四个领域工具；handler 缺省为「未实装」占位（P3/P4 注入）。 */
export function makeFacilityTools(handlers: FacilityToolHandlers = {}): ToolDefinition[] {
  return FACILITY_TOOL_NAMES.map((n) => makeDomainTool(n, handlers));
}