// ═══════════════════════════════════════════════════════════════════════════
// 检索预算 / 主体匹配 / 卡片渲染 回归（A25 / A26 / A27 / A28）
//
// 这些都是纯函数，直接对 retrieve / render 的导出做单元断言，不经过完整 mesh 桩：
//   · A25 整卡获批才扣账——装不下的卡不占额度，后续小卡仍可注入。
//   · A26 单次 recall 返回总量的 600 是「跨卡累计」上限，不是单卡上限。
//   · A27 在场主体按 (type,id) 全形 key 匹配，同 id 不同主体类型隔离。
//   · A28 projectEpisode 保留的 detail/quote 必须实际渲染进卡片（高 retention 展示、低 retention 记不清）。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";

import type { EpisodeCandidate } from "../src/memory/dao.js";
import { projectEpisode, renderMemoryCard } from "../src/memory/render.js";
import {
  rankCandidatesWithSubjects,
  selectCards,
  TurnRetrievalLedger,
  type RankedCandidate,
} from "../src/memory/retrieve.js";

// estimateTokens = ceil(text.length / 4)，故 repeat(tokens*4) 恰好 tokens token。
const sized = (tokens: number): string => "x".repeat(tokens * 4);

function candidate(id: string, extra: Partial<EpisodeCandidate> = {}): EpisodeCandidate {
  return {
    episodeId: id,
    ownerAgent: "agent-stu",
    kind: "event",
    sceneId: null,
    purposeKind: null,
    gist: `gist-${id}`,
    detail: null,
    quote: null,
    emotion: null,
    valence: null,
    arousal: null,
    salience: 0.5,
    confidence: 0.8,
    virtualTs: "W1D1T8",
    virtualHours: 8,
    rehearsalCount: 0,
    retention: 0.5,
    status: "active",
    bm25: -1.0,
    relevance: 1.0,
    ...extra,
  };
}

function ranked(id: string, extra: Partial<EpisodeCandidate> = {}): RankedCandidate {
  return {
    candidate: candidate(id, extra),
    relevance: 0.5,
    subjectMatch: 0.5,
    recencyVirtual: 0.5,
    valenceExtremity: 0.5,
    score: 0.5,
  };
}

describe("检索预算与卡片渲染（A25/A26/A27/A28）", () => {
  it("A25：整卡装不下时不占额度，后续小卡仍可注入（不出现「空注入却账满」）", () => {
    const ledger = new TurnRetrievalLedger(); // cap 900 / recallFloor 300 → auto 上限 600
    ledger.reserveAuto(500); // 已占 500，auto 余 100

    const texts = new Map([
      ["big", sized(150)], // 150 > 100，放不下
      ["small", sized(50)], // 50 ≤ 100，且足够
    ]);
    const res = selectCards([ranked("big"), ranked("small")], (r) => texts.get(r.candidate.episodeId)!, ledger, false);

    expect(res.selectedIds).toEqual(["small"]);
    expect(res.tokens).toBe(50);
    expect(res.clamped).toBe(1);
    // 额度未泄漏：500 + 50 = 550，而非 500 + 100（旧逻辑的部分获批）。
    expect(ledger.usedTokens()).toBe(550);
  });

  it("A26：单次 recall 的 600 是跨卡累计上限，两张 350 卡只取一张", () => {
    const ledger = new TurnRetrievalLedger();
    const texts = new Map([
      ["a", sized(350)],
      ["b", sized(350)],
    ]);
    const res = selectCards([ranked("a"), ranked("b")], (r) => texts.get(r.candidate.episodeId)!, ledger, true);

    expect(res.selectedIds).toEqual(["a"]); // 350 + 350 = 700 > 600，第二张被裁
    expect(res.tokens).toBe(350);
    expect(res.clamped).toBe(1);
  });

  it("A27：在场主体按 (type,id) 匹配，person:B 在场只能加权 person 记忆，facility 同 id 隔离", () => {
    const subjectsByEpisode = new Map([
      ["ep-person", [{ type: "person" as const, id: "B" }]],
      ["ep-facility", [{ type: "facility" as const, id: "B" }]],
    ]);
    const rankedList = rankCandidatesWithSubjects(
      [candidate("ep-person"), candidate("ep-facility")],
      subjectsByEpisode,
      { nowHours: 8, tau0Hours: 16, presentSubjects: new Set(["self", "person:B"]) },
    );

    const byId = new Map(rankedList.map((r) => [r.candidate.episodeId, r.subjectMatch]));
    expect(byId.get("ep-person")).toBe(1); // person:B 命中在场
    expect(byId.get("ep-facility")).toBe(0); // facility:B ≠ person:B，不跨类型命中
  });

  it("A28：高 retention 卡片展示 detail/quote，低 retention 展示「记不清」", () => {
    const base = { gist: "她把伞留给我", detail: "那天雨很大", quote: "我的伞你拿着", emotion: "愧疚", valence: -0.6, arousal: 0.5, retention: 0.8 };

    const hi = renderMemoryCard({
      kind: "event",
      projected: projectEpisode(base),
      retention: 0.8,
      confidence: 0.8,
      virtualHours: 10,
      nowHours: 12,
      subjects: [],
    });
    expect(hi).toContain("细节：那天雨很大");
    expect(hi).toContain("原话：我的伞你拿着");
    expect(hi).not.toContain("记不清");

    const lo = renderMemoryCard({
      kind: "event",
      projected: projectEpisode({ ...base, retention: 0.3 }),
      retention: 0.3,
      confidence: 0.8,
      virtualHours: 10,
      nowHours: 12,
      subjects: [],
    });
    expect(lo).not.toContain("细节：那天雨很大");
    expect(lo).not.toContain("原话：我的伞你拿着");
    expect(lo).toContain("记不清");
  });
});