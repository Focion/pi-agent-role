// ═══════════════════════════════════════════════════════════════════════════
// 主体解析（§16.1）—— `(subject_type, subject_id)` 二元组的唯一解析入口
//
// 主体空间（person/facility/self/knowledge/curriculum/group）比 mesh 的 accountId 空间
// 更大也更小（§16.1.2）：`subject_id` 指向 Agent 时用 `agent_id`，accountId 一律不得出现在
// `episode_subjects` / `subject_profiles` / `knowledge_items.taught_by` 的任何列（N2）。
//
// 本文件只做纯解析（无 IO）。不变量 N1：任何 `<x>:reflect` 形态的 id 一律拒绝。N2（person
// 且非 npc: 前缀必须能在 agents.agent_id 中查到）需要注册表闭包，由上层 remember 工具注入
// 校验，不进本文件。
// ═══════════════════════════════════════════════════════════════════════════

import { ValidationError } from "../runtime/errors.js";

/** 六类主体（§16.1.1）。 */
export type SubjectType = "person" | "facility" | "self" | "knowledge" | "curriculum" | "group";

export interface SubjectRef {
  type: SubjectType;
  id: string;
}

const SUBJECT_TYPES: ReadonlySet<string> = new Set<string>([
  "person",
  "facility",
  "self",
  "knowledge",
  "curriculum",
  "group",
]);

/** N1：`<x>:reflect` 形态（含裸 `reflect`）不得作为 subject_id。 */
const REFLECT_ID_RE = /(^|:)reflect$/;

/**
 * 解析一个主体引用字符串为 `{type, id}`。
 *
 * 序列化形态（§16.1.1）：`self` 单独成串；其余为 `type:id`，id 内部可再含冒号
 * （如 `person:npc:mother`、`kn:newton-2nd-law`）。type 取值六值，越界 / 空 id / N1 违反
 * 一律抛 `ValidationError`（写入端把非法主体当作数据缺陷，而非静默降级）。
 */
export function parseSubjectRef(serialized: string): SubjectRef {
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new ValidationError(`empty subjectRef`);
  }
  if (serialized === "self") return { type: "self", id: "self" };

  const colon = serialized.indexOf(":");
  if (colon <= 0 || colon === serialized.length - 1) {
    throw new ValidationError(`malformed subjectRef (want "type:id"): "${serialized}"`);
  }
  const type = serialized.slice(0, colon);
  const id = serialized.slice(colon + 1);
  if (!SUBJECT_TYPES.has(type)) {
    throw new ValidationError(`unknown subject type: "${type}" (six-value set)`);
  }
  if (id === "self") {
    // self 只能是裸字面量 "self"，不允许写成 "#type:self"。
    throw new ValidationError(`"self" must be the bare literal (got "${serialized}")`);
  }
  if (REFLECT_ID_RE.test(id)) {
    throw new ValidationError(`subject_id must not contain "<x>:reflect" (N1): "${serialized}"`);
  }
  return { type: type as SubjectType, id };
}

/** 序列化回字符串（与 parseSubjectRef 互为逆。self 序列化为 "self"）。 */
export function serializeSubjectRef(ref: SubjectRef): string {
  if (ref.type === "self") return "self";
  return `${ref.type}:${ref.id}`;
}

/** 批量解析；任一非法即整体抛错（all-or-nothing，避免半条记忆挂一半主体）。 */
export function parseSubjectRefs(serialized: string[] | undefined): SubjectRef[] {
  if (!serialized || serialized.length === 0) return [];
  return serialized.map((s) => parseSubjectRef(s));
}

/**
 * N2 校验：person 主体若非 `npc:` 前缀，其 id 必须能在已知 agent 集合中查到。
 * 已知 agent 集合是注册表快照（agent_id 全集），由上层注入。返回违规的 refs（可为空）。
 */
export function unknownPersons(refs: SubjectRef[], knownAgents: ReadonlySet<string>): SubjectRef[] {
  return refs.filter(
    (r) => r.type === "person" && !r.id.startsWith("npc:") && !knownAgents.has(r.id),
  );
}