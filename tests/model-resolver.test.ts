// ═══════════════════════════════════════════════════════════════════════════
// model-resolver 五层解析链（§5.4 / C6）
//
// 朴素断言（纯函数，无 temp dir / 无 mesh）：逐层覆盖 + 叶子级来源追踪 +
// reflection 继承 + 调用者对象零突变。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";

import { defaultModelConfig, resolveModelConfig } from "../src/compile/model-resolver.js";

const fullDialogue = (modelId: string, thinkingLevel: "off" | "low" | "medium" | "high") => ({
  provider: "anthropic",
  modelId,
  thinkingLevel,
});

describe("resolveModelConfig (§5.4 five-layer chain)", () => {
  it("no input → floor defaults, all leaves from runtime_default", () => {
    const { modelConfig, source } = resolveModelConfig({});
    expect(modelConfig.dialogue).toEqual(defaultModelConfig().dialogue);
    expect(modelConfig.budget).toEqual(defaultModelConfig().budget);
    // reflection 按 dialogue 整株继承（§5.4 末）
    expect(modelConfig.reflection).toEqual(defaultModelConfig().dialogue);
    for (const layer of Object.values(source)) expect(layer).toBe("runtime_default");
  });

  it("runtimeDefault overrides dialogue.modelId, leaves budget.onExceed untouched", () => {
    const { modelConfig, source } = resolveModelConfig({
      runtimeDefault: { dialogue: fullDialogue("claude-opus-5", "low") },
    });
    expect(modelConfig.dialogue.modelId).toBe("claude-opus-5");
    expect(source["dialogue.modelId"]).toBe("runtime_default");
    expect(modelConfig.budget.onExceed).toBe("warn");
    expect(source["budget.onExceed"]).toBe("runtime_default");
  });

  it("blueprint overrides dialogue.thinkingLevel and reflection.modelId → blueprint", () => {
    const { modelConfig, source } = resolveModelConfig({
      blueprint: {
        dialogue: fullDialogue("claude-sonnet-5", "medium"),
        reflection: { modelId: "claude-opus-5" },
      },
    });
    expect(modelConfig.dialogue.thinkingLevel).toBe("medium");
    expect(source["dialogue.thinkingLevel"]).toBe("blueprint");
    expect(modelConfig.reflection?.modelId).toBe("claude-opus-5");
    expect(source["reflection.modelId"]).toBe("blueprint");
  });

  it("roster flat key `model` overrides modelId → roster", () => {
    const { modelConfig, source } = resolveModelConfig({ roster: { model: "claude-sonnet-5" } });
    expect(modelConfig.dialogue.modelId).toBe("claude-sonnet-5");
    expect(source["dialogue.modelId"]).toBe("roster");
  });

  it("createArg maps model / reflectModel / tokenBudget → create_arg", () => {
    const { modelConfig, source } = resolveModelConfig({
      createArg: {
        model: { modelId: "claude-haiku-4.5" },
        reflectModel: { thinkingLevel: "off" },
        tokenBudget: 12345,
      },
    });
    expect(modelConfig.dialogue.modelId).toBe("claude-haiku-4.5");
    expect(source["dialogue.modelId"]).toBe("create_arg");
    expect(modelConfig.reflection?.thinkingLevel).toBe("off");
    expect(source["reflection.thinkingLevel"]).toBe("create_arg");
    expect(modelConfig.budget.tokenBudgetTotal).toBe(12345);
    expect(source["budget.tokenBudgetTotal"]).toBe("create_arg");
  });

  it("sceneOverride wins over earlier layers → scene_override", () => {
    const { modelConfig, source } = resolveModelConfig({
      runtimeDefault: { dialogue: fullDialogue("claude-opus-5", "low") },
      sceneOverride: { dialogue: fullDialogue("claude-sonnet-5-2026", "low") },
    });
    expect(modelConfig.dialogue.modelId).toBe("claude-sonnet-5-2026");
    expect(source["dialogue.modelId"]).toBe("scene_override");
  });

  it("reflection inherits dialogue per-leaf, keeping the source layer of the copy", () => {
    const { modelConfig, source } = resolveModelConfig({
      createArg: { model: { thinkingLevel: "high" } },
    });
    expect(modelConfig.dialogue.thinkingLevel).toBe("high");
    expect(modelConfig.reflection?.thinkingLevel).toBe("high");
    expect(source["dialogue.thinkingLevel"]).toBe("create_arg");
    expect(source["reflection.thinkingLevel"]).toBe("create_arg");
  });

  it("does not mutate caller inputs", () => {
    const input = {
      runtimeDefault: {
        dialogue: fullDialogue("claude-opus-5", "low"),
        budget: { onExceed: "warn" as const, tokenBudgetTotal: 999 },
      },
      blueprint: { dialogue: fullDialogue("claude-sonnet-5", "medium") },
    };
    const snapshot = structuredClone(input);
    resolveModelConfig(input);
    expect(input).toEqual(snapshot);
  });
});