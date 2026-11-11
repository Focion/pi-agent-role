// ═══════════════════════════════════════════════════════════════════════════
// scenes 命名空间（P2 · §7）—— 宿主视角的场景门面
//
// 把「agentId + 领域角色」解析成 meshAccountId（经注册表闭包，§4.2.4），组装 SceneSpec
// 交给编曲器。门面不碰 mesh 值，不写 SQL；authority 全在编曲器 + DAO。
//
// 角色 → caps 由编曲器按 §3.3 caps 表推导；这里只负责 id 解析与入参透传。
//
// 分层纪律（§22.4 #4）：本文件属 src/runtime/**，不 import `@pi/agent-mesh`；
// mesh 类型经 ../mesh/public-types.js，注册表类型经 ../mesh/accounts.js。
// ═══════════════════════════════════════════════════════════════════════════

import type { RoleAccountRegistry } from "../mesh/accounts.js";
import type { SceneEstablished, SceneInjection, SceneInjectionInput, SceneOrchestrator, SceneRunResult, SceneSpec } from "../scene/types.js";
import { ValidationError } from "./errors.js";
import type { CreateSceneInput, SceneApi, SceneRunOptions } from "./types.js";

export interface SceneApiDeps {
  registry: RoleAccountRegistry;
  orchestrator: SceneOrchestrator;
}

/** 组装公开 SceneApi（§7 create/run/resume/close）。 */
export function makeSceneApi(deps: SceneApiDeps): SceneApi {
  const { registry, orchestrator } = deps;

  function toSpec(input: CreateSceneInput): SceneSpec {
    const participants = input.participants.map((p) => {
      const rec = registry.byAgentId(p.agentId);
      if (!rec) throw new ValidationError(`participant agent not registered: ${p.agentId}`);
      return { agentId: p.agentId, role: p.role, meshAccountId: rec.accountId };
    });
    return {
      sceneId: input.sceneId,
      name: input.name,
      participants,
      hostAccountId: input.hostAccountId,
      conversationId: input.conversationId,
      virtualStart: input.virtualStart,
      turnDurationMinutes: input.turnDurationMinutes,
      floorMode: input.floorMode,
      script: input.script,
      maxTurns: input.maxTurns,
      tokenBudget: input.tokenBudget,
      facilityId: input.facilityId,
      facilityJson: input.facilityJson,
    };
  }

  return {
    create(input: CreateSceneInput): Promise<SceneEstablished> {
      return orchestrator.create(toSpec(input));
    },
    run(sceneId: string, signal?: AbortSignal, opts?: SceneRunOptions): Promise<SceneRunResult> {
      return orchestrator.run(sceneId, { signal, maxTurns: opts?.maxTurns, tokenBudget: opts?.tokenBudget });
    },
    resume(sceneId: string, signal?: AbortSignal, opts?: SceneRunOptions): Promise<SceneRunResult> {
      return orchestrator.resume(sceneId, { signal, maxTurns: opts?.maxTurns, tokenBudget: opts?.tokenBudget });
    },
    pause(sceneId: string): Promise<SceneRunResult> {
      return orchestrator.pause(sceneId);
    },
    inject(input: SceneInjectionInput): Promise<SceneInjection> {
      return orchestrator.inject(input);
    },
    close(sceneId: string): Promise<SceneRunResult> {
      return orchestrator.close(sceneId);
    },
  };
}