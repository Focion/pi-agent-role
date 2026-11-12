// ═══════════════════════════════════════════════════════════════════════════
// examples 共享底座：把「配置 + 画像 + createRuntime」组装成一致入口。
// 所有 scenario 模块都从这里拿一个已装配的公开 Runtime，不各自拼 createRuntime。
// ═══════════════════════════════════════════════════════════════════════════

import { createRuntime, type CostRecord, type Runtime, type RuntimeEvent } from "@pi/agent-role";

import { credentialFor } from "./config.ts";
import { personaOf, writePersonaBlueprint } from "./personas.ts";
import type { DemoModelSpec } from "./types.ts";

export interface OpenRuntimeOptions {
  /** 工作根（blueprints 物化 / pi session JSONL 都落这里）。 */
  root: string;
  /** DB-A：角色领域库路径。 */
  db: string;
  /** DB-B：mesh 库路径（缺省 `${root}/mesh.db`）。 */
  meshDb?: string;
  config: DemoModelSpec | null;
  /** true = fake sessions + fake streamPort（无 LLM，验证装配不烧钱）。 */
  fake?: boolean;
  devMode?: boolean;
  onEvent?: (e: RuntimeEvent) => void;
  onCost?: (c: CostRecord) => void;
}

/** 装配一个公开 Runtime（唯一入口 createRuntime，不漏内部句柄）。 */
export async function openRuntime(o: OpenRuntimeOptions): Promise<Runtime> {
  if (!o.config && !o.fake) {
    throw new Error(
      "未找到模型凭据且未启用 --fake。请 `cp examples/demo.config.example.json examples/demo.config.json` " +
        "并填入凭据，或加 --fake 跑无 LLM 冒烟。",
    );
  }
  return createRuntime({
    root: o.root,
    db: o.db,
    meshDb: o.meshDb,
    modelDefaults: o.config
      ? { dialogue: { provider: o.config.provider, modelId: o.config.modelId, thinkingLevel: o.config.thinkingLevel } }
      : undefined,
    credentialFor: credentialFor(o.config),
    fake: o.fake ? { sessions: true, streamPort: true } : {},
    devMode: o.devMode,
    onEvent: o.onEvent,
    onCost: o.onCost,
  });
}

/** 写蓝本并走公开 agents.create 注册一枚 MBTI 角色（agentId = persona.id）。 */
export async function registerPersona(rt: Runtime, root: string, id: string): Promise<void> {
  const p = personaOf(id);
  const blueprint = writePersonaBlueprint(root, p);
  await rt.agents.create({ blueprint, agentId: p.id, displayName: p.displayName });
}

/** 批量注册（缺省全量八种）。返回已注册的 agentId 列表。 */
export async function registerPersonas(
  rt: Runtime,
  root: string,
  ids: string[] = ["intj", "enfp", "istj", "infp", "entj", "isfp", "entp", "infj"],
): Promise<string[]> {
  for (const id of ids) await registerPersona(rt, root, id);
  return ids;
}