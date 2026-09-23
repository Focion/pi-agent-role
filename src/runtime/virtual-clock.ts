// ═══════════════════════════════════════════════════════════════════════════
// 虚拟时钟（C11）
//
// 字面量形如 `W3D1T14`（第 3 周、周一、14 点）——「时段」以小时为粒度（§8.1/§8.2）。
// 物化整数 `virtual_hours` 是它的一对一投影，衰减与排序只用整数列（§18.4.1 / §15.1.3）。
//
// 映射公式（§8.1 逐字节采纳）：`((week * 7 + day) * 24 + hour)`。
// 注意：该式在 week=1,day=1 处有恒定的 +8 天 offset，但因 week→168h、day→24h、
// hour→1h 三个系数都精确，**任何一次相减得到的虚拟小时差都是正确的**（offset 每次都抵消）。
// 这是刻意保留设计原式而非「纠正」它的原因——§21.3 T4.13 按本式断言全表一致。
// ═══════════════════════════════════════════════════════════════════════════

export interface VirtualTs {
  week: number; // ≥ 1
  day: number; // 1..7（1 = 周一）
  hour: number; // 0..23（时段）
}

export type VirtualClockMode = "virtual" | "real";

const VIRTUAL_TS_RE = /^W([0-9]+)D([1-7])T([0-9]{1,2})$/;

const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

function periodName(hour: number): string {
  if (hour < 6) return "凌晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  return "晚上";
}

/** 解析 `W3D1T14`。非法输入抛 ValidationError（调用方应把非法的虚拟时间当作数据缺陷处理）。 */
export function parseVirtualTs(ts: string): VirtualTs {
  const m = VIRTUAL_TS_RE.exec(ts);
  if (!m) throw new Error(`invalid virtualTs literal: "${ts}"`);
  const week = Number(m[1]);
  const day = Number(m[2]);
  const hour = Number(m[3]);
  if (week < 1) throw new Error(`invalid virtualTs week (want >=1): "${ts}"`);
  if (hour > 23) throw new Error(`invalid virtualTs hour (want 0..23): "${ts}"`);
  return { week, day, hour };
}

/** 序列化为规范化字面量（去掉前导零歧义后的一致性输出，供比较与落库前归一）。 */
export function formatVirtualTs(v: VirtualTs): string {
  return `W${v.week}D${v.day}T${v.hour}`;
}

/** 物化整数投影。decay / 排序只准用这一列（§18.4.1）。 */
export function virtualHoursOf(ts: string): number {
  const v = parseVirtualTs(ts);
  return (v.week * 7 + v.day) * 24 + v.hour;
}

/** `LogicalClock.compare` 的整型比较实现（§8.1）。 */
export function compareVirtualTs(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1; // 无 logicalTs 的排前（宿主约定，库不关心）
  if (b === undefined) return 1;
  return virtualHoursOf(a) - virtualHoursOf(b);
}

/** 人类可读渲染：`W3D1T14` → `第3周 周一 下午`（§8.1 的 format）。 */
export function renderVirtualTs(ts: string): string {
  const v = parseVirtualTs(ts);
  return `第${v.week}周 ${DAY_NAMES[v.day - 1]} ${periodName(v.hour)}`;
}

/** 推进虚拟时间：在现有字面量上增加 deltaHours 个虚拟小时（负值表示回退，仅用于 mode:'real'）。 */
export function advanceVirtualTs(ts: string, deltaHours: number): string {
  // virtualHoursOf 的整数投影是 N = (7·week + day)·24 + hour（day∈1..7、hour∈0..23）。
  // 推进后按同一投影反解回 (week, day, hour)，保证可重入：
  //   virtualHoursOf(advanceVirtualTs(ts, d)) === virtualHoursOf(ts) + d
  // 反解：hour = N mod 24；m = ⌊N/24⌋ = 7·week + day；week = ⌊(m−1)/7⌋、day = (m−1) mod 7 + 1。
  const total = virtualHoursOf(ts) + deltaHours;
  const hour = ((total % 24) + 24) % 24;
  const m = Math.floor(total / 24);
  const week = Math.floor((m - 1) / 7);
  const day = ((m - 1) % 7) + 1;
  return formatVirtualTs({ week, day, hour });
}