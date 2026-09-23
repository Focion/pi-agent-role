// ═══════════════════════════════════════════════════════════════════════════
// 模型配置五层解析链（§5.4 / C6）
//
// 层序（后者覆盖前者）：
//   floor(runtime 内置默认) → runtimeDefault → blueprint → roster → createArg → sceneOverride
// 每一层只覆盖它声明的叶子；被覆盖叶子记为该层键。floor 的叶子一律记
// `"runtime_default"` —— 运行时内置默认、非代码常量：runtimeDefault 未给时 floor 即运行时默认。
//
// 覆盖规则：dialogue / budget 是对象，递归深合并；叶子标量整值替换。
// roster 是扁平键：{model} → dialogue.modelId，{thinkingLevel} → dialogue.thinkingLevel。
// createArg 是映射入参：{model} → dialogue，{reflectModel} → reflection，
// {tokenBudget} → budget.tokenBudgetTotal。sceneOverride 直接是 Partial<ModelConfig>。
//
// reflection 没有自己的解析链（§5.4 末）：dialogue 定稿后 reflection = merge(dialogue,
// 显式 reflection 输入)。继承叶子沿用其 dialogue 副本的来源层；显式叶子记自己的层。
// 全程不改调用者对象（deep clone 后合并；structuredClone）。
// ═══════════════════════════════════════════════════════════════════════════

import type {
  ModelConfig,
  ModelConfigLayer,
  ModelConfigSource,
  ModelDialogueConfig,
} from "./types.js";

export interface RosterModelDefaults {
  model?: string;
  thinkingLevel?: ModelDialogueConfig["thinkingLevel"];
}

export interface CreateArgModel {
  model?: Partial<ModelDialogueConfig>;
  reflectModel?: Partial<ModelDialogueConfig>;
  tokenBudget?: number;
}

export interface ModelResolveInput {
  runtimeDefault?: Partial<ModelConfig>;
  blueprint?: Partial<ModelConfig>;
  roster?: RosterModelDefaults;
  createArg?: CreateArgModel;
  sceneOverride?: Partial<ModelConfig>;
}

/** 运行时内置基底（§5.4 floor）：无反射段；reflection 由解析末尾按 dialogue 继承补齐。 */
export function defaultModelConfig(): ModelConfig {
  return {
    dialogue: {
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      thinkingLevel: "low",
    },
    budget: { onExceed: "warn" },
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 把一株已定稿对象的每个叶子写进 source（点分路径 → 层）。skip undefined 叶子。 */
function collectLeaves(
  obj: unknown,
  prefix: string,
  layer: ModelConfigLayer,
  src: ModelConfigSource,
): void {
  if (!isPlainObject(obj)) return;
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) collectLeaves(value, path, layer, src);
    else src[path] = layer;
  }
}

/** 递归深合并 patch 进 target；叶子整值替换并记录来源层。只写 target，不碰 patch。 */
function mergePatch(
  target: Record<string, unknown>,
  patch: unknown,
  layer: ModelConfigLayer,
  prefix: string,
  src: ModelConfigSource,
): void {
  if (!isPlainObject(patch)) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) {
      const child = isPlainObject(target[key]) ? target[key] : {};
      target[key] = child;
      mergePatch(child, value, layer, path, src);
    } else {
      target[key] = structuredClone(value);
      src[path] = layer;
    }
  }
}

export function resolveModelConfig(input: ModelResolveInput): {
  modelConfig: ModelConfig;
  source: ModelConfigSource;
} {
  const floor = defaultModelConfig();

  const dialogue = structuredClone(floor.dialogue) as unknown as Record<string, unknown>;
  const budget = structuredClone(floor.budget) as unknown as Record<string, unknown>;
  const reflection = {} as Record<string, unknown>;
  const reflectionSrc: ModelConfigSource = {};

  const source: ModelConfigSource = {};
  collectLeaves(dialogue, "dialogue", "runtime_default", source);
  collectLeaves(budget, "budget", "runtime_default", source);

  const applyPartial = (patch: Partial<ModelConfig>, layer: ModelConfigLayer): void => {
    if (patch.dialogue !== undefined) mergePatch(dialogue, patch.dialogue, layer, "dialogue", source);
    if (patch.budget !== undefined) mergePatch(budget, patch.budget, layer, "budget", source);
    if (patch.reflection !== undefined) mergePatch(reflection, patch.reflection, layer, "", reflectionSrc);
  };

  // 第 1 层：createRuntime({ modelDefaults }) 入参（与 floor 同记 runtime_default）
  if (input.runtimeDefault !== undefined) applyPartial(input.runtimeDefault, "runtime_default");
  // 第 2 层：model_defaults.yaml（可选）
  if (input.blueprint !== undefined) applyPartial(input.blueprint, "blueprint");
  // 第 3 层：roster.defaults 扁平键
  if (input.roster !== undefined) {
    if (input.roster.model !== undefined) {
      dialogue.modelId = input.roster.model;
      source["dialogue.modelId"] = "roster";
    }
    if (input.roster.thinkingLevel !== undefined) {
      dialogue.thinkingLevel = input.roster.thinkingLevel;
      source["dialogue.thinkingLevel"] = "roster";
    }
  }
  // 第 4 层：create() 入参
  if (input.createArg !== undefined) {
    if (input.createArg.model !== undefined) {
      mergePatch(dialogue, input.createArg.model, "create_arg", "dialogue", source);
    }
    if (input.createArg.reflectModel !== undefined) {
      mergePatch(reflection, input.createArg.reflectModel, "create_arg", "", reflectionSrc);
    }
    if (input.createArg.tokenBudget !== undefined) {
      budget.tokenBudgetTotal = input.createArg.tokenBudget;
      source["budget.tokenBudgetTotal"] = "create_arg";
    }
  }
  // 第 5 层：scene.participants[].model
  if (input.sceneOverride !== undefined) applyPartial(input.sceneOverride, "scene_override");

  // reflection 继承（§5.4 末）：先整株继承 dialogue（skip undefined），再覆盖显式叶子。
  const finalReflection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dialogue)) {
    if (value === undefined) continue;
    finalReflection[key] = value;
    source[`reflection.${key}`] = source[`dialogue.${key}`]!;
  }
  for (const [key, value] of Object.entries(reflection)) {
    if (value === undefined) continue;
    finalReflection[key] = value;
    source[`reflection.${key}`] = reflectionSrc[key]!;
  }

  const modelConfig: ModelConfig = {
    dialogue: dialogue as unknown as ModelConfig["dialogue"],
    budget: budget as unknown as ModelConfig["budget"],
  };
  if (Object.keys(finalReflection).length > 0) {
    modelConfig.reflection = finalReflection as unknown as ModelConfig["reflection"];
  }

  return { modelConfig, source };
}