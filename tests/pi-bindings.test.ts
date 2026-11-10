// ═══════════════════════════════════════════════════════════════════════════
// P1 · pi 绑定解析（§3.7 ① / §18.2.1）——accountId → PiAgentBinding。
//
// 不触 pi SDK（纯数据解析）：验证两条路径
//   · register(agentId, spec)：create() 后 system prompt 现成，C6 模型直接取自 spec.modelConfig.dialogue；
//   · resolve(accountId)：缓存未命中时从 agentMeta 的 identity_dir **重编译** system prompt
//     （§18.2.1 只有指纹落库，恢复期必须从实例模板现渲染），并缓存命中。
//
// 守卫：
//   1. create 路径 system prompt === spec.systemPrompt（不重编译）；
//   2. 恢复路径重编译产物与 compileIdentity 直出一致（幂等）；
//   3. C6 五层链最终值（dialogue.provider/modelId/thinkingLevel）原样透传成绑定；
//   4. 未知 accountId → undefined（pi 后端据此抛错）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileIdentity } from "../src/compile/identity-loader.js";
import { stringifyYaml } from "../src/compile/yaml.js";
import { COMPILER_VERSION } from "../src/compile/version.js";
import type { ModelConfig } from "../src/compile/types.js";
import { makeBindingResolver } from "../src/runtime/pi-bindings.js";
import type { RehydratedAgent } from "../src/runtime/agents.js";

/** 最小身份目录（§5.1 冷启动 6 文件）。 */
function writeIdentity(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  const files: [string, unknown][] = [
    [
      "manifest.yaml",
      {
        identity: { id: "id-x" },
        files: ["manifest", "personal", "constraints", "evolution", "narrative_voice", "agent_protocol"].map(
          (n) => ({ path: `${n}.yaml`, priority: "cold_start" }),
        ),
      },
    ],
    ["personal.yaml", { name: { full: name }, age: 15, gender: "male", role: "学生" }],
    ["constraints.yaml", { constraints: [] }],
    ["evolution.yaml", { mood: "平静", moodIntensity: 0.5, energy: 0.8 }],
    ["narrative_voice.yaml", { default_mode: "平实" }],
    ["agent_protocol.yaml", { capabilities: ["语文"], initiate: ["chat"] }],
  ];
  for (const [n, data] of files) writeFileSync(join(dir, n), stringifyYaml(data));
}

function dialogue(overrides: Partial<ModelConfig["dialogue"]> = {}): ModelConfig {
  return {
    dialogue: { provider: "anthropic", modelId: "claude-opus-5", thinkingLevel: "high", ...overrides },
    budget: { onExceed: "warn" },
  };
}

/** 组装一条持久化注册行（§18.2 恢复期 agentMeta 的形态）。 */
function rehydrated(
  agentId: string,
  identityDir: string,
  modelConfig: ModelConfig,
  opts: { reflectAccountId?: string } = {},
): RehydratedAgent {
  return {
    agentId,
    agentType: "role",
    identityId: "id-x",
    blueprintDir: "templates/student",
    blueprintHash: "0".repeat(64),
    identityDir,
    role: null,
    displayName: null,
    modelConfig,
    modelConfigSource: {},
    specHash: null,
    status: "active",
    meshAccountId: agentId,
    meshEndpointId: "ep-1",
    reflectAccountId: opts.reflectAccountId ?? null,
    reflectEndpointId: opts.reflectAccountId ? "ep-1-reflect" : null,
  };
}

describe("P1 pi 绑定解析 (§3.7 ① / §18.2.1)", () => {
  it("register：create 路径 system prompt 现成 + C6 模型透传（不重编译）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-bind-reg-"));
    const identityDir = join(root, "agents", "ag-1", "identity");
    writeIdentity(identityDir, "刘明涛");

    const spec = await compileIdentity(identityDir, {
      agentId: "ag-1",
      modelConfig: dialogue({ modelId: "claude-sonnet-5", thinkingLevel: "medium" }),
      compilerVersion: COMPILER_VERSION,
    });

    const resolver = makeBindingResolver(root, new Map());
    resolver.register("ag-1", spec);

    const binding = await resolver.resolve("ag-1");
    expect(binding).toBeDefined();
    // 守卫①：create 路径不重编译，system prompt 是 register 时塞进去的那份。
    expect(binding!.systemPrompt).toBe(spec.systemPrompt);
    expect(binding!.systemPrompt).toContain("你是 刘明涛");
    // 守卫③：C6 五层链最终值透传。
    expect(binding!.provider).toBe("anthropic");
    expect(binding!.modelId).toBe("claude-sonnet-5");
    expect(binding!.thinkingLevel).toBe("medium");
    // 目录归属（§19.2.1 / C8）。
    expect(binding!.identityDir).toBe(identityDir);
    expect(binding!.sessionsDir).toBe(join(root, "agents", "ag-1", "sessions"));
  });

  it("resolve：缓存未命中从 agentMeta 重编译 system prompt 并缓存（§18.2.1）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-bind-resolve-"));
    // 落库的是相对路径（§18.2.1），identityDir 存相对 root 的形式。
    const identityAbs = join(root, "agents", "ag-2", "identity");
    writeIdentity(identityAbs, "王老师");

    const modelConfig = dialogue({ modelId: "claude-haiku-4-5", thinkingLevel: "low" });
    const agent = rehydrated("ag-2", "agents/ag-2/identity", modelConfig);
    const resolver = makeBindingResolver(root, new Map([["ag-2", agent]]));

    const first = await resolver.resolve("ag-2");
    expect(first).toBeDefined();
    // 守卫②：重编译产物 === compileIdentity 直出（幂等）。
    const straight = await compileIdentity(identityAbs, {
      agentId: "ag-2",
      modelConfig,
      compilerVersion: COMPILER_VERSION,
    });
    expect(first!.systemPrompt).toBe(straight.systemPrompt);
    expect(first!.systemPrompt).toContain("你是 王老师");
    // 相对 identityDir 被解析成绝对路径。
    expect(first!.identityDir).toBe(identityAbs);
    expect(first!.provider).toBe("anthropic");
    expect(first!.modelId).toBe("claude-haiku-4-5");
    expect(first!.thinkingLevel).toBe("low");

    // 缓存命中：二次 resolve 返回同一对象（重编译只跑一次）。
    const second = await resolver.resolve("ag-2");
    expect(second).toBe(first);
  });

  it("未知 accountId → undefined（pi 后端据此抛错）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-bind-none-"));
    const resolver = makeBindingResolver(root, new Map());
    await expect(resolver.resolve("ghost")).resolves.toBeUndefined();
  });

  it("A03 create 路径：register 一并对自省流账号落绑定（独立 reflection 模型 + 目录）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-bind-reflect-"));
    const identityDir = join(root, "agents", "ag-r", "identity");
    writeIdentity(identityDir, "刘明涛");

    const spec = await compileIdentity(identityDir, {
      agentId: "ag-r",
      modelConfig: {
        dialogue: { provider: "anthropic", modelId: "claude-opus-5", thinkingLevel: "high" },
        reflection: { modelId: "claude-haiku-4-5", thinkingLevel: "low" },
        budget: { onExceed: "warn" },
      },
      compilerVersion: COMPILER_VERSION,
    });

    const resolver = makeBindingResolver(root, new Map());
    resolver.register("ag-r", spec, { reflectAccountId: "ag-r:reflect" });

    const reflect = await resolver.resolve("ag-r:reflect");
    expect(reflect).toBeDefined();
    // 独立 reflection 模型生效：显式叶子覆盖，未覆盖叶（provider）继承 dialogue。
    expect(reflect!.modelId).toBe("claude-haiku-4-5");
    expect(reflect!.thinkingLevel).toBe("low");
    expect(reflect!.provider).toBe("anthropic");
    // 主/自省独立目录（R05）。
    expect(reflect!.sessionsDir).toBe(join(root, "agents", "ag-r", "sessions-reflect"));
    expect(reflect!.systemPrompt).toBe(spec.systemPrompt);

    // 主账号绑定保持不变（dialogue 模型 + sessions 目录）。
    const main = await resolver.resolve("ag-r");
    expect(main!.modelId).toBe("claude-opus-5");
    expect(main!.sessionsDir).toBe(join(root, "agents", "ag-r", "sessions"));
    // 自省流账号也能解析同一份记忆策略（与主账号同源）。
    expect(await resolver.memoryPolicyOf("ag-r:reflect")).toBe(await resolver.memoryPolicyOf("ag-r"));
  });

  it("A03 恢复路径：reflectAccountId 经反查索引重编译出独立 reflection 绑定", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-bind-reflect-resolve-"));
    const identityAbs = join(root, "agents", "ag-r2", "identity");
    writeIdentity(identityAbs, "王老师");

    const modelConfig: ModelConfig = {
      dialogue: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "medium" },
      reflection: { modelId: "claude-haiku-4-5" },
      budget: { onExceed: "warn" },
    };
    const agent = rehydrated("ag-r2", "agents/ag-r2/identity", modelConfig, {
      reflectAccountId: "ag-r2:reflect",
    });
    const resolver = makeBindingResolver(root, new Map([["ag-r2", agent]]));

    const reflect = await resolver.resolve("ag-r2:reflect");
    expect(reflect).toBeDefined();
    expect(reflect!.modelId).toBe("claude-haiku-4-5");
    // 继承 dialogue 的 thinkingLevel（reflection 未覆盖）。
    expect(reflect!.thinkingLevel).toBe("medium");
    expect(reflect!.identityDir).toBe(identityAbs);
    expect(reflect!.sessionsDir).toBe(join(root, "agents", "ag-r2", "sessions-reflect"));

    const main = await resolver.resolve("ag-r2");
    expect(main!.modelId).toBe("claude-sonnet-5");
  });
});