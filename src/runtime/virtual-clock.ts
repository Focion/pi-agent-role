// ═══════════════════════════════════════════════════════════════════════════
// 虚拟时钟（C11 / §8.1）
//
// 字面量形如 `W3D1T14`（第 3 周、周一、14 点）或 `W3D1T14:30`（E01/A09 起支持整分钟——
// 半小时轮长不再产生 `W1D1T8.5` 这种浮点格式，parser 也不会在下一次推进时拒绝）。
// 物化整数投影 `virtualMinutesOf` 是一对一「分钟」投影；衰减与排序沿用小时粒度，由
// `virtualHoursOf` 向下取整提供（hour-granularity 的 decay 语义不变）。
//
// 映射公式（§8.1 逐字节采纳）：分钟 N = ((week * 7 + day) * 24 + hour) * 60 + minute。
// 注意：该式在 week=1,day=1 处有恒定的 +8 天 offset，但因 week→168h、day→24h、
// hour→1h、minute→1min 四个系数都精确，**任何一次相减得到的虚拟分钟差都是正确的**
// （offset 每次都抵消）。这是刻意保留设计原式而非「纠正」它的原因——§21.3 T4.13 按
// virtualHoursOf(virtual_ts) 断言全表一致（小时投影 = floor(分钟投影 / 60)，旧值不变）。
// ═══════════════════════════════════════════════════════════════════════════

export interface VirtualTs {
  week: number; // ≥ 1
  day: number; // 1..7（1 = 周一）
  hour: number; // 0..23（时段）
  minute: number; // 0..59（E01/A09 起支持整分钟）
}

export type VirtualClockMode = "virtual" | "real";

const VIRTUAL_TS_RE = /^W([0-9]+)D([1-7])T([0-9]{1,2})(?::([0-9]{1,2}))?$/;

const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

function periodName(hour: number): string {
  if (hour < 6) return "凌晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  return "晚上";
}

/** 解析 `W3D1T14` 或 `W3D1T14:30`。非法输入抛 Error（调用方应把非法的虚拟时间当作数据缺陷处理）。 */
export function parseVirtualTs(ts: string): VirtualTs {
  const m = VIRTUAL_TS_RE.exec(ts);
  if (!m) throw new Error(`invalid virtualTs literal: "${ts}"`);
  const week = Number(m[1]);
  const day = Number(m[2]);
  const hour = Number(m[3]);
  const minute = m[4] !== undefined ? Number(m[4]) : 0;
  if (week < 1) throw new Error(`invalid virtualTs week (want >=1): "${ts}"`);
  if (hour > 23) throw new Error(`invalid virtualTs hour (want 0..23): "${ts}"`);
  if (minute > 59) throw new Error(`invalid virtualTs minute (want 0..59): "${ts}"`);
  return { week, day, hour, minute };
}

/** 序列化为规范化字面量（零分钟省略 `:00`；非零分钟补两位，供比较与落库前归一）。 */
export function formatVirtualTs(v: VirtualTs): string {
  const mm = v.minute > 0 ? `:${String(v.minute).padStart(2, "0")}` : "";
  return `W${v.week}D${v.day}T${v.hour}${mm}`;
}

/** 物化整数「分钟」投影（E01）。排序 / 比较用这一列。 */
export function virtualMinutesOf(ts: string): number {
  const v = parseVirtualTs(ts);
  return ((v.week * 7 + v.day) * 24 + v.hour) * 60 + v.minute;
}

/**
 * 物化整数「小时」投影。decay / 排序沿用小时粒度，取分钟投影向下取整（§18.4.1）。
 * 对整点字面量返回值与旧实现逐一相同（`W3D1T14` → 542），T4.13 的全表一致性断言不变。
 */
export function virtualHoursOf(ts: string): number {
  return Math.floor(virtualMinutesOf(ts) / 60);
}

/**
 * 物化整数「虚拟日」投影（R16 / Q02 日终去重）。= floor(virtualHoursOf / 24)。
 * 同一（周,日）内的任意时刻落到同一虚拟日，用于「同角色同虚拟日去重」「跨多日不伪造经历」。
 */
export function virtualDayOf(ts: string): number {
  return Math.floor(virtualHoursOf(ts) / 24);
}

/** `LogicalClock.compare` 的整型比较实现（§8.1，E01 起按分钟比较）。 */
export function compareVirtualTs(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1; // 无 logicalTs 的排前（宿主约定，库不关心）
  if (b === undefined) return 1;
  return virtualMinutesOf(a) - virtualMinutesOf(b);
}

/** 人类可读渲染：`W3D1T14` → `第3周 周一 下午`；`W3D1T14:30` → `第3周 周一 下午 30分`。 */
export function renderVirtualTs(ts: string): string {
  const v = parseVirtualTs(ts);
  const mm = v.minute > 0 ? ` ${v.minute}分` : "";
  return `第${v.week}周 ${DAY_NAMES[v.day - 1]} ${periodName(v.hour)}${mm}`;
}

/**
 * 推进虚拟时间：在现有字面量上增加 deltaMinutes 个虚拟分钟（负值表示回退，仅用于 mode:'real'）。
 * 反解保持可重入：virtualMinutesOf(advanceVirtualTs(ts, d)) === virtualMinutesOf(ts) + d。
 * 反解：minute = N mod 60；m = ⌊N/60⌋ = 7·week + day + hour/24 的复合；hour = m mod 24；
 * day/floor 再由 m/24 反解（保留 §8.1 原式 +8 offset 抵消性质）。
 */
export function advanceVirtualTs(ts: string, deltaMinutes: number): string {
  const total = virtualMinutesOf(ts) + deltaMinutes;
  const minute = ((total % 60) + 60) % 60;
  const totalHours = Math.floor(total / 60);
  const hour = ((totalHours % 24) + 24) % 24;
  const m = Math.floor(totalHours / 24);
  const week = Math.floor((m - 1) / 7);
  const day = ((m - 1) % 7) + 1;
  return formatVirtualTs({ week, day, hour, minute });
}