// ═══════════════════════════════════════════════════════════════════════════
// 加载 demo.config.json（本地优先，回退到同级 mesh 的演示配置），统成 DemoModelSpec。
// 凭据只进内存、不落盘、不写回，也绝不打进日志。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DemoConfig, DemoModelSpec } from "./types.ts";

/** 候选配置路径：examples/demo.config.json 优先，缺省回退 mesh 演示配置。 */
function candidatePaths(cwd: string): string[] {
  return [
    join(cwd, "examples", "demo.config.json"),
    join(cwd, "..", "pi-agent-mesh", "examples", "demo.config.json"),
  ];
}

/** 把 "off|low|medium|high|minimal|max" 归一成 role 的四值枚举。 */
function normalizeThinkingLevel(raw: string | undefined): DemoModelSpec["thinkingLevel"] {
  switch (raw?.toLowerCase()) {
    case "off":
      return "off";
    case "high":
    case "max":
      return "high";
    case "medium":
      return "medium";
    case "low":
    case "minimal":
    default:
      return "low";
  }
}

/** 解析一份 demo.config.json；凭据缺 key（apiKey 或 apiKeyEnv）时返回 null。 */
export function parseDemoConfig(cfg: DemoConfig): DemoModelSpec | null {
  const llm = cfg.llm;
  if (!llm) return null;
  const colon = llm.model.indexOf(":");
  if (colon <= 0) return null;
  const provider = llm.model.slice(0, colon).trim();
  const modelId = llm.model.slice(colon + 1).trim();
  const pconf = llm.providers?.[provider];
  if (!provider || !modelId || !pconf) return null;
  const key = pconf.apiKey ?? (pconf.apiKeyEnv ? process.env[pconf.apiKeyEnv] : undefined);
  if (!key) return null;
  return {
    provider,
    modelId,
    thinkingLevel: normalizeThinkingLevel(llm.thinkingLevel),
    credential: {
      type: "api_key",
      key,
      baseUrl: pconf.baseUrl,
      api: pconf.api ?? "openai-completions",
    },
  };
}

/** 读磁盘配置（含回退）。找不到 / 缺凭据返回 null，由调用方决定降级 fake 或报错。 */
export function loadDemoConfig(cwd = process.cwd()): DemoModelSpec | null {
  for (const path of candidatePaths(cwd)) {
    if (!existsSync(path)) continue;
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8")) as DemoConfig;
      const spec = parseDemoConfig(cfg);
      if (spec) return spec;
    } catch {
      // 坏配置继续尝试下一个候选。
    }
  }
  return null;
}

/** 生成 createRuntime({ credentialFor }) 的闭包。 */
export function credentialFor(spec: DemoModelSpec | null): (provider: string) => DemoModelSpec["credential"] | undefined {
  return (provider) => (spec && provider === spec.provider ? spec.credential : undefined);
}