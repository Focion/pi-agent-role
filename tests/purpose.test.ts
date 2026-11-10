// ═══════════════════════════════════════════════════════════════════════════
// R29 · 通用用途 purpose_kind（§17.6 教学进度）—— 不加教师特例
//
// 断言：
//   1. `remember` 带 `purpose=teaching_progress` → 落 `purpose_kind`，且 salience/retention
//      被系统抬到 0.7 地板（角色主观打分低时抬高、高时保留）。
//   2. `purpose` 越出封闭白名单 → ARG_INVALID，不落情节（不静默降级为无目的）。
//   3. 无 `purpose` → `purpose_kind` 为 NULL，salience 保持 turn 打分（0.5 兜底）。
//   4. 教学进度重复检测：与最近 5 条同用途情节的 knowledge 主体求交，命中 N 条在
//      detail 末尾追加「（已重复 N 次）」，只呈现重复事实、不承诺模型绝不重复。
//   5. 用途检索 DAO（recentByPurpose / recentPurposeKnowledgeSubjects）：active/consolidated
//      按虚拟时间倒序、默认至多 3 条、可按 curriculum 过滤、faded 排除。
//
// 用 `makeMemoryTools` + 真实 MemoryDao + `freshTurnState` 直测处理器——不经 mesh SessionFactory
// （真实 LLM 会话需凭据），保持确定性输入（无 turn.score → salience 兜底 0.5）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultMemoryPolicy } from "../src/compile/types.js";
import { openRoleDb, type RoleDb } from "../src/db/db.js";
import { MemoryDao } from "../src/memory/dao.js";
import { makeMemoryTools } from "../src/memory/tools.js";
import { PURPOSE_RETRIEVAL_LIMIT, TEACHING_PROGRESS_SALIENCE_FLOOR } from "../src/memory/purpose.js";
import { freshTurnState, type TurnState } from "../src/memory/turn.js";

type SimpleTool = (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: unknown; details?: unknown }>;

interface Harness {
  dir: string;
  roleDb: RoleDb;
  db: RoleDb["db"];
  dao: MemoryDao;
  owner: string;
  remember: SimpleTool;
  /** 换一个新的进行中轮（重置写配额 + 虚拟时间），供跨轮重复写入。 */
  nextTurn: (virtualHours: number) => TurnState;
}

const cleanups: Array<{ dir: string; roleDb: RoleDb }> = [];

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-purpose-"));
  const roleDb = openRoleDb(join(dir, "role-agent.db"));
  const db = roleDb.db;
  cleanups.push({ dir, roleDb });

  let realNow = 0;
  const nowReal = (): string => new Date(Date.UTC(2026, 1, 1) + realNow++).toISOString();
  const dao = new MemoryDao(db, { nowReal });
  const owner = "agent-stu";

  let turn = freshTurnState({
    accountId: "acct-stu",
    ownerAgent: owner,
    policy: defaultMemoryPolicy(),
    path: "P1",
    virtualTs: "W1D1T8",
    virtualHours: 8,
    sceneId: "scene-1",
    sourceMsgId: "msg-8",
  });

  const tools = makeMemoryTools({
    dao,
    ownerAgent: owner,
    currentTurn: () => turn,
    knownAgents: new Set<string>(),
  });

  const nextTurn = (virtualHours: number): TurnState => {
    turn = freshTurnState({
      accountId: "acct-stu",
      ownerAgent: owner,
      policy: defaultMemoryPolicy(),
      path: "P1",
      virtualTs: `W1D1T${virtualHours}`,
      virtualHours,
      sceneId: "scene-1",
      sourceMsgId: `msg-${virtualHours}`,
    });
    return turn;
  };

  return { dir, roleDb, db, dao, owner, remember: tools.remember as unknown as SimpleTool, nextTurn };
}

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c.roleDb.close();
    } catch {
      /* noop */
    }
    try {
      rmSync(c.dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

const latestEpisodes = (db: RoleDb["db"], owner: string) =>
  db
    .prepare("SELECT * FROM episodes WHERE owner_agent = ? ORDER BY rowid")
    .all(owner) as Array<{ episode_id: string; purpose_kind: string | null; salience: number; retention: number; detail: string | null; virtual_hours: number; status: string }>;

describe("R29 通用用途 purpose_kind（§17.6 教学进度）", () => {
  it("purpose=teaching_progress → 落 purpose_kind，salience/retention 抬到 0.7 地板", async () => {
    const h = setup();
    await h.remember("tc-1", {
      gist: "掌握了牛顿第二定律的推导",
      purpose: "teaching_progress",
      subjectRefs: ["knowledge:kn:newton", "curriculum:cur:mech"],
    });
    const rows = latestEpisodes(h.db, h.owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purpose_kind).toBe("teaching_progress");
    expect(rows[0]!.salience).toBe(TEACHING_PROGRESS_SALIENCE_FLOOR);
    expect(rows[0]!.retention).toBe(TEACHING_PROGRESS_SALIENCE_FLOOR);
  });

  it("purpose 越出白名单 → ARG_INVALID 且不落情节", async () => {
    const h = setup();
    const res = await h.remember("tc-2", { gist: "x", purpose: "made_up_purpose" });
    expect(JSON.parse(res.content as string)).toMatchObject({ error: { code: "ARG_INVALID" } });
    expect(latestEpisodes(h.db, h.owner)).toHaveLength(0);
  });

  it("无 purpose → purpose_kind NULL，salience 保持 turn 打分兜底 0.5", async () => {
    const h = setup();
    await h.remember("tc-3", { gist: "一件普通的小事" });
    const rows = latestEpisodes(h.db, h.owner);
    expect(rows[0]!.purpose_kind).toBeNull();
    expect(rows[0]!.salience).toBe(0.5);
  });

  it("主观显著度高于地板时不被压低（Math.max 保留 0.9）", async () => {
    const h = setup();
    const t = h.nextTurn(900);
    t.score = { salience: 0.9, write: true, components: {} };
    await h.remember("tc-4", { gist: "牛顿定律我已彻底讲明白", purpose: "teaching_progress", subjectRefs: ["knowledge:kn:newton"] });
    const rows = latestEpisodes(h.db, h.owner);
    expect(rows[0]!.salience).toBe(0.9);
    expect(rows[0]!.retention).toBe(0.9);
  });

  it("重复检测：同一 knowledge 主体命中最近 5 条同用途情节 → detail 追加（已重复 N 次）", async () => {
    const h = setup();
    // 连续 3 次记同一条 knowledge 主体：第 2 次重复 1 次、第 3 次重复 2 次（都在 maxWritesPerTurn=3 内）。
    await h.remember("t1", { gist: "牛顿定律懂了", purpose: "teaching_progress", subjectRefs: ["knowledge:kn:newton"] });
    await h.remember("t2", { gist: "牛顿定律再巩固", purpose: "teaching_progress", subjectRefs: ["knowledge:kn:newton"] });
    await h.remember("t3", { gist: "牛顿定律又讲了一遍", purpose: "teaching_progress", subjectRefs: ["knowledge:kn:newton"] });

    const rows = latestEpisodes(h.db, h.owner);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.detail).toBeNull(); // 首次不重复
    expect(rows[1]!.detail).toBe("（已重复 1 次）");
    expect(rows[2]!.detail).toBe("（已重复 2 次）");
  });

  it("重复检测只看 knowledge 主体：纯 curriculum/person 主体不参与求交", async () => {
    const h = setup();
    // 第一条同用途情节只挂 curriculum（无 knowledge）。
    await h.remember("t1", { gist: "力学总览", purpose: "teaching_progress", subjectRefs: ["curriculum:cur:mech"] });
    // 第二条挂 knowledge:kn:newton，此前无 knowledge 主体 → 不重复。
    await h.remember("t2", { gist: "牛顿定律", purpose: "teaching_progress", subjectRefs: ["knowledge:kn:newton"] });
    const rows = latestEpisodes(h.db, h.owner);
    expect(rows[1]!.detail).toBeNull();
  });
});

describe("R29 用途检索 DAO（recentByPurpose / recentPurposeKnowledgeSubjects）", () => {
  function seed(h: Harness): void {
    // 四条 teaching_progress，虚拟时间 40/30/20/10，其一 faded、其一不挂 mech 课程。
    const items: Array<{ id: string; hours: number; status: "active" | "faded"; subj: Array<{ ref: { type: "knowledge" | "curriculum"; id: string } }> }> = [
      { id: "ep-40", hours: 40, status: "active", subj: [{ ref: { type: "knowledge", id: "kn:a" } }, { ref: { type: "curriculum", id: "cur:mech" } }] },
      { id: "ep-30", hours: 30, status: "faded", subj: [{ ref: { type: "knowledge", id: "kn:b" } }, { ref: { type: "curriculum", id: "cur:mech" } }] },
      { id: "ep-20", hours: 20, status: "active", subj: [{ ref: { type: "knowledge", id: "kn:c" } }, { ref: { type: "curriculum", id: "cur:optics" } }] },
      { id: "ep-10", hours: 10, status: "active", subj: [{ ref: { type: "knowledge", id: "kn:a" } }, { ref: { type: "curriculum", id: "cur:mech" } }] },
    ];
    for (const it of items) {
      h.dao.insertEpisode({
        episodeId: it.id,
        ownerAgent: h.owner,
        kind: "event",
        purposeKind: "teaching_progress",
        gist: `里程碑 ${it.hours}`,
        detail: null,
        quote: null,
        emotion: null,
        valence: null,
        arousal: null,
        salience: 0.7,
        confidence: 0.8,
        accuracy: null,
        virtualTs: `W1D1T${it.hours}`,
        virtualHours: it.hours,
        retention: 0.7,
        status: it.status,
        subjects: it.subj,
      });
    }
  }

  it("recentByPurpose：active/consolidated 按虚拟时间倒序、默认至多 3 条、faded 排除", () => {
    const h = setup();
    seed(h);
    const got = h.dao.recentByPurpose(h.owner, "teaching_progress");
    expect(got.length).toBe(PURPOSE_RETRIEVAL_LIMIT);
    expect(got.map((c) => c.episodeId)).toEqual(["ep-40", "ep-20", "ep-10"]); // ep-30 是 faded，排除
    expect(got.every((c) => c.status === "active" || c.status === "consolidated")).toBe(true);
  });

  it("recentByPurpose：curriculum 过滤只留挂指定课程主体的情节", () => {
    const h = setup();
    seed(h);
    const got = h.dao.recentByPurpose(h.owner, "teaching_progress", { curriculumId: "cur:mech" });
    expect(got.map((c) => c.episodeId)).toEqual(["ep-40", "ep-10"]); // ep-20 挂 cur:optics，滤除；ep-30 faded 排除
  });

  it("recentPurposeKnowledgeSubjects：返回最近 N 条的知识主体（倒序、无知识主体的条被过滤）", () => {
    const h = setup();
    seed(h);
    // ep-40 → kn:a；ep-30(faded) → kn:b；ep-20 → kn:c；ep-10 → kn:a。前 3 条（40/30/20）：
    const got = h.dao.recentPurposeKnowledgeSubjects(h.owner, "teaching_progress", 3);
    expect(got.map((g) => g.episodeId)).toEqual(["ep-40", "ep-30", "ep-20"]);
    expect(got.map((g) => g.knowledgeIds)).toEqual([["kn:a"], ["kn:b"], ["kn:c"]]);
  });
});