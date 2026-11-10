// ═══════════════════════════════════════════════════════════════════════════
// 设施编译器（§5.5 FacilitySpec）——设施蓝本 → FacilitySpec
//
// 设施不是 persona：无心理/情绪/目标，有物理约束与规则执行（C7）。compileFacility 把
// 「实例模板目录」（一组 YAML，§6.1 与 authoring/schema.ts 的 facility schema 一致）编译成
// FacilitySpec：systemPrompt = 路由表 + 硬约束速查 + 同一份「关于你收到的消息」固定文案
// （§5.5：该段对设施逐字相同，设施是最容易被提示注入的一类 Agent）。
//
// 与 identity-loader 的关键差异全表见 §5.5；这里落到代码的只有三条：
//   1. mesh.initiate 恒为 []（主动发起由 mesh 闸② reject，不靠提示词自律，§3.2）；
//   2. mesh.defaultGrade 恒为 "steer"（设施的应答通常是被等着的，压后无意义）；
//   3. 记忆模型是数字型状态 + 事实流水，不是主观情节（§16.3）——compiler 只登记
//      initialState（liveState + 初始 records），不产出 episodes。
//
// 说明（设计/实现差异，不静默覆盖）：§5.5 描述设施蓝本为 `MODEL.md + profile/ + state/ +
// scenarios/` 多文件模型；本库 authoring/schema.ts（代码权威）用扁平的
// manifest/facility/protocol/constraints/records/thresholds 六文件。本编译器按后者读取，
// profile/ 的 lazySections 退化为「按功能域映射到这六个文件」；resources/pricing/relations
// 三个域没有对应文件，facility_query 报「不可得」而非伪造。
//
// 分层纪律（§22.4 #4）：本文件属 src/compile/**，不 import @pi/agent-mesh；mesh 类型经
// ../mesh/public-types.js，领域工具集经 ../mesh/tools.js。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { MessageKind } from "../mesh/public-types.js";
import { DOMAIN_TOOLS_BY_KIND } from "../mesh/tools.js";
import { ValidationError } from "../runtime/errors.js";
import { fingerprintOf, hashDirectoryContents } from "./fingerprint.js";
import { ABOUT_MESSAGES_SECTION } from "./identity-loader.js";
import { readYamlFile } from "./yaml.js";
import { SPEC_VERSION } from "./types.js";
import type {
  AgentSpecMeshProjection,
  CompiledConstraint,
  FacilityCompileContext,
  FacilityInitialState,
  FacilityLazySection,
  FacilityMemoryPolicy,
  FacilityProtocol,
  FacilitySpec,
  FacilityStateSchema,
} from "./types.js";

// ─── 蓝本文件 schema（authoring/schema.ts facility 分支）─────────────────────

interface FacilityManifest {
  facility?: { id?: string };
  files?: Array<{ path?: string; priority?: "cold_start" | "lazy"; description?: string }>;
}

interface FacilityFile {
  name?: string;
  type?: string;
  duties?: string[] | string;
  concrete_penalty?: unknown;
  regulation_clause?: unknown;
  report_target?: string;
}

interface ProtocolFile {
  capabilities?: string[];
  initiate?: string[];
}

interface ConstraintEntry {
  id?: string;
  text: string;
  severity?: "hard" | "soft";
  priority_order?: number;
  violation_response?: string;
}

interface ConstraintsFile {
  constraints?: ConstraintEntry[];
}

interface ThresholdsFile {
  capacity?: number;
  time_window?: number | string;
}

/** initiate 的五值封闭集（与 §4.2.1 同一张表）。 */
const MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "chat",
  "task",
  "event",
  "system",
  "tombstone",
]);

/**
 * facility_query 的按功能域 → 实例模板文件的映射（§5.5 L1 退化）。
 * resources / pricing / relations 三个域在扁平 schema 中没有对应文件，故意不登记。
 */
export const FACILITY_DOMAIN_FILES: Readonly<Record<string, string>> = {
  basic: "facility",
  rules: "constraints",
  services: "protocol",
  capacity: "thresholds",
  time: "thresholds",
};

/** 参与编译的候选文件（records/thresholds 可选，缺失不报错）。 */
export const FACILITY_COMPILED_FILES = [
  "manifest",
  "facility",
  "protocol",
  "constraints",
  "records",
  "thresholds",
] as const;

function toList(value: string[] | string | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** constraints.yaml 的两种形态（list 或 {constraints:[]}）→ 扁平 CompiledConstraint[]。 */
function normalizeConstraints(raw: ConstraintsFile | ConstraintEntry[] | undefined): CompiledConstraint[] {
  if (raw == null) return [];
  const entries: ConstraintEntry[] = Array.isArray(raw) ? raw : (raw.constraints ?? []);
  const compiled: CompiledConstraint[] = entries.map((entry, index) => ({
    id: entry.id ?? `constraint-${index + 1}`,
    text: entry.text,
    severity: entry.severity ?? "hard",
    priorityOrder: entry.priority_order ?? index + 1,
    violationResponse: entry.violation_response,
  }));
  compiled.sort((a, b) => {
    if (a.severity === b.severity) return a.priorityOrder - b.priorityOrder;
    return a.severity === "hard" ? -1 : 1;
  });
  return compiled;
}

/** §5.5：system prompt = 路由表（你是谁/职责）+ 硬约束速查 + 关于消息固定文案。 */
function buildFacilitySystemPrompt(input: {
  name: string;
  type: string;
  duties: string[];
  constraints: CompiledConstraint[];
  capabilities: string[];
}): string {
  const who = input.duties.length
    ? input.duties.map((d) => `- ${d}`).join("\n")
    : "（模板未提供职责边界。）";
  const cannot = input.constraints.length
    ? input.constraints
        .map((c) => {
          const tag = c.severity === "hard" ? "[硬性]" : "[软性]";
          const tail = c.violationResponse ? `（违反响应：${c.violationResponse}）` : "";
          return `- ${tag} ${c.text}${tail}`;
        })
        .join("\n")
    : "（无硬性约束。）";
  const can = input.capabilities.length
    ? input.capabilities.map((cap) => `- ${cap}`).join("\n")
    : "（无额外能力宣告。）";

  return [
    `你是 ${input.name}，一处「${input.type}」设施。`,
    "",
    "## 你的职责边界",
    who,
    "",
    "## 你的规则速查",
    cannot,
    "",
    "## 你可以做的事",
    can,
    "",
    "## 关于你收到的消息",
    ABOUT_MESSAGES_SECTION,
  ].join("\n");
}

/** §5.5：lazySections 按功能域映射到实例模板文件，tokenEstimate 粗估（字节/4）。 */
function buildLazySections(instanceTemplateDir: string): FacilityLazySection[] {
  const out: FacilityLazySection[] = [];
  // basic 永远指 facility.yaml；其余域按映射表，反查得出「哪些文件提供了哪些域」。
  const sectionFiles: Array<{ section: string; file: string; description: string }> = [
    { section: "basic", file: "facility", description: "设施名/类型/职责边界" },
    { section: "rules", file: "constraints", description: "判定约束与硬规则阈值方向" },
    { section: "services", file: "protocol", description: "能力宣告" },
    { section: "capacity", file: "thresholds", description: "容量阈值" },
    { section: "time", file: "thresholds", description: "时间窗阈值" },
  ];
  for (const { section, file, description } of sectionFiles) {
    const p = join(instanceTemplateDir, `${file}.yaml`);
    let tokenEstimate = 0;
    if (existsSync(p)) {
      tokenEstimate = Math.ceil(statSync(p).size / 4);
    }
    out.push({ section, description, tokenEstimate });
  }
  return out;
}

/** 内存策略占位（§5.5）：设施无自省，短期/长期/衰减按数字聚合的保守默认。 */
function facilityMemoryPolicy(): FacilityMemoryPolicy {
  return {
    shortTermWindow: 50,
    longTermConsolidation: {},
    decay: {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// compileFacility（§5.5 恒定签名）
// ═══════════════════════════════════════════════════════════════════════════

export async function compileFacility(
  instanceTemplateDir: string,
  ctx: FacilityCompileContext,
): Promise<FacilitySpec> {
  const manifest = readYamlFile<FacilityManifest>(join(instanceTemplateDir, "manifest.yaml")) ?? {};
  const facility = readYamlFile<FacilityFile>(join(instanceTemplateDir, "facility.yaml"));
  const protocol = readYamlFile<ProtocolFile>(join(instanceTemplateDir, "protocol.yaml"), { optional: true });
  const constraintsRaw = readYamlFile<ConstraintsFile | ConstraintEntry[]>(
    join(instanceTemplateDir, "constraints.yaml"),
    { optional: true },
  );
  const thresholds = readYamlFile<ThresholdsFile>(join(instanceTemplateDir, "thresholds.yaml"), {
    optional: true,
  });

  // facility.yaml / constraints.yaml 是 facility schema 的必读文件（authoring/schema.ts）。
  if (facility === undefined) {
    throw new ValidationError(`required YAML file missing: ${join(instanceTemplateDir, "facility.yaml")}`);
  }

  const name = facility.name ?? manifest.facility?.id ?? ctx.facilityId;
  const facilityType = facility.type ?? ctx.facilityId;
  const duties = toList(facility.duties);

  // ① initiate：五值封闭集校验（与 §4.2.1 一致）。设施的 mesh 投影恒为 []，但蓝本里若写了
  //    越界词仍判蓝本错；写了合法非空值也强制归零（§5.5 initiate 恒空）。
  const initiateRaw = protocol?.initiate ?? [];
  for (const word of initiateRaw) {
    if (!MESSAGE_KINDS.has(word)) {
      throw new ValidationError(`protocol.initiate 出现闭合集之外的词: "${word}"`);
    }
  }

  const constraints = normalizeConstraints(constraintsRaw);
  const capabilities = [...(protocol?.capabilities ?? [])];

  // ② lazySections（按功能域）。
  const domainTools = [...DOMAIN_TOOLS_BY_KIND.facility] as FacilitySpec["domainTools"];
  const lazySections = buildLazySections(instanceTemplateDir);

  // ③ promptVersion：参与编译的目录内容哈希 + 编译器版本（§4.2 步骤 5 同源）。
  const promptVersion = fingerprintOf([
    await hashDirectoryContents(instanceTemplateDir),
    ctx.compilerVersion,
  ]);

  const systemPrompt = buildFacilitySystemPrompt({
    name,
    type: facilityType,
    duties,
    constraints,
    capabilities,
  });

  // ④ mesh 投影（§4.3 推导表）：accountId 恒等 facilityId，initiate 恒 []，grade 恒 steer。
  const mesh: AgentSpecMeshProjection = {
    accountId: ctx.facilityId,
    displayName: name,
    endpointClass: "stream",
    capabilities: [...capabilities, "kind:facility"],
    initiate: [],
    defaultGrade: "steer",
    topology: { kind: "unified" },
    profileRef: `spec:${promptVersion}`,
  };

  const protocolOut: FacilityProtocol = { capabilities, initiate: [] };
  const stateSchema: FacilityStateSchema = {
    liveState: {},
    digestWindow: typeof thresholds?.time_window === "number" ? thresholds.time_window : 7,
  };

  // ⑤ initialState：数字型 liveState（容量/时间窗）+ 初始事实流水（P1 无种子，保持空——
  //   records.yaml 只是登记流水类型（usage/incident/maintenance 的封闭声明），不是数据；
  //   真实流水由 facility_record 工具在运行期「仅追加」，create 不造任何幻影行。）。
  const liveState: Record<string, unknown> = {};
  if (thresholds?.capacity !== undefined) liveState.capacity = thresholds.capacity;
  if (thresholds?.time_window !== undefined) liveState.time_window = thresholds.time_window;
  const recordsSeed: FacilityInitialState["records"] = [];

  return {
    specVersion: SPEC_VERSION,
    facilityId: ctx.facilityId,
    facilityType,
    displayName: name,
    promptVersion,
    systemPrompt,
    lazySections,
    domainTools,
    constraints,
    protocol: protocolOut,
    mesh,
    stateSchema,
    modelConfig: ctx.modelConfig,
    initialState: { liveState, records: recordsSeed },
    memoryPolicy: facilityMemoryPolicy(),
  };
}