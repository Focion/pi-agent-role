// ═══════════════════════════════════════════════════════════════════════════
// 身份编译器契约测试（§5.1 / §5.2 / §5.2.1 / §4.2.1）
//
// 在临时目录里写出一个实例模板，编译成 AgentSpec，逐段断言：
//   冷启动 6 份固定、lazy 索引、system prompt 槽位填充与 §5.2.1 固定文案、
//   mesh 投影推导、constraints 排序、initialState 搬运、initiate 越界校验。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ABOUT_MESSAGES_SECTION,
  compileIdentity,
} from "../src/compile/identity-loader.js";
import { stringifyYaml } from "../src/compile/yaml.js";
import { ValidationError } from "../src/runtime/errors.js";
import type { ModelConfig } from "../src/compile/types.js";

const modelConfig: ModelConfig = {
  dialogue: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "low" },
  budget: { onExceed: "warn" },
};

/** 把一个 objects map 写成实例模板目录下的 YAML 文件。 */
function writeTemplate(dir: string, files: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), stringifyYaml(value))
  }
}

const FIXED_COLD_START = [
  "manifest",
  "personal",
  "constraints",
  "evolution",
  "narrative_voice",
  "agent_protocol",
]

/** manifest.files 里 6 份冷启动文件（名字必须与固定契约一致，否则 cold_start 校验失败）。 */
function coldStartEntries(): Array<Record<string, unknown>> {
  return FIXED_COLD_START.map((name) => ({ path: `${name}.yaml`, priority: "cold_start" }))
}

describe("compileIdentity (§5.1)", () => {
  it("compiles a full instance template into an AgentSpec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-identity-"))
    try {
      writeTemplate(dir, {
        "manifest.yaml": {
          identity: { id: "stu-liu-mingtao" },
          files: [
            ...coldStartEntries(),
            {
              path: "psychology.yaml",
              priority: "lazy",
              description: "性格气质",
              load_trigger: { keywords: ["性格", "脾气"] },
            },
            {
              path: "academic.yaml",
              priority: "lazy",
              description: "学业背景",
              load_trigger: { keywords: ["学习", "成绩"] },
            },
          ],
        },
        "personal.yaml": { name: { full: "刘明涛" }, age: 15, gender: "male" },
        "constraints.yaml": [
          { id: "c2", text: "不得说脏话。", severity: "soft", priority_order: 2, violation_response: "温和提醒。" },
          { id: "c1", text: "不得在课堂上离席。", severity: "hard", priority_order: 1, violation_response: "立即提醒并记录。" },
        ],
        "narrative_voice.yaml": {
          default_mode: "温和",
          fingerprint: {
            sentence_starters: ["嗯，", "我觉得"],
            enders: ["对吧", "呢"],
            punctuation_style: "少用感叹号",
            metaphor_domains: ["校园生活", "天气"],
          },
          sensory: { dominant_channel: "听觉", blindspots: ["书面细节"] },
        },
        "agent_protocol.yaml": { capabilities: ["语文", "讲故事"], initiate: ["chat"] },
        "evolution.yaml": { mood: "好奇", moodIntensity: 0.7, energy: 0.9 },
        "academic.yaml": { education: { stage: "初中" } },
        "psychology.yaml": { personality: ["认真", "有点倔"] },
        "goals.yaml": { objectives: { immediate: "把今天的作业写完" } },
        "relationships.yaml": { trust_defaults: { "班主任": 0.6, "同桌": 0.4 } },
        "knowledge_boundaries.yaml": {
          knowledge: [{ topic: "物理", claim: "初三物理还没学完，量子力学我不懂。" }],
        },
      })

      const spec = await compileIdentity(dir, {
        agentId: "ag-stu-01",
        modelConfig,
        compilerVersion: "test",
      })

      // ① 顶层字段
      expect(spec.specVersion).toBe("2.0")
      expect(spec.agentId).toBe("ag-stu-01")
      expect(spec.identityId).toBe("stu-liu-mingtao")
      expect(spec.promptVersion).toMatch(/^[0-9a-f]{64}$/)

      // ② 冷启动 6 份固定
      expect(spec.coldStartFiles).toHaveLength(6)
      expect([...spec.coldStartFiles].sort()).toEqual([...FIXED_COLD_START].sort())

      // ③ lazy 索引
      expect(spec.lazySections).toHaveLength(2)
      expect(spec.lazySections.map((s) => s.section).sort()).toEqual(["academic", "psychology"])
      const psychology = spec.lazySections.find((s) => s.section === "psychology")!
      const academic = spec.lazySections.find((s) => s.section === "academic")!
      expect(psychology.keywords).toEqual(["性格", "脾气"])
      expect(academic.keywords).toEqual(["学习", "成绩"])
      expect(psychology.tokenEstimate).toBeGreaterThan(0)

      // ④ system prompt：槽位填充 + §5.2.1 固定文案
      expect(spec.systemPrompt).toContain("刘明涛")
      expect(spec.systemPrompt).toContain("## 关于你收到的消息")
      expect(spec.systemPrompt).toContain("<<<MSG >>>")
      expect(ABOUT_MESSAGES_SECTION).toContain("<<<MSG >>> 正文 <<<END MSG>>>")

      // ⑤ mesh 投影（§4.2.1）
      expect(spec.mesh.accountId).toBe("ag-stu-01")
      expect(spec.mesh.displayName).toBe("刘明涛")
      expect(spec.mesh.initiate).toContain("chat")
      expect(spec.mesh.capabilities).toContain("语文")
      expect(spec.mesh.capabilities).toContain("kind:role")
      expect(spec.mesh.topology).toEqual({ kind: "unified" })
      expect(spec.mesh.profileRef).toBe(`spec:${spec.promptVersion}`)
      expect(spec.mesh.defaultGrade).toBe("followUp")

      // ⑥ constraints 扁平 + hard 在前
      expect(spec.constraints).toHaveLength(2)
      expect(spec.constraints[0]!.severity).toBe("hard")
      expect(spec.constraints[1]!.severity).toBe("soft")
      expect(spec.constraints[0]!.id).toBe("c1")

      // ⑦ initialState 搬运
      expect(spec.initialState.trustDefaults).toEqual({ "班主任": 0.6, "同桌": 0.4 })
      expect(spec.initialState.knowledgeSeed).toEqual([
        { topic: "物理", claim: "初三物理还没学完，量子力学我不懂。" },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects initiate words outside the closed 5-value set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-identity-bad-"))
    try {
      writeTemplate(dir, {
        "manifest.yaml": { identity: { id: "bad-initiate" } },
        "agent_protocol.yaml": { initiate: ["response"] },
      })
      await expect(
        compileIdentity(dir, { agentId: "ag-bad-01", modelConfig, compilerVersion: "test" }),
      ).rejects.toBeInstanceOf(ValidationError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})