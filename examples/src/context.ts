// ═══════════════════════════════════════════════════════════════════════════
// scenario 统一契约：main.ts 解析命令行 → 构造 ScenarioContext → 分发到各 scenario。
// 每个 scenario 模块导出一个 `Scenario`（name + description + run）。
// ═══════════════════════════════════════════════════════════════════════════

import type { DemoModelSpec } from "./types.ts";

export interface ScenarioContext {
  /** 本场景工作根（main.ts 在 examples/.playground/<name>/ 下建好，独立、不互相污染）。 */
  root: string;
  /** role-agent.db 绝对路径（derive 自 root；mesh.db 走缺省 `${root}/mesh.db`）。 */
  db: string;
  /** 标准化模型规格；无凭据时为 null（此时应 fake=true）。 */
  config: DemoModelSpec | null;
  /** true = 无 LLM（fake sessions + fake streamPort），用于装配合规冒烟。 */
  fake: boolean;
  /** 该场景剩余的 argv（不含场景名），形如 ["--turns","3","--verbose"]。 */
  argv: string[];
}

export interface Scenario {
  name: string;
  description: string;
  run(ctx: ScenarioContext): Promise<void>;
}

/** 简单 flag 解析：--key value → {key:value}；--flag → {flag:true}。 */
export function parseFlags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}