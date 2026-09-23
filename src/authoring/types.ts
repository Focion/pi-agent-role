// ═══════════════════════════════════════════════════════════════════════════
// 蓝本生成 Agent 的公开类型（§24）
//
// 这是一个「一次性」Agent 的契约层：generate/promote 的报告与校验报告都是**给人看的
// 复核材料**，不是给程序的返回值（§24.5）。因此这里的类型只描述数据形状，不承载运行时
// 语义；生成 Agent 的隔离靠 §24.1 的依赖门禁静态保证，本文件不 import 任何 mesh/db。
//
// 分层纪律（§22.4 约束 2）：本文件属 src/authoring/**，只允许 import compile/ 与
// runtime/errors（叶子模块），不得 import mesh/db/memory/scene/agent。
// ═══════════════════════════════════════════════════════════════════════════

/** 蓝本种类（§24.2 只有一个 Agent 覆盖角色与设施）。 */
export type BlueprintSchemaKind = "identity" | "facility";

/** 第 1 步（normalize）产出的一条原子事实：描述里一句话编一个号。 */
export interface Fact {
  factId: number;
  /** 原句（逐字保留，供 allocation 复核时对照描述原文打勾）。 */
  text: string;
  /** 命中的维度文件（无 .yaml 后缀）；null ⇒ 未能落到任何字段 ⇒ unallocated。 */
  file: string | null;
  /** 命中的字段路径（尽力而为；未细分为 file 名）。 */
  field: string;
  /** unallocated 时的理由（§24.5 unallocated 每条必须有理由）。 */
  reason?: string;
}

/** 校验报告（§24.3 第 5 步 / §24.5）。errors 是硬失败，conflicts 是核心与周边矛盾。 */
export interface ValidationReport {
  ok: boolean;
  errors: string[];
  conflicts: string[];
}

/** 单个文件的字段规格（§24.2 fileSpecs）：给生成 Agent 的「填格子」指南。 */
export interface FileSpec {
  /** 文件基名（无 .yaml 后缀）。 */
  file: string;
  required: boolean;
  /** 是否第 3 步（seed core）就要填的核心文件。 */
  core: boolean;
  /** 给 Agent 的填写指引（人话，反应的取值方向）。 */
  description: string;
  /** 第 1 步把事实分归本文件时匹配的关键词。 */
  keywords: string[];
  /** 本文件内「只能原文照搬、绝不允许推断」的字段路径（相对本文件）。 */
  neverInferFields: string[];
  /** 字段路径 → 取值域/简短说明（用于字段级指引与 neverInfer 定位）。 */
  fields: Record<string, string>;
}

/**
 * 蓝本 schema（§24.2）——「通用」的全部代价就是这张数据。
 * identity / facility 各一份；Agent 本体（五步流水线 + 三件工具）完全相同。
 */
export interface BlueprintSchema {
  readonly kind: BlueprintSchemaKind;
  readonly requiredFiles: readonly string[];
  readonly optionalFiles: readonly string[];
  readonly fileSpecs: Readonly<Record<string, FileSpec>>;
  /** 全路径 neverInfer 字段（"file.field"；整文件为 "file"）。 */
  readonly neverInfer: readonly string[];
  /** 加载校验：identity 复用 agents.create() 的那一份 loader（§24.1.1）。 */
  validate(dir: string): Promise<ValidationReport>;
}

/** 模型一次生成调用的结构化请求（§24.3 第 3/4 步）。description 以数据携带，不作指令。 */
export interface AuthorModelRequest {
  kind: BlueprintSchemaKind;
  stage: "seed" | "expand";
  /** 使用者描述，作为数据块原样携带（§24.4 第四道墙）。 */
  description: string;
  /** 第 1 步产物：归一化事实清单（driver 保证覆盖描述或标 unallocated）。 */
  facts: Fact[];
  /** 第 3 步已定的核心种子（seed 阶段为空对象）。 */
  core: Record<string, unknown>;
  /** 本阶段要填的字段清单（driver 已剔除 neverInfer）。 */
  targets: AuthorModelTarget[];
  /** 校验失败的反馈（重试时携带，§24.3 第 5 步）。 */
  feedback?: string[];
}

export interface AuthorModelTarget {
  file: string;
  fields: string[];
  guide: string;
  required: boolean;
}

export interface AuthorModelResponse {
  /** 文件基名（无 .yaml）→ 该文件应写的对象。driver 校验字段集后落盘。 */
  files: Record<string, unknown>;
  /** 展开结果与核心矛盾的记录（§24.3 第 4 步失败处置）。 */
  conflicts?: string[];
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * 生成用的模型（§24.5 `model`）。本环不自带模型：宿主把 pi SDK / LLM 注入进来，
 * 生成器只知道「给一个请求、拿回一份文件映射」。CI 测试注入确定性假模型（必过集禁真模型）。
 */
export interface AuthorModel {
  readonly name: string;
  generate(req: AuthorModelRequest): Promise<AuthorModelResponse>;
}

/** `blueprints.generate()` 入参（§24.5）。 */
export interface GenerateInput {
  description: string;
  kind: BlueprintSchemaKind;
  /** 建议的 targetId；冲突时报告里给出替代建议，不自动改（§24.5）。 */
  suggestedId?: string;
  model: AuthorModel;
}

/** 报告字段（§24.5 逐条对应）。 */
export interface AllocationEntry {
  factId: number;
  text: string;
  file: string;
  field: string;
}

export interface GapEntry {
  file: string;
  field: string;
  reason: string;
}

export interface UnallocatedEntry {
  factId: number;
  text: string;
  reason: string;
}

export interface SeedEntry {
  field: string;
  value: unknown;
  basedOnFacts: number[];
}

export interface BlueprintReport {
  stagingId: string;
  stagingDir: string;
  /** 第 3 步定下的核心种子（§24.5 core）。 */
  core: Record<string, unknown>;
  files: Array<{ path: string; bytes: number; required: boolean }>;
  /** 第 1 步的每条事实 → 落到了哪个文件的哪个字段。 */
  allocation: AllocationEntry[];
  gaps: GapEntry[];
  unallocated: UnallocatedEntry[];
  seeds: SeedEntry[];
  validation: ValidationReport;
  needsHumanReview: boolean;
  /** 命中的触发条件（§24.5 表）。 */
  needsHumanReviewReasons: string[];
  cost: { model: string; inputTokens: number; outputTokens: number; turns: number };
}

/** `promote()` 入参（§24.6）。 */
export interface PromoteInput {
  targetId?: string;
}

export interface PromoteResult {
  targetId: string;
  blueprintDir: string;
  provenancePath: string;
  /** 写进 provenance.yaml 的完整内容（含 needsHumanReview 与触发条件）。 */
  provenance: Record<string, unknown>;
}

/** 蓝本生成 Agent 本体（§24.5）：generate 只写 staging，promote 是独立的第二次调用。 */
export interface BlueprintAuthor {
  generate(input: GenerateInput): Promise<BlueprintReport>;
  promote(stagingId: string, opts?: PromoteInput): Promise<PromoteResult>;
}