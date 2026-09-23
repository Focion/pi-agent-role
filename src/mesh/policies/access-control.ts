// ═══════════════════════════════════════════════════════════════════════════
// AccessControl（§3.7 ⑥）——唯一 fail-closed 槽
//
// 承载两条领域隔离规则：
//   1. 自省流隔离（§4.4.1）：发往 `X:reflect` 的会话，只有 `from.accountId === X`
//      通过。其余 dropped(ACL_DENIED)。
//   2. 设施应答边界（§3.2）：设施账号（initiate:[]）只在合法 correlationId 时写。
//      主动发起已被 mesh 闸门②拦住，这里是纵深防御。
//
// 三条纪律（§3.7 ⑥）：
//   1. 纯内存判断，不查外部授权。
//   2. fail-closed：抛错即拒绝，代价要预演——所有正常路径都要放行（正向测试）。
//   3. 不承担宿主鉴权（§2.2）。
//
// 自省账号判据以**注册表闭包**为权威（agents.mesh_reflect_account_id 列），
// 绝不靠 accountId 是否以 ':reflect' 结尾（命名约定不是数据契约，§18.2）。
// P0 注册表为空 ⇒ isReflectAccount 恒 false ⇒ 全部放行。
// ═══════════════════════════════════════════════════════════════════════════

import type { AccessControl } from "@pi/agent-mesh/core";

export interface AccessControlDeps {
  /** 该 accountId 是否是自省流账号（P4 实装，查注册表/agents 表） */
  isReflectAccount?: (accountId: string) => boolean;
  /** 自省流账号 → 其主账号；自省流只放行主账号本人（§4.4.1） */
  baseOfReflect?: (reflectAccountId: string) => string | undefined;
  /** 该 accountId 是否是设施账号（P2 实装，查 agents.agent_type='facility'） */
  isFacilityAccount?: (accountId: string) => boolean;
}

export function makeAccessControl(deps: AccessControlDeps = {}): AccessControl {
  return {
    async canSend(ctx) {
      const { envelope, from } = ctx;
      // 自省流隔离：任何发往自省账号的消息，只放行其主账号本人
      const targets = envelope.to ?? [];
      for (const to of targets) {
        if (deps.isReflectAccount?.(to)) {
          const base = deps.baseOfReflect?.(to);
          if (base === undefined || from.id !== base) return false;
        }
      }
      // P0：其余一律放行（设施应的 correlationId 校验在 P2 补上）
      return true;
    },
    async canInitiateDirect(from, to) {
      if (deps.isReflectAccount?.(to.id)) {
        const base = deps.baseOfReflect?.(to.id);
        return base === undefined ? false : from.id === base;
      }
      return true;
    },
  };
}