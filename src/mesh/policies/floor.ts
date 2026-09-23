// ═══════════════════════════════════════════════════════════════════════════
// FloorPolicy（§3.7 ③）——「这条消息的发送者现在能不能说话」
//
// mesh 在落库前调用 grantFloor，返回「允许发言的账号集合」；若 `from` 不在集合内
// 则 reject(NO_FLOOR)。候选座次取 `st.candidates`（编曲器每轮注入的「有 speak 权」成员，
// §7.2 按座次）与 mesh 成员表在场集合的交集；`ctx.lastSpeakers` = 最近 5 个去重发送者。
// 降级（策略抛错/超时）mesh 兜 free_for_all。
//
// 本环按 scenes.floor_mode（经 FloorStateController 注入的快照）分派：
//   free_for_all → 全员放行（降级诚实：宁可吵，别全场哑）
//   director     → 只有被点名者 + 主持人（host 恒放行，否则 cue 都发不出）
//   round_robin  → lastSpeakers[0] 之后的下一个未沉默者 + host
//   reactive     → 按 RoleTurnState 打分取 top-1（未沉默）+ host
// 沉默权：任何出现在快照 silenced 集合的候选都不进结果；若轮到它则整轮返回 [host]
// （不锁死——主持人仍能继续点名，下一轮继续轮转）。
//
// ⚠️ 本槽从不持久化（§13.2）。快照对象由编曲器经 FloorStateController 每轮 set()。
// ⚠️ R5：本文件属 src/mesh/policies/**，不得出现 `ext` 标识符、不得读信封领域层。
// ═══════════════════════════════════════════════════════════════════════════

import type { AccountId, FloorPolicy } from "@pi/agent-mesh/core";

import type { FloorStateController } from "../../scene/types.js";

export function makeFloorPolicy(controller: FloorStateController): FloorPolicy {
  return {
    grantFloor(ctx) {
      const st = controller.get();
      // 无场景快照 / 非当前场景 → 自由发言（§13.4 降级口径）
      if (st === null || st.conversationId !== ctx.conversationId) return [...ctx.candidates];

      // 候选集 = 本环快照声明的「有 speak 权」座次（st.candidates，§7.2 按座次），
      // 与 mesh 成员表在场集合取交集后剔除沉默者。这样 round_robin/reactive 的选人
      // 顺序与编曲器同源，且天然排除 observer（read-only 成员，ctx.candidates 含它们）。
      const present = new Set(ctx.candidates);
      const candidates = st.candidates.filter((c) => present.has(c) && !st.silenced.has(c));
      const host = st.host;
      const withHost = (granted: AccountId[]): AccountId[] =>
        host !== null && !granted.includes(host) ? [...granted, host] : granted;

      switch (st.floorMode) {
        case "director": {
          const a = st.addressee;
          if (a === null) return withHost([]);
          return withHost(candidates.includes(a) ? [a] : []);
        }
        case "round_robin": {
          const last = st.lastSpeakers[0];
          const idx = last === undefined ? -1 : candidates.indexOf(last);
          const next = candidates.length === 0 ? null : idx < 0 ? (candidates[0] ?? null) : (candidates[(idx + 1) % candidates.length] ?? candidates[0] ?? null);
          return withHost(next === null ? [] : [next]);
        }
        case "reactive": {
          let best: AccountId | null = null;
          let bestScore = Number.NEGATIVE_INFINITY;
          for (const c of candidates) {
            const s = st.lookup.byAccount(c);
            const score = s
              ? s.turnsSinceLastSpoke + (s.wasAddressed ? 2 : 0) + s.arousal + s.engagement
              : 0;
            if (score > bestScore) {
              bestScore = score;
              best = c;
            }
          }
          return withHost(best === null ? [] : [best]);
        }
        default:
          return [...ctx.candidates];
      }
    },
  };
}