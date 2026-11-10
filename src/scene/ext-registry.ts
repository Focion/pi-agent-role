// ═══════════════════════════════════════════════════════════════════════════
// 场景 → mesh_send 装饰的活账本（A19 完整接线）
//
// extProvider(accountId) 从这里取「该账号此刻所在场景要补齐的角色领域三字段」
// （sceneId / turn / virtualTs，§3.6 写法②）。场景编曲器在每个 cue 前把被点名者
// 所在的场景/轮次/虚拟时间写进账本；close 后清除。账号不在任何场景 → extFor 返回
// undefined → extProvider 退 {}，事件因此「缺 sceneId」而被明确判为非场景事件。
//
// 分层纪律：纯内存 Map，无 DB、无 mesh 值；类型经 ../mesh 的纯 type 再出口。
// ═══════════════════════════════════════════════════════════════════════════

import type { AccountId } from "../mesh/public-types.js";
import type { RoleExt } from "../mesh/ext-role.js";

/** 场景编曲器写、session-factory 的 extProvider 读的共享可变账本。 */
export interface SceneExtRegistry {
  /** 写入某账号「此刻」所在场景要补齐的字段（浅拷贝，防止调用方后续修改）。 */
  setExt(accountId: AccountId, ext: RoleExt): void;
  /** 读某账号当前要补齐的字段；不在任何场景 → undefined。 */
  extFor(accountId: AccountId): RoleExt | undefined;
  /** 清除某账号的账目（场景 close 时归还「非场景事件」判定）。 */
  remove(accountId: AccountId): void;
}

export function createSceneExtRegistry(): SceneExtRegistry {
  const map = new Map<AccountId, RoleExt>();
  return {
    setExt(accountId, ext) {
      map.set(accountId, { ...ext });
    },
    extFor(accountId) {
      return map.get(accountId);
    },
    remove(accountId) {
      map.delete(accountId);
    },
  };
}