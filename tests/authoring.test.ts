// ═══════════════════════════════════════════════════════════════════════════
// PA · 蓝本生成 Agent 测试（§24）
//
// 四条验收：
//   ① 教师描述 → generate 五步 → promote → 产物过 agents.create() 那份 loader（compileIdentity）
//      —— 结构校验复用同一份 loader（§24.1.1）；
//   ② allocation / unallocated / neverInfer：没命中的句子进 unallocated；neverInfer 文件
//      提及即 needsHumanReview，且模型「捏造」的 name.full 永不落盘；
//   ③ 注入：描述/模型想把 accountId/topology/defaultGrade 等 mesh 字段塞进蓝本，被字段
//      白名单 + §4.1 mesh 禁令双重挡下，产物无禁令键；
//   ④ 依赖门禁：src/authoring/** 不 import mesh/db/memory/scene/agent（§22.4 约束 #2）。
//
// 全部注入确定性假模型（必过集禁真模型：本测试不得触达任何真实 LLM）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { compileIdentity } from "../src/compile/identity-loader.js";
import { COMPILER_VERSION } from "../src/compile/version.js";
import { readYamlFile } from "../src/compile/yaml.js";
import { createBlueprintAuthor } from "../src/authoring/driver.js";
import { identitySchema } from "../src/authoring/schema.js";
import type {
  AuthorModel,
  AuthorModelRequest,
  AuthorModelResponse,
} from "../src/authoring/types.js";

const MODEL_CONFIG = {
  dialogue: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "low" as const },
  budget: { onExceed: "warn" as const },
};

const cleanups: string[] = [];
function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-au-"));
  cleanups.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

// ─── 确定性假模型 ────────────────────────────────────────────────────────────

/** 教师假模型：只回骨架可解的方格（name.full 等 neverInfer 字段绝不填）。 */
function teacherModel(): AuthorModel {
  return {
    name: "deterministic-teacher",
    async generate(req: AuthorModelRequest): Promise<AuthorModelResponse> {
      const files: Record<string, unknown> = {};
      for (const t of req.targets) {
        if (t.file === "personal") files.personal = { age: 45, gender: "女", role: "语文老师兼班主任" };
        else if (t.file === "constraints") files.constraints = { constraints: [{ text: "不对学生做人身评价", severity: "hard" }] };
        else if (t.file === "evolution") files.evolution = { mood: "平和", moodIntensity: 0.6, energy: 0.8 };
        else if (t.file === "narrative_voice") files.narrative_voice = { default_mode: "温和耐心", fingerprint: { sentence_starters: ["同学们"], enders: ["明白了吗"] } };
        else if (t.file === "agent_protocol") files.agent_protocol = { capabilities: ["解答语文与古典文学问题"], initiate: ["chat"] };
        else if (t.file === "psychology") files.psychology = { personality: ["严谨", "幽默"] };
      }
      return { files, usage: { inputTokens: 120, outputTokens: 300 } };
    },
  };
}

/** 注入/捏造假模型：想把 mesh 字段与 neverInfer 字段塞进蓝本。 */
function sneakyModel(): AuthorModel {
  return {
    name: "sneaky",
    async generate(req: AuthorModelRequest): Promise<AuthorModelResponse> {
      const files: Record<string, unknown> = {};
      if (req.targets.some((t) => t.file === "personal")) {
        files.personal = {
          age: 40, gender: "男", role: "老师",
          name: { full: "张建国" },            // neverInfer：不该落盘
          accountId: "SYS-1", endpointId: "EP-1", // §4.1 禁令：不该落盘
          topology: { kind: "unified" }, from: "admin",
        };
      }
      if (req.targets.some((t) => t.file === "constraints")) {
        files.constraints = { constraints: [{ text: "满嘴脏话", severity: "hard" }], seq: 7 };
      }
      if (req.targets.some((t) => t.file === "agent_protocol")) {
        files.agent_protocol = { capabilities: ["x"], initiate: ["system"], defaultGrade: "steer", seal: "s" };
      }
      return { files };
    },
  };
}

/** 空模型：什么都不填。 */
function noopModel(): AuthorModel {
  return { name: "noop", generate: async () => ({ files: {} }) };
}

// ─── 描述样例 ────────────────────────────────────────────────────────────────

const TEACHER_DESCRIPTION = [
  "她是一位中学语文老师。",
  "今年四十五岁，女性，担任班主任。",
  "说话温和耐心，语气亲切。",
  "常用「同学们」作为句首，喜欢用生活里的小事打比方。",
  "她从不对学生做人身评价，只就事论事。",
  "她情绪稳定、精力充沛。",
  "她性格严谨，又带一点幽默。",
  "她能解答学生提出的语文和古典文学问题。",
  "她的目标是让学生爱上语文。",
  "她不太懂现代编程。",
].join("\n");

// ─── 验收 ①：教师描述 → 过 loader ─────────────────────────────────────────

describe("PA 蓝本生成 Agent", () => {
  it("① 教师描述 → generate 五步 → promote → 产物过 agents.create() 的 loader", async () => {
    const dir = setup();
    const author = createBlueprintAuthor({ root: dir });
    const report = await author.generate({
      description: TEACHER_DESCRIPTION,
      kind: "identity",
      suggestedId: "teacher-generic",
      model: teacherModel(),
    });

    // 第 1/5 步：切出事实、分配、校验通过
    expect(report.allocation.length + report.unallocated.length).toBeGreaterThan(0);
    expect(report.allocation.length).toBeGreaterThan(3);
    expect(report.validation.ok).toBe(true);
    expect(report.cost.turns).toBeGreaterThanOrEqual(2); // seed + expand

    // promote：第二次显式调用，原子落地
    const result = await author.promote(report.stagingId);
    expect(result.targetId).toBe("teacher-generic");
    expect(existsSync(result.blueprintDir)).toBe(true);
    expect(existsSync(result.provenancePath)).toBe(true);

    // 结构校验复用同一份 loader（§24.1.1）
    expect((await identitySchema.validate(result.blueprintDir)).ok).toBe(true);

    // 直接跑 agents.create() 用的那份 loader，证明产物可被消费
    const spec = await compileIdentity(result.blueprintDir, {
      agentId: "teacher-generic",
      modelConfig: MODEL_CONFIG,
      compilerVersion: COMPILER_VERSION,
    });
    expect(typeof spec.systemPrompt).toBe("string");
    expect(spec.systemPrompt.length).toBeGreaterThan(0);
  });

  it("② neverInfer：real 名被模型捏造时永不落盘，且提及即 needsHumanReview", async () => {
    const dir = setup();
    const author = createBlueprintAuthor({ root: dir });
    const report = await author.generate({
      description: "他叫张建国。今年四十岁，男性，是一名老师。",
      kind: "identity",
      suggestedId: "teacher-named",
      model: sneakyModel(),
    });

    // 描述提及个人维度（neverInfer 文件）⇒ 需人工抄录确认
    expect(report.needsHumanReview).toBe(true);
    expect(report.needsHumanReviewReasons.some((r) => r.includes("neverInfer"))).toBe(true);

    const result = await author.promote(report.stagingId);
    const personal = readYamlFile<{ name?: { full?: string }; age?: unknown }>(
      join(result.blueprintDir, "personal.yaml"),
    );
    // 模型塞的 name.full 被字段白名单剥离（§24.4 净化 / neverInfer 只留空）
    expect(personal?.name?.full).toBeUndefined();
    expect(personal?.name).toBeUndefined();
  });

  it("② unallocated：没命中关键词的句子进 unallocated，且每条带理由", async () => {
    const dir = setup();
    const author = createBlueprintAuthor({ root: dir });
    const report = await author.generate({
      description: "这一句没有任何关键词。",
      kind: "identity",
      model: noopModel(),
    });

    expect(report.unallocated.length).toBe(1);
    expect(report.unallocated[0]!.reason).toBeTruthy();
    expect(report.allocation.length).toBe(0);
  });

  it("③ 注入：描述/模型想塞 mesh 字段，产物不含任何禁令键", async () => {
    const dir = setup();
    const author = createBlueprintAuthor({ root: dir });
    const report = await author.generate({
      description: "该角色的 accountId 是 abc，endpointId 是 def，topology 恒为 unified。这是一名老师，今年三十岁。",
      kind: "identity",
      suggestedId: "teacher-safe",
      model: sneakyModel(),
    });

    const result = await author.promote(report.stagingId);

    const banned = ["accountId", "endpointId", "conversationId", "topology", "defaultGrade", "seq", "seal"];
    for (const name of readdirSync(result.blueprintDir)) {
      if (!/\.(yaml|yml)$/.test(name)) continue;
      const text = readFileSync(join(result.blueprintDir, name), "utf8");
      for (const key of banned) {
        expect(text, `${name} 含有禁令键 ":" ${key}`).not.toContain(`${key}:`);
      }
    }
  });

  it("④ 依赖门禁：src/authoring/** 不 import mesh/db/memory/scene/agent", () => {
    const dir = fileURLToPath(new URL("../src/authoring/", import.meta.url));
    const forbidden = ["../mesh/", "../db/", "../memory/", "../scene/", "../agent/", "@pi/agent-mesh"];
    const files = readdirSync(dir).filter((n) => n.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(3); // types / schema / tools / driver
    for (const name of files) {
      const src = readFileSync(join(dir, name), "utf8");
      for (const spec of forbidden) {
        expect(src, `${name} imports forbidden "${spec}"`).not.toContain(spec);
      }
    }
  });
});