// ═══════════════════════════════════════════════════════════════════════════
// RoleAccountRegistry —— agent_id ↔ (accountId, endpointId) 映射的运行时闭包
//
// 唯一权威的**持久化**真值在 DB-A 的 agents 表（§18.2）；本类是该真值的运行时
// 只读缓存，供**策略槽**在投递事务内做 O(1) 同步判断（策略槽不得查库，§3.7 契约①）。
//
// 自省账号的判据这里以注册表为准，不靠 ':reflect' 后缀（命名约定不是数据契约，§18.2）。
// 注册顺序：P0 由 bootstrap 直接 register；P1 的 agents.create() 边写 agents 表面
// 边回填本缓存，保证二者同源。
// ═══════════════════════════════════════════════════════════════════════════

import type { AccountId, EndpointId } from "@pi/agent-mesh/core";

export interface RegisteredAgentMeshIds {
  agentId: string;
  agentType: "role" | "facility" | "system";
  accountId: AccountId;
  endpointId: EndpointId;
  reflectAccountId?: AccountId;
  reflectEndpointId?: EndpointId;
  displayName?: string;
}

export class RoleAccountRegistry {
  private readonly byAgent = new Map<string, RegisteredAgentMeshIds>();
  private readonly accountToAgent = new Map<AccountId, string>();
  private readonly endpointToAgent = new Map<EndpointId, string>();

  register(ids: RegisteredAgentMeshIds): void {
    this.byAgent.set(ids.agentId, ids);
    this.accountToAgent.set(ids.accountId, ids.agentId);
    this.endpointToAgent.set(ids.endpointId, ids.agentId);
    if (ids.reflectAccountId) this.accountToAgent.set(ids.reflectAccountId, ids.agentId);
    if (ids.reflectEndpointId) this.endpointToAgent.set(ids.reflectEndpointId, ids.agentId);
  }

  /** P4：把自省流账号/端点回填进既有 role 记录的映射（不重建主账号映射）。 */
  attachReflect(agentId: string, reflectAccountId: AccountId, reflectEndpointId: EndpointId): void {
    const rec = this.byAgent.get(agentId);
    if (!rec) return;
    rec.reflectAccountId = reflectAccountId;
    rec.reflectEndpointId = reflectEndpointId;
    this.accountToAgent.set(reflectAccountId, agentId);
    this.endpointToAgent.set(reflectEndpointId, agentId);
  }

  byAgentId(agentId: string): RegisteredAgentMeshIds | undefined {
    return this.byAgent.get(agentId);
  }

  byAccountId(accountId: AccountId): RegisteredAgentMeshIds | undefined {
    const agentId = this.accountToAgent.get(accountId);
    return agentId ? this.byAgent.get(agentId) : undefined;
  }

  byEndpointId(endpointId: EndpointId): RegisteredAgentMeshIds | undefined {
    const agentId = this.endpointToAgent.get(endpointId);
    return agentId ? this.byAgent.get(agentId) : undefined;
  }

  /** 已注册 agent_id 全集快照（N2 已知 person 校验用；§16.1.2 / §12.3）。 */
  allAgentIds(): string[] {
    return [...this.byAgent.keys()];
  }

  /** agentId 是否是一条自省流账号（以注册表为准，P4 落自省流映射） */
  isReflectAccount(accountId: AccountId): boolean {
    const rec = this.byAccountId(accountId);
    return rec?.reflectAccountId === accountId;
  }

  /** 自省流账号 → 主账号；非自省流返回 undefined（§4.4.1） */
  baseOfReflect(reflectAccountId: AccountId): AccountId | undefined {
    const rec = this.byAccountId(reflectAccountId);
    return rec?.reflectAccountId === reflectAccountId ? rec.accountId : undefined;
  }

  /** 该 accountId 对应的 AccountKind（供工具面分叉） */
  kindOf(accountId: AccountId): "role" | "facility" | "reflect" {
    const rec = this.byAccountId(accountId);
    if (!rec) return "role";
    if (rec.reflectAccountId === accountId) return "reflect";
    if (rec.agentType === "facility") return "facility";
    return "role";
  }

  nameOf(accountId: AccountId): string | undefined {
    return this.byAccountId(accountId)?.displayName;
  }
}