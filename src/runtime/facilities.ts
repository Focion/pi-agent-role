// ═══════════════════════════════════════════════════════════════════════════
// facilities 命名空间（§3.2 / §5.5 最小面）—— 注册设施 Agent
//
// 设施不是 persona：无身份编译。FacilityApi.create 只做一件事——注册一个 mesh Account
// （`initiate: []` + `defaultGrade: "steer"` + 四设施工具面，§3.8），由 bootstrap 的
// registerAgent 一次性落库 + 回填注册表闭包。设施「不主动发言」由 initiate:[] 在 mesh
// 受理期强制（§3.2）；它只应答带 correlationId 的请求，或由编曲器代发事件（§4.3）。
//
// 恢复期（§4.2.4）暂不覆盖设施：facilityId 的 mesh 映射只活在本 runtime 生命周期内，
// 重启后需重新 create（mesh 无删账号 API，create 语义 = 「确保注册」由宿主幂等调用）。
//
// 分层纪律（§22.4 #4）：本文件属 src/runtime/**，不 import `@pi/agent-mesh`；
// mesh 注册经注入的 registerAgent 闭包触达（类型经 ../mesh/bootstrap.js 再出口）。
// ═══════════════════════════════════════════════════════════════════════════

import type { RegisteredAgentMeshIds } from "../mesh/accounts.js";
import type { RegisterAgentInput } from "../mesh/bootstrap.js";
import { ValidationError } from "./errors.js";
import type { CreateFacilityInput, CreateFacilityResult } from "./types.js";

export interface FacilityApiDeps {
  /** runtime 装配好的注册闭包（bootstrap.registerAgent → initiate:[]/steer + 回填注册表 + 发 agent_registered）。 */
  registerAgent(input: RegisterAgentInput): Promise<RegisteredAgentMeshIds>;
}

/** 组装公开 FacilityApi（§3.2 create）。 */
export function makeFacilityApi(deps: FacilityApiDeps): {
  create(input: CreateFacilityInput): Promise<CreateFacilityResult>;
} {
  return {
    async create(input: CreateFacilityInput): Promise<CreateFacilityResult> {
      if (!input.facilityId || input.facilityId.trim() === "") {
        throw new ValidationError("facilityId is required");
      }
      const rec = await deps.registerAgent({
        agentId: input.facilityId,
        agentType: "facility",
        displayName: input.name ?? input.facilityId,
        accountId: input.facilityId, // §4.2.1 恒等：facilityId 同时就是 mesh accountId
      });
      return { facilityId: input.facilityId, accountId: rec.accountId, endpointId: rec.endpointId };
    },
  };
}