// ═══════════════════════════════════════════════════════════════════════════
// examples 统一入口：解析 argv → 装配 ScenarioContext → 分发到 scenario。
//
// 用法：
//   node examples/src/main.ts                      # 打印场景菜单
//   node examples/src/main.ts chat [--fake] [...]   # 跑某个场景
//
// 全局 flags（main 消费，不进场景 argv）：
//   --fake            无 LLM 冒烟（fake sessions + fake streamPort，验证装配不烧钱）
//   --root <dir>      指定工作根（缺省 examples/.playground/<scenario>-<ts>/）
//   --personas a,b,c  透传给场景（少数字段支持，也可交给场景自行解析）
//   --build 由 start.sh 消费，这里忽略。
// ═══════════════════════════════════════════════════════════════════════════

// 卫兵顺序：pi SDK 经库内部动态 import 延迟装载，TERMUX_VERSION 越早设置越稳。
process.env.TERMUX_VERSION ??= "1";

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadDemoConfig } from "./config.ts";
import { parseFlags, type Scenario, type ScenarioContext } from "./context.ts";
import { scenario as chat } from "./chat.ts";
import { scenario as agents } from "./scenarios/agents.ts";
import { scenario as authoring } from "./scenarios/authoring.ts";
import { scenario as observe } from "./scenarios/observe.ts";
import { scenario as scenes } from "./scenarios/scenes.ts";

const SCENARIOS: Scenario[] = [chat, agents, scenes, observe, authoring];

function usage(): string {
  const rows = SCENARIOS.map((s) => `  ${s.name.padEnd(10)} ${s.description}`).join("\n");
  return [
    "pi-agent-role 真实场景示例 —— 覆盖 runtime 的全部公开命名空间。",
    "",
    "用法：bash examples/start.sh <场景> [--fake] [--root <dir>] [场景自身 flags]",
    "     （--fake = 无 LLM 冒烟；不带 --fake 则走真实模型，需 demo.config.json 凭据）",
    "",
    "可用场景：",
    rows,
    "",
    "交互入口（群聊）：bash examples/start.sh chat",
    "完整回归：for s in chat agents scenes observe authoring; do bash examples/start.sh $s --fake; done",
    "",
  ].join("\n");
}

function defaultRoot(scenario: string): string {
  const base = join(process.cwd(), "examples", ".playground");
  mkdirSync(base, { recursive: true });
  return join(base, `${scenario}-${Date.now()}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args[0] ?? "";
  if (name === "" || name === "-h" || name === "--help" || name === "list") {
    console.log(usage());
    return;
  }

  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) {
    console.error(`未知场景 "${name}"。可选：${SCENARIOS.map((s) => s.name).join(" / ")}`);
    process.exitCode = 2;
    return;
  }

  const rest = args.slice(1);
  const flags = parseFlags(rest);
  const fake = flags["fake"] === true || flags["--fake"] === true;
  const config = fake ? null : loadDemoConfig();
  const argsForScenario = rest; // 场景自行 parseFlags；main 只读 --fake/--root 做全局装配。

  const rootInput = typeof flags["root"] === "string" ? flags["root"] : undefined;
  const root = rootInput ? join(process.cwd(), rootInput) : defaultRoot(scenario.name);
  mkdirSync(root, { recursive: true });

  const ctx: ScenarioContext = {
    root,
    db: join(root, "role-agent.db"),
    config,
    fake,
    argv: argsForScenario,
  };

  console.log(`\n━━━ 场景：${scenario.name} ━━━`);
  console.log(`root   : ${root}`);
  console.log(`模型   : ${config ? `${config.provider}:${config.modelId}` : fake ? "fake（无 LLM 冒烟）" : "（未配置凭据，将报错）"}\n`);

  await scenario.run(ctx);
}

await main();