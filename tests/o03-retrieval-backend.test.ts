// ═══════════════════════════════════════════════════════════════════════════
// O03 · 可替换向量检索后端（§14.2.3 前端抽象）
//
// 把「文本 → 相关情节候选」抽象成 RetrievalBackend。FTS5 是默认实现（bm25 取反为
// relevance），未来向量后端实现同一接口即可在 rankCandidatesWithSubjects 之后被替换。
// 断言：
//   1. Fts5Backend 产出 relevance = -bm25（≥0），与 dao 直接查询同 id 同序。
//   2. compareRetrieval 在同 owner/query/预算下对齐两后端的召回面（交/并/差），owner 不跨界。
//   3. recall 路径把 `backend` 写进 retrieval_log.query_json（回放元数据）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultMemoryPolicy } from "../src/compile/types.js";
import { openRoleDb, type RoleDb } from "../src/db/db.js";
import { compareRetrieval, Fts5Backend, type RetrievalBackend, type RetrievalQuery } from "../src/memory/backend.js";
import { MemoryDao, type EpisodeCandidate, type EpisodeWrite } from "../src/memory/dao.js";
import { freshTurnState } from "../src/memory/turn.js";
import { makeMemoryTools } from "../src/memory/tools.js";

type SimpleTool = (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: unknown; details?: unknown }>;

interface Harness {
  dir: string;
  roleDb: RoleDb;
  dao: MemoryDao;
  owner: string;
}

const cleanups: Array<{ dir: string; roleDb: RoleDb }> = [];

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-o03-"));
  const roleDb = openRoleDb(join(dir, "role-agent.db"));
  cleanups.push({ dir, roleDb });
  let realNow = 0;
  const nowReal = (): string => new Date(Date.UTC(2026, 1, 1) + realNow++).toISOString();
  const dao = new MemoryDao(roleDb.db, { nowReal });
  return { dir, roleDb, dao, owner: "agent-stu" };
}

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c.roleDb.close();
    } catch {
      // 已关闭
    }
    try {
      rmSync(c.dir, { recursive: true, force: true });
    } catch {
      // best-effort 清理
    }
  }
});

function writeEpisode(dao: MemoryDao, owner: string, id: string, gist: string, virtualHours: number): void {
  const w: EpisodeWrite = {
    episodeId: id,
    ownerAgent: owner,
    kind: "event",
    sceneId: null,
    purposeKind: null,
    sourceMsgId: null,
    sourceSessionId: null,
    sourceEntryId: null,
    gist,
    detail: null,
    quote: null,
    emotion: null,
    valence: null,
    arousal: null,
    salience: 0.6,
    confidence: 0.8,
    accuracy: null,
    virtualTs: `W1D1T${virtualHours}`,
    virtualHours,
    retention: 0.6,
    status: "active",
    modelConfigHash: null,
    subjects: [{ ref: { type: "self", id: "self" } }],
  };
  dao.insertEpisode(w);
}

/** 最小完整 EpisodeCandidate（compareRetrieval 只读 episodeId，其余字段占位）。 */
function cand(id: string, relevance = 1): EpisodeCandidate {
  return {
    episodeId: id,
    ownerAgent: "agent-stu",
    kind: "event",
    sceneId: null,
    purposeKind: null,
    gist: `g-${id}`,
    detail: null,
    quote: null,
    emotion: null,
    valence: null,
    arousal: null,
    salience: 0.5,
    confidence: 0.8,
    virtualTs: null,
    virtualHours: 8,
    rehearsalCount: 0,
    retention: 0.5,
    status: "active",
    bm25: -relevance,
    relevance,
  };
}

describe("O03 可替换检索后端", () => {
  it("Fts5Backend 产出 relevance = -bm25（≥0），与 dao 直查同 id 同序", () => {
    const { dao, owner } = setup();
    writeEpisode(dao, owner, "ep-1", "王老师讲了一元二次方程的求根公式", 8);
    writeEpisode(dao, owner, "ep-2", "班会上讨论春游安排", 9);

    const backend = new Fts5Backend(dao);
    const q: RetrievalQuery = { owner, query: "一元二次", includeFaded: false };
    const viaBackend = backend.searchCandidates(q);
    const viaDao = dao.searchCandidates(owner, "一元二次", false);

    expect(viaBackend.length).toBeGreaterThan(0);
    expect(viaBackend.map((c) => c.episodeId)).toEqual(viaDao.map((c) => c.episodeId));
    for (const c of viaBackend) {
      expect(c.relevance).toBeGreaterThanOrEqual(0);
      expect(c.relevance).toBeCloseTo(-c.bm25, 10);
    }
  });

  it("compareRetrieval 对齐两后端召回面：交/并/差 + owner 不跨界", () => {
    const a: RetrievalBackend = {
      id: "a",
      searchCandidates: (q) => [cand("ep-1"), cand("ep-2"), cand("ep-3")],
    };
    const b: RetrievalBackend = {
      id: "b",
      searchCandidates: (q) => [cand("ep-2"), cand("ep-3"), cand("ep-4")],
    };
    const q: RetrievalQuery = { owner: "agent-stu", query: "x", includeFaded: false, limit: 3 };

    const cmp = compareRetrieval(a, b, q);
    expect(cmp.a.backendId).toBe("a");
    expect(cmp.b.backendId).toBe("b");
    expect(cmp.common).toEqual(["ep-2", "ep-3"]);
    expect(cmp.aOnly).toEqual(["ep-1"]);
    expect(cmp.bOnly).toEqual(["ep-4"]);
    expect(cmp.owner).toBe("agent-stu");
  });

  it("recall 把 backend 写进 retrieval_log.query_json（回放元数据）", async () => {
    const { dao, owner, roleDb } = setup();
    writeEpisode(dao, owner, "ep-1", "王老师讲了一元二次方程的求根公式", 8);

    const turn = freshTurnState({
      accountId: "acct-stu",
      ownerAgent: owner,
      policy: defaultMemoryPolicy(),
      path: "P1",
      virtualTs: "W1D1T8",
      virtualHours: 8,
      sourceMsgId: "m1",
    });
    const tools = makeMemoryTools({ dao, ownerAgent: owner, currentTurn: () => turn, knownAgents: new Set() });
    const recall = tools.recall as unknown as SimpleTool;
    await recall("c", { query: "一元二次" });

    const rec = roleDb.db
      .prepare("SELECT query_json FROM retrieval_log WHERE owner_agent = ? ORDER BY rowid DESC LIMIT 1")
      .get(owner) as { query_json: string } | undefined;
    expect(rec).toBeDefined();
    const parsed = JSON.parse(rec!.query_json) as { query: string; channel: string; backend: string };
    expect(parsed).toMatchObject({ query: "一元二次", channel: "recall", backend: "fts5" });
  });
});