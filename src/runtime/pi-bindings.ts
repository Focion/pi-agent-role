// ═══════════════════════════════════════════════════════════════════════════
// pi 绑定解析（§3.7 ① / §9.3 / §18.2.1）——accountId → PiAgentBinding 的唯一装配点。
//
// 这是 runtime 层与 pi 后端的交界面：pi-backend 只收「纯数据绑定」，不查库、不碰本环
// DB；本文件负责把「编译产物」(create 时) 或「持久化注册组」(恢复时) 解析成绑定。
//
// 两条解析路径：
//   · register(agentId, spec)：create() 成功时把刚编译的 spec 直接塞进缓存（system prompt
//     是现成的，无需重编译）；
//   · resolve(accountId)：缓存未命中时读 agentMeta 里的持久化行（identity_dir + model_config）
//     **现渲染** system prompt——§18.2.1 规定 system prompt 只有指纹落库，恢复期只能从
//     实例模板重编译（compileIdentity 幂等，identity_dir 即快照）。
//
// 本文件属 `src/runtime/**`：不 import `@pi/agent-mesh`（§22.4 #4）；PiAgentBinding 经
// `../mesh/pi-backend.js` 再出口（纯数据，type-only）。
// ═══════════════════════════════════════════════════════════════════════════

import { join } from "node:path";

import { compileIdentity } from "../compile/identity-loader.js";
import { COMPILER_VERSION } from "../compile/version.js";
import type { AgentSpec, MemoryPolicy } from "../compile/types.js";
import type { PiAgentBinding } from "../mesh/pi-backend.js";
import type { RehydratedAgent } from "./agents.js";

/** accountId → 会话绑定（缺省回退到恢复期重编译）。 */
export interface PiBindingResolver {
  /** create() 成功后注册编译产物（system prompt 现成）。 */
  register(agentId: string, spec: AgentSpec): void;
  /** 逐账号解析绑定：缓存命中则直返，否则从 agentMeta 持久化行重编译并缓存。 */
  resolve(accountId: string): Promise<PiAgentBinding | undefined>;
  /** 逐账号解析记忆策略（P3）：与绑定同源缓存，恢复期随绑定一起重编译。 */
  memoryPolicyOf(accountId: string): Promise<MemoryPolicy | undefined>;
}

/** 相对 root 的 identityDir（DB 落库为相对路径，§18.2.1）→ 绝对路径。 */
function identityDirOf(root: string, agentId: string): string {
  return join(root, "agents", agentId, "identity");
}

/** 由编译产物构造绑定（create 路径；system prompt 直接用 spec 的）。 */
function bindingFromSpec(root: string, agentId: string, spec: AgentSpec): PiAgentBinding {
  const dialogue = spec.modelConfig.dialogue;
  return {
    identityDir: identityDirOf(root, agentId),
    sessionsDir: join(root, "agents", agentId, "sessions"),
    systemPrompt: spec.systemPrompt,
    provider: dialogue.provider,
    modelId: dialogue.modelId,
    thinkingLevel: dialogue.thinkingLevel,
  };
}

/** 由持久化注册组重编译，构造「绑定 + 记忆策略」（恢复路径）。二者同源缓存，一次编译两份都用。 */
async function recompileEntry(
  root: string,
  agent: RehydratedAgent,
): Promise<{ binding: PiAgentBinding; memoryPolicy: MemoryPolicy }> {
  const identityDir = agent.identityDir ? join(root, agent.identityDir) : identityDirOf(root, agent.agentId);
  const spec = await compileIdentity(identityDir, {
    agentId: agent.agentId,
    modelConfig: agent.modelConfig,
    compilerVersion: COMPILER_VERSION,
  });
  const dialogue = agent.modelConfig.dialogue;
  return {
    binding: {
      identityDir,
      sessionsDir: join(root, "agents", agent.agentId, "sessions"),
      systemPrompt: spec.systemPrompt,
      provider: dialogue.provider,
      modelId: dialogue.modelId,
      thinkingLevel: dialogue.thinkingLevel,
    },
    memoryPolicy: spec.memoryPolicy,
  };
}

export function makeBindingResolver(
  root: string,
  agentMeta: ReadonlyMap<string, RehydratedAgent>,
): PiBindingResolver {
  const cache = new Map<string, { binding: PiAgentBinding; memoryPolicy: MemoryPolicy }>();

  async function resolveEntry(
    accountId: string,
  ): Promise<{ binding: PiAgentBinding; memoryPolicy: MemoryPolicy } | undefined> {
    const hit = cache.get(accountId);
    if (hit) return hit;
    const agent = agentMeta.get(accountId);
    if (!agent) return undefined;
    const entry = await recompileEntry(root, agent);
    cache.set(accountId, entry);
    return entry;
  }

  return {
    register(agentId: string, spec: AgentSpec): void {
      cache.set(agentId, { binding: bindingFromSpec(root, agentId, spec), memoryPolicy: spec.memoryPolicy });
    },
    async resolve(accountId: string): Promise<PiAgentBinding | undefined> {
      return (await resolveEntry(accountId))?.binding;
    },
    async memoryPolicyOf(accountId: string): Promise<MemoryPolicy | undefined> {
      return (await resolveEntry(accountId))?.memoryPolicy;
    },
  };
}