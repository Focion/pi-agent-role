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
import type { AgentSpec, MemoryPolicy, ModelConfig, ModelDialogueConfig } from "../compile/types.js";
import type { PiAgentBinding } from "../mesh/pi-backend.js";
import type { RehydratedAgent } from "./agents.js";

/** accountId → 会话绑定（缺省回退到恢复期重编译）。 */
export interface PiBindingResolver {
  /** create() 成功后注册编译产物（system prompt 现成）；可一并对自省流账号注册绑定（A03）。 */
  register(agentId: string, spec: AgentSpec, opts?: { reflectAccountId?: string }): void;
  /** 逐账号解析绑定：缓存命中则直返，否则从 agentMeta 持久化行重编译并缓存。 */
  resolve(accountId: string): Promise<PiAgentBinding | undefined>;
  /** 逐账号解析记忆策略（P3）：与绑定同源缓存，恢复期随绑定一起重编译。 */
  memoryPolicyOf(accountId: string): Promise<MemoryPolicy | undefined>;
  /** R06 setModelConfig：把某 Agent 的模型覆盖同步进内存（agentMeta 行 + 已缓存主/自省绑定）。 */
  applyModelConfig(input: {
    agentId: string;
    modelConfig: ModelConfig;
    mainAccountId: string | null;
    reflectAccountId: string | null;
  }): void;
}

/** 绑定服务于哪个流：主对话（dialogue）或自省（reflection）。R05：二者独立模型与目录。 */
type StreamKind = "dialogue" | "reflection";

/** 相对 root 的 identityDir（DB 落库为相对路径，§18.2.1）→ 绝对路径。 */
function identityDirOf(root: string, agentId: string): string {
  return join(root, "agents", agentId, "identity");
}

/** 会话持久化目录（R05：主/自省独立目录，避免 SessionManager 共享根造成歧义）。 */
function sessionsDirOf(root: string, agentId: string, stream: StreamKind): string {
  return stream === "dialogue"
    ? join(root, "agents", agentId, "sessions")
    : join(root, "agents", agentId, "sessions-reflect");
}

/** 解析某个流的最终模型（§5.4 末 reflection 继承 dialogue，显式叶子覆盖）。 */
function modelOf(config: ModelConfig, stream: StreamKind): ModelDialogueConfig {
  const d = config.dialogue;
  if (stream === "dialogue") return d;
  const r = config.reflection ?? {};
  return {
    provider: r.provider ?? d.provider,
    modelId: r.modelId ?? d.modelId,
    thinkingLevel: r.thinkingLevel ?? d.thinkingLevel,
    temperature: r.temperature ?? d.temperature,
  };
}

/** 由编译产物构造绑定（create 路径；system prompt 直接用 spec 的）。 */
function bindingFromSpec(root: string, agentId: string, spec: AgentSpec, stream: StreamKind): PiAgentBinding {
  const model = modelOf(spec.modelConfig, stream);
  return {
    identityDir: identityDirOf(root, agentId),
    sessionsDir: sessionsDirOf(root, agentId, stream),
    systemPrompt: spec.systemPrompt,
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: model.thinkingLevel,
    temperature: model.temperature,
  };
}

/** 由持久化注册组重编译，构造「绑定 + 记忆策略」（恢复路径）。二者同源缓存，一次编译两份都用。 */
async function recompileEntry(
  root: string,
  agent: RehydratedAgent,
  stream: StreamKind,
): Promise<{ binding: PiAgentBinding; memoryPolicy: MemoryPolicy }> {
  const identityDir = agent.identityDir ? join(root, agent.identityDir) : identityDirOf(root, agent.agentId);
  const spec = await compileIdentity(identityDir, {
    agentId: agent.agentId,
    modelConfig: agent.modelConfig,
    compilerVersion: COMPILER_VERSION,
  });
  const model = modelOf(agent.modelConfig, stream);
  return {
    binding: {
      identityDir,
      sessionsDir: sessionsDirOf(root, agent.agentId, stream),
      systemPrompt: spec.systemPrompt,
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: model.thinkingLevel,
      temperature: model.temperature,
    },
    memoryPolicy: spec.memoryPolicy,
  };
}

export function makeBindingResolver(
  root: string,
  agentMeta: Map<string, RehydratedAgent>,
): PiBindingResolver {
  const cache = new Map<string, { binding: PiAgentBinding; memoryPolicy: MemoryPolicy }>();

  // A03：恢复期 agentMeta 只按 agentId 键控，自省流账号 `${agentId}:reflect` 须经反查索引定位。
  const reflectOf = new Map<string, RehydratedAgent>();
  for (const agent of agentMeta.values()) {
    if (agent.reflectAccountId) reflectOf.set(agent.reflectAccountId, agent);
  }

  async function resolveEntry(
    accountId: string,
  ): Promise<{ binding: PiAgentBinding; memoryPolicy: MemoryPolicy } | undefined> {
    const hit = cache.get(accountId);
    if (hit) return hit;
    // 主账号（accountId === agentId，§4.2.3）优先；自省流账号走反查。
    const agent = agentMeta.get(accountId) ?? reflectOf.get(accountId);
    if (!agent) return undefined;
    const stream: StreamKind = agentMeta.has(accountId) ? "dialogue" : "reflection";
    const entry = await recompileEntry(root, agent, stream);
    cache.set(accountId, entry);
    return entry;
  }

  return {
    register(agentId: string, spec: AgentSpec, opts?: { reflectAccountId?: string }): void {
      cache.set(agentId, { binding: bindingFromSpec(root, agentId, spec, "dialogue"), memoryPolicy: spec.memoryPolicy });
      if (opts?.reflectAccountId) {
        cache.set(opts.reflectAccountId, {
          binding: bindingFromSpec(root, agentId, spec, "reflection"),
          memoryPolicy: spec.memoryPolicy,
        });
      }
    },
    async resolve(accountId: string): Promise<PiAgentBinding | undefined> {
      return (await resolveEntry(accountId))?.binding;
    },
    async memoryPolicyOf(accountId: string): Promise<MemoryPolicy | undefined> {
      return (await resolveEntry(accountId))?.memoryPolicy;
    },
    applyModelConfig(input): void {
      // 1) 恢复期 agentMet 行：更新 modelConfig，让未解析的账号下次 resolve 懒重建时拿到新配置。
      //    agentMeta 与 reflectOf 共享同一 RehydratedAgent 对象：改属性即两边一致。
      const agent = agentMeta.get(input.agentId);
      if (agent) agent.modelConfig = input.modelConfig;
      // 2) 已缓存的主/自省绑定：只替换模型段（non-model 段 identityDir/sessionsDir/systemPrompt 不变），
      //    安全 evict 后等价 warm（无需真模型）。
      const patchInPlace = (accountId: string | null | undefined, stream: StreamKind): void => {
        if (!accountId) return;
        const entry = cache.get(accountId);
        if (!entry) return;
        const m = modelOf(input.modelConfig, stream);
        entry.binding = {
          ...entry.binding,
          provider: m.provider,
          modelId: m.modelId,
          thinkingLevel: m.thinkingLevel,
          temperature: m.temperature,
        };
      };
      patchInPlace(input.mainAccountId, "dialogue");
      patchInPlace(input.reflectAccountId, "reflection");
    },
  };
}