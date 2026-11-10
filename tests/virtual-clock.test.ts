// ═══════════════════════════════════════════════════════════════════════════
// 虚拟时钟整分钟（E01 / A09）—— 解析/格式化/推进/比较的分钟粒度与旧小时原点
//
// A09 反例：半小时轮长曾生成 `W1D1T8.5`，下一次整数小时 parser 拒绝，坏时间落库后
// resume 失败。E01 定稿：整数分钟，兼容 `W3D1T14` 与 `W3D1T14:30`，旧原点不变，
// 无浮点格式。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";

import {
  advanceVirtualTs,
  compareVirtualTs,
  formatVirtualTs,
  parseVirtualTs,
  renderVirtualTs,
  virtualHoursOf,
  virtualMinutesOf,
} from "../src/runtime/virtual-clock.js";

describe("虚拟时钟整分钟（E01/A09）", () => {
  it("解析兼容整点与分钟字面量，非法分钟拒绝", () => {
    expect(parseVirtualTs("W3D1T14")).toMatchObject({ week: 3, day: 1, hour: 14, minute: 0 });
    expect(parseVirtualTs("W3D1T14:30")).toMatchObject({ week: 3, day: 1, hour: 14, minute: 30 });
    expect(() => parseVirtualTs("W3D1T14:60")).toThrow(/minute/);
    expect(() => parseVirtualTs("W1D1T8.5")).toThrow(/invalid virtualTs/);
  });

  it("小时投影保持旧原点：W3D1T14 → 542；分钟投影是其 60 倍", () => {
    expect(virtualHoursOf("W3D1T14")).toBe(542); // T4.13 旧断言不变
    expect(virtualMinutesOf("W3D1T14")).toBe(542 * 60);
    expect(virtualHoursOf("W3D1T14:30")).toBe(542); // 向下取整
    expect(virtualMinutesOf("W3D1T14:30")).toBe(542 * 60 + 30);
  });

  it("30 分钟轮长推进无浮点字面量，跨日与整点省略一致", () => {
    expect(advanceVirtualTs("W1D1T8", 30)).toBe("W1D1T8:30");
    expect(advanceVirtualTs("W1D1T8:30", 30)).toBe("W1D1T9");
    expect(advanceVirtualTs("W1D1T8", 90)).toBe("W1D1T9:30");
    // 跨日：W1D1T23:30 + 60min → W1D2T0:30（D 递增，整分钟保留）
    expect(advanceVirtualTs("W1D1T23:30", 60)).toBe("W1D2T0:30");
    // 整点推进仍产出无分钟缀的字面量（与 PB 兼容）
    expect(advanceVirtualTs("W1D1T8", 60)).toBe("W1D1T9");
  });

  it("格式化：零分钟省略、非零分钟补两位；渲染含分钟", () => {
    expect(formatVirtualTs({ week: 3, day: 1, hour: 14, minute: 0 })).toBe("W3D1T14");
    expect(formatVirtualTs({ week: 3, day: 1, hour: 14, minute: 5 })).toBe("W3D1T14:05");
    expect(renderVirtualTs("W3D1T14:30")).toBe("第3周 周一 下午 30分");
  });

  it("比较按分钟：半小时差不再被小时投影抹平", () => {
    expect(compareVirtualTs("W1D1T8", "W1D1T8:30")).toBeLessThan(0);
    expect(compareVirtualTs("W1D1T8:30", "W1D1T8")).toBeGreaterThan(0);
    expect(compareVirtualTs("W1D1T8:30", "W1D1T8:30")).toBe(0);
  });
});