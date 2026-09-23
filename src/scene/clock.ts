// ═══════════════════════════════════════════════════════════════════════════
// 虚拟时钟 LogicalClock 槽（C11 / §8.1）——把 runtime/virtual-clock 的纯助手装进
// mesh 的 LogicalClock 契约（compare + format），供 mesh 排序信封与回放。
//
// mesh 的 LogicalClock 只要求 `compare(a,b)`（a/b 是信封逻辑时间戳字面量）+ 可选
// `format`。本环以 `W<周>D<日>T<时段>` 为唯一逻辑时间字面量；compare 即整型投影
// 相减（§8.1 逐字节），format 即人类可读渲染。
//
// 注意：推进（advance）**不在这里**——LogicalClock.compare 只比较、永不推进（§7.2，
// 虚拟时钟是只读推进）。推进由编曲器在每轮结束时调 advanceVirtualTs 显式完成。
//
// 分层纪律：不 import `@pi/agent-mesh`；LogicalClock 经 ../mesh/public-types.js（type）。
// ═══════════════════════════════════════════════════════════════════════════

import type { LogicalClock } from "../mesh/public-types.js";
import {
  advanceVirtualTs,
  compareVirtualTs,
  formatVirtualTs,
  parseVirtualTs,
  renderVirtualTs,
} from "../runtime/virtual-clock.js";

/** mesh 的策略槽契约：只比较/格式化，不推进。 */
export function makeLogicalClock(): LogicalClock {
  return {
    compare: compareVirtualTs,
    format: (ts) => renderVirtualTs(ts),
  };
}

// 再出口 run 循环需要的纯助手（不重写，单一出处 C11）。
export {
  advanceVirtualTs,
  compareVirtualTs,
  formatVirtualTs,
  parseVirtualTs,
  renderVirtualTs,
};