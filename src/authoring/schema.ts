// ═══════════════════════════════════════════════════════════════════════════
// 蓝本 schema ×2（§24.2）：identity / facility
//
// 「通用」的全部代价就是这张数据（§24.2）。两个实现共享同一个 `BlueprintSchema` 接口，
// 差异只在 requiredFiles / optionalFiles / fileSpecs / neverInfer / validate 的分支。
//
// validate 的三件硬活：
//   1. identity 直接复调 agents.create() 用的那个 loader（compileIdentity）——§24.1.1
//      「格式的定义方就该持有格式的生成方，生成器用同一份校验规则」的实现体现；
//   2. 授权期 mesh 禁令扫描（§4.1）：蓝本里不得出现 accountId/endpointId/conversationId/
//      topology/defaultGrade/seq/seal/from 等 mesh/系统层字段（initiate 只在协议文件豁免）；
//   3. §4.2 步骤 1 的 manifest.files 与实际文件一一对应（无孤儿文件、无登记缺失）。
//
// facility 在 v2 没有 compile 载荷（设施无身份编译，§3.2/§5.5），故 facility 的 validate
// 落到结构校验：必读文件在、YAML 可解析、protocol.initiate 合法、无 mesh 禁令。
//
// 分层纪律（§22.4 约束 2）：本文件 import compile/（loader）与 runtime/errors（叶子），
// 不得 import mesh/db/memory/scene/agent。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { compileIdentity } from "../compile/identity-loader.js";
import { parseYamlText, readYamlFile } from "../compile/yaml.js";
import { COMPILER_VERSION } from "../compile/version.js";
import type { ModelConfig } from "../compile/types.js";
import { ValidationError } from "../runtime/errors.js";
import type {
  BlueprintSchema,
  BlueprintSchemaKind,
  FileSpec,
  ValidationReport,
} from "./types.js";

// ─── 授权期 mesh 禁令（§4.1）────────────────────────────────────────────────

/** 蓝本里不得出现的 mesh/系统层字段。 */
const BANNED_KEYS = [
  "accountId",
  "endpointId",
  "conversationId",
  "topology",
  "defaultGrade",
  "seq",
  "seal",
  "from",
] as const;

/** initiate 只允许出现在协议文件（§4.1：能力/发起权宣告是被 §4.2.1 消费的领域字段）。 */
const INITIATE_ALLOWED: ReadonlySet<string> = new Set(["agent_protocol", "protocol"]);

/** initiate 的五值封闭集（与 §4.2.1 同一张表）。 */
const MESSAGE_KINDS = new Set(["chat", "task", "event", "system", "tombstone"]);

/** 校验用的假模型配置（ctx.modelConfig 只落进 spec，不参与校验判定）。 */
const DUMMY_MODEL: ModelConfig = {
  dialogue: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "low" },
  budget: { onExceed: "warn" },
};

interface Manifest {
  identity?: { id?: string };
  facility?: { id?: string };
  files?: Array<{ path?: string }>;
}

/** 文件基名（去 .yaml / .yml 后缀）。 */
function fileBaseOf(name: string): string {
  return name.replace(/\.(yaml|yml)$/, "");
}

/** 一个目录里的蓝图文件（顶层 .yaml / .yml）。 */
function listBlueprintFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => /\.(yaml|yml)$/.test(n))
    .sort();
}

/** 递归遍历一个 YAML 对象，收集命中 mesh 禁令的字段路径（§4.1 扫描）。 */
function collectBannedKeys(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectBannedKeys(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const p = path === "" ? key : `${path}.${key}`;
    if ((BANNED_KEYS as readonly string[]).includes(key)) out.push(p);
    collectBannedKeys(child, p, out);
  }
}

/** 对单个 YAML 文本做 mesh 禁令扫描。fileBase 用于豁免协议文件里的 initiate。 */
function scanYamlForBans(yamlText: string, fileBase: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseYamlText<unknown>(yamlText, `${fileBase}.yaml`);
  } catch (err) {
    return [`invalid YAML: ${(err as Error).message}`];
  }
  const hits: string[] = [];
  collectBannedKeys(parsed, "", hits);
  return hits.filter((p) => !INITIATE_ALLOWED.has(fileBase) || p !== "initiate");
}

/** initiate 封闭集校验（§4.2.1 硬约束：出现五值之外的词即失败）。 */
function collectInitiateErrors(yamlText: string, out: string[]): void {
  let parsed: unknown;
  try {
    parsed = parseYamlText<unknown>(yamlText, "protocol");
  } catch {
    return; // 解析错误已由其它检查捕获
  }
  const initiate = (parsed as { initiate?: unknown } | null | undefined)?.initiate;
  if (initiate === undefined) return;
  const list = Array.isArray(initiate) ? initiate : [initiate];
  for (const word of list) {
    if (typeof word !== "string" || !MESSAGE_KINDS.has(word)) {
      out.push(`initiate 出现五值封闭集之外的词: ${String(word)}`);
    }
  }
}

// ─── 结构校验（与 loader 无关的部分，identity/facility 共用）────────────────

async function validateStructure(dir: string, schema: BlueprintSchema): Promise<ValidationReport> {
  const errors: string[] = [];
  const onDisk = listBlueprintFiles(dir);

  // ① 必读文件齐全（§24.2 requiredFiles）。
  for (const file of schema.requiredFiles) {
    if (!onDisk.includes(`${file}.yaml`)) errors.push(`missing required file: ${file}.yaml`);
  }

  // ② mesh 禁令 + initiate 封闭集 + YAML 解析（每个文件）。
  for (const name of onDisk) {
    const text = readFileSync(join(dir, name), "utf8");
    const fileBase = fileBaseOf(name);
    errors.push(...scanYamlForBans(text, fileBase));
    if (INITIATE_ALLOWED.has(fileBase)) collectInitiateErrors(text, errors);
  }

  // ③ manifest.files 与实际文件一一对应（§4.2 步骤 1 / §24.6 第 4 步的孤儿文件判决）。
  const manifest = readYamlFile<Manifest>(join(dir, "manifest.yaml"), { optional: true });
  if (manifest?.files != null) {
    const declared = new Set(
      manifest.files.map((f) => f.path).filter((p): p is string => !!p),
    );
    for (const d of onDisk) {
      // provenance.yaml 必须登记进 manifest.files（§24.6 第 4 步），否则判为孤儿文件。
      if (!declared.has(d)) errors.push(`orphan file not declared in manifest.files: ${d}`);
    }
    for (const p of declared) {
      if (!existsSync(join(dir, p))) errors.push(`manifest.files declares missing file: ${p}`);
    }
  }

  return { ok: errors.length === 0, errors, conflicts: [] };
}

// ─── identity schema（复用 loader）─────────────────────────────────────────

const IDENTITY_FILE_SPECS: Record<string, FileSpec> = {
  manifest: {
    file: "manifest",
    required: true,
    core: false,
    description: "文件集清单。由 scaffold 生成，模型无需填写。",
    keywords: ["蓝本", "清单"],
    neverInferFields: [],
    fields: { "identity.id": "蓝本 id（角色类型命名，如 teacher-generic）" },
  },
  personal: {
    file: "personal",
    required: true,
    core: true,
    description: "基础身份：姓名（绝不推断）、年龄、性别、职务。",
    keywords: ["名字", "姓名", "年龄", "岁", "性别", "男", "女", "身份", "职务", "担任", "老师", "教师", "学生", "教授"],
    neverInferFields: ["name.full"],
    fields: {
      "name.full": "真实姓名（neverInfer：只能原文照搬）",
      age: "年龄（数字或字符串）",
      gender: "性别",
      role: "职务/身份一句话",
    },
  },
  constraints: {
    file: "constraints",
    required: true,
    core: true,
    description: "禁区/红线：list 或 {constraints:[]}，每条 {text, severity:hard|soft}。",
    keywords: ["不得", "禁止", "不能", "必须", "约束", "纪律", "红线", "禁区", "从不", "拒绝", "绝不", "底线"],
    neverInferFields: [],
    fields: {
      constraints: "约束条目数组；每个 {id?, text, severity: hard|soft, priority_order?, violation_response?}",
    },
  },
  evolution: {
    file: "evolution",
    required: true,
    core: true,
    description: "初始情绪/精力基线（mood / moodIntensity∈[0,1] / energy∈[0,1]）。",
    keywords: ["情绪", "心情", "精力", "状态", "气质"],
    neverInferFields: [],
    fields: { mood: "初始情绪", moodIntensity: "情绪强度 0..1", energy: "精力 0..1" },
  },
  narrative_voice: {
    file: "narrative_voice",
    required: true,
    core: true,
    description: "说话方式：default_mode + fingerprint（句首/句尾/标点/比喻域）+ sensory。",
    keywords: ["语气", "说话", "口吻", "措辞", "句式", "口癖", "口头禅", "叙述", "表达"],
    neverInferFields: [],
    fields: {
      default_mode: "默认叙事模式",
      "fingerprint.sentence_starters": "句式开头（数组）",
      "fingerprint.enders": "句式结尾（数组）",
      "fingerprint.metaphor_domains": "比喻来源",
    },
  },
  agent_protocol: {
    file: "agent_protocol",
    required: true,
    core: true,
    description: "能力宣告 capabilities[] + 发起权 initiate[]（⊆ chat/task/event/system/tombstone，缺省 [chat]）。",
    keywords: ["能", "会", "擅长", "可以", "能力", "专长", "发起", "主动"],
    neverInferFields: [],
    fields: { capabilities: "能力字符串数组", initiate: "发起权 ⊆ {chat,task,event,system,tombstone}" },
  },
  psychology: {
    file: "psychology",
    required: false,
    core: false,
    description: "性格气质（personality: string[]）。",
    keywords: ["性格", "脾气", "内向", "外向", "认真", "幽默", "温柔", "严厉", "细致"],
    neverInferFields: [],
    fields: { personality: "性格标签数组" },
  },
  academic: {
    file: "academic",
    required: false,
    core: false,
    description: "学业/专业背景（education.stage；机构名绝不推断）。",
    keywords: ["学历", "年级", "初中", "高中", "大学", "小学", "学科", "专业", "成绩", "教学", "语文", "数学", "物理"],
    neverInferFields: ["education.institution"],
    fields: { "education.stage": "学段（如「中学」「大学」）", "education.institution": "具体机构名（neverInfer）" },
  },
  goals: {
    file: "goals",
    required: false,
    core: false,
    description: "目标（objectives.immediate；可识别的个人经历绝不推断）。",
    keywords: ["目标", "希望", "志向", "想法", "计划", "心愿"],
    neverInferFields: ["objectives.immediate"],
    fields: { "objectives.immediate": "近期目标（neverInfer）" },
  },
  relationships: {
    file: "relationships",
    required: false,
    core: false,
    description: "信任默认值（trust_defaults: {人名: 0..1}；人名绝不推断）。",
    keywords: ["关系", "信任", "朋友", "同事", "同学", "与", "熟悉"],
    neverInferFields: ["trust_defaults"],
    fields: { trust_defaults: "信任默认值映射（key 是具体人名，neverInfer）" },
  },
  knowledge_boundaries: {
    file: "knowledge_boundaries",
    required: false,
    core: false,
    description: "知识边界（knowledge: [{topic, claim}]）。",
    keywords: ["不懂", "不知道", "不了解", "知识边界", "不熟悉", "没学过"],
    neverInferFields: [],
    fields: { knowledge: "知识边界数组 {topic, claim}" },
  },
};

const IDENTITY_COLD_START = ["manifest", "personal", "constraints", "evolution", "narrative_voice", "agent_protocol"] as const;
const IDENTITY_OPTIONAL = ["psychology", "academic", "goals", "relationships", "knowledge_boundaries"] as const;

/** identity neverInfer 全路径（§24.2「真实人名/具体机构名/可识别的个人经历」）。 */
const IDENTITY_NEVER_INFER = [
  "personal.name.full",
  "relationships.trust_defaults",
  "goals.objectives.immediate",
  "academic.education.institution",
] as const;

export const identitySchema: BlueprintSchema = {
  kind: "identity",
  requiredFiles: [...IDENTITY_COLD_START],
  optionalFiles: [...IDENTITY_OPTIONAL],
  fileSpecs: IDENTITY_FILE_SPECS,
  neverInfer: [...IDENTITY_NEVER_INFER],
  async validate(dir: string): Promise<ValidationReport> {
    const structural = await validateStructure(dir, this);
    if (!structural.ok) return structural;

    // 复用 agents.create() 的同一份 loader（§24.1.1）。loader 抛 ValidationError → errors。
    try {
      await compileIdentity(dir, {
        agentId: "authoring-validate",
        modelConfig: DUMMY_MODEL,
        compilerVersion: COMPILER_VERSION,
      });
      return { ok: true, errors: [], conflicts: [] };
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : (err as Error).message;
      return { ok: false, errors: [message], conflicts: [] };
    }
  },
};

// ─── facility schema（结构校验）────────────────────────────────────────────

const FACILITY_FILE_SPECS: Record<string, FileSpec> = {
  manifest: {
    file: "manifest",
    required: true,
    core: false,
    description: "文件集清单。由 scaffold 生成。",
    keywords: ["设施", "清单"],
    neverInferFields: [],
    fields: { "facility.id": "设施 id（类型命名，如 classroom-generic）" },
  },
  facility: {
    file: "facility",
    required: true,
    core: true,
    description: "职责边界/资源：name、type、duties[]（含 neverInfer：处罚力度/条款号/上报对象）。",
    keywords: ["教室", "图书馆", "实验室", "机房", "职责", "边界", "资源", "容量", "设施"],
    neverInferFields: ["concrete_penalty", "regulation_clause", "report_target"],
    fields: {
      name: "设施名（类型）",
      type: "设施类型 classroom|library|...",
      duties: "职责边界条目数组",
      concrete_penalty: "具体处罚力度（neverInfer）",
      regulation_clause: "法规条款号（neverInfer）",
      report_target: "上报对象（neverInfer）",
    },
  },
  protocol: {
    file: "protocol",
    required: true,
    core: true,
    description: "协议条目：capabilities[] + initiate（设施恒为 []，只应答不发起）。",
    keywords: ["能", "会", "可以", "能力", "应答", "协议", "接口"],
    neverInferFields: [],
    fields: { capabilities: "能力字符串数组", initiate: "发起权（设施应为空数组 []）" },
  },
  constraints: {
    file: "constraints",
    required: true,
    core: true,
    description: "判定约束/硬规则阈值方向。",
    keywords: ["不得", "禁止", "必须", "规则", "阈值", "约束", "超", "满"],
    neverInferFields: [],
    fields: { constraints: "约束条目数组" },
  },
  records: {
    file: "records",
    required: false,
    core: false,
    description: "记录模板（usage/incident/maintenance 流水字段）。",
    keywords: ["记录", "日志", "流水", "借还", "登记"],
    neverInferFields: [],
    fields: { record_types: "记录类型数组" },
  },
  thresholds: {
    file: "thresholds",
    required: false,
    core: false,
    description: "判定阈值（数字型）。",
    keywords: ["阈值", "上限", "下限", "超过", "容量", "时间窗"],
    neverInferFields: [],
    fields: { capacity: "容量阈值", time_window: "时间窗" },
  },
};

const FACILITY_REQUIRED = ["manifest", "facility", "protocol", "constraints"] as const;
const FACILITY_OPTIONAL = ["records", "thresholds"] as const;
const FACILITY_NEVER_INFER = [
  "facility.concrete_penalty",
  "facility.regulation_clause",
  "facility.report_target",
] as const;

export const facilitySchema: BlueprintSchema = {
  kind: "facility",
  requiredFiles: [...FACILITY_REQUIRED],
  optionalFiles: [...FACILITY_OPTIONAL],
  fileSpecs: FACILITY_FILE_SPECS,
  neverInfer: [...FACILITY_NEVER_INFER],
  async validate(dir: string): Promise<ValidationReport> {
    return validateStructure(dir, this);
  },
};

/** kind → schema（§24.2 差异外置成数据，一个查表即得）。 */
export function schemaFor(kind: BlueprintSchemaKind): BlueprintSchema {
  return kind === "identity" ? identitySchema : facilitySchema;
}

/** neverInfer 字段按其所属文件分组（验收 2「neverInfer 名下文件为空」的判据）。 */
export function neverInferFiles(schema: BlueprintSchema): Set<string> {
  const files = new Set<string>();
  for (const path of schema.neverInfer) files.add(path.split(".")[0]!);
  return files;
}