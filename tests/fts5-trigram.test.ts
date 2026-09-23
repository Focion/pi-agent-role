// ═══════════════════════════════════════════════════════════════════════════
// P1-1.5 FTS5 trigram 中文检索验证（§14.2.3）：
//   episodes_fts 用 tokenize = 'trigram' 零依赖支持中文子串匹配；
//   bm25() 在 trigram 下返回负值（越负越相关），必须先取反再按查询内最大值归一。
//
// 关键事实（用真实 better-sqlite3 逐条验证后写成断言）：
//   · trigram 的 MATCH 词元至少 3 个 Unicode 字符才可命中——2 字词（「板书」「笔记」「教室」）
//     裸查或 `"…"` 短语都不命中，本测试一律用 3+ 字子串。
//   · 连续中文子串裸查与 `"…"` 短语等价；本测试按 §14.2.3 的短语语法统一用双引号。
//   · content='episodes' 外部内容表模式：JOIN 用 e.rowid = episodes_fts.rowid，
//     过滤用 episodes_fts MATCH :q，三个触发器负责 INSERT / UPDATE OF gist / DELETE 的同步。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, describe, expect, it } from "vitest"

import Database from "better-sqlite3"

import { openRoleDb } from "../src/db/db.js"
import type { RoleDb } from "../src/db/db.js"

// §14.2.3：bm25() 在 FTS5 里返回负值，越负越相关。先取反，再按本次查询最大归一。
function normalizeRelevance(rows: { bm25: number }[]): number[] {
  const s = rows.map((r) => -r.bm25)
  const max = Math.max(...s, 1e-9)
  return s.map((v) => v / max)
}

const SELF = "agent-alice"

interface EpisodeRow {
  episode_id: string
  owner_agent: string
  kind: string
  gist: string
  salience: number
  confidence: number
  real_ts: string
  virtual_hours: number
  rehearsal_count: number
  retention: number
  status: string
}

const INSERT_EPISODE = `
  INSERT INTO episodes (
    episode_id, owner_agent, kind, gist,
    salience, confidence, real_ts, virtual_hours,
    rehearsal_count, retention, status
  ) VALUES (
    @episode_id, @owner_agent, @kind, @gist,
    @salience, @confidence, @real_ts, @virtual_hours,
    @rehearsal_count, @retention, @status
  )
`

function insertEpisode(db: Database.Database, episodeId: string, gist: string): void {
  const row: EpisodeRow = {
    episode_id: episodeId,
    owner_agent: SELF,
    kind: "event",
    gist,
    salience: 0.5,
    confidence: 0.5,
    real_ts: "2026-01-01T00:00:00Z",
    virtual_hours: 10,
    rehearsal_count: 0,
    retention: 0.5,
    status: "active",
  }
  db.prepare<EpisodeRow, unknown>(INSERT_EPISODE).run(row)
}

interface FtsRow {
  episode_id: string
  bm25: number
}

// §14.2.3 候选查询：外部内容表用 e.rowid = episodes_fts.rowid；MATCH 参数是短语，须带双引号。
const MATCH_SQL = `
  SELECT e.episode_id, bm25(episodes_fts) AS bm25
    FROM episodes_fts
    JOIN episodes e ON e.rowid = episodes_fts.rowid
   WHERE episodes_fts MATCH :q
     AND e.owner_agent = :self
   ORDER BY bm25 ASC
`

function matchGist(db: Database.Database, phrase: string, self = SELF): FtsRow[] {
  return db.prepare<{ q: string; self: string }, FtsRow>(MATCH_SQL).all({ q: `"${phrase}"`, self })
}

const countEpisodes = (db: Database.Database): number =>
  db.prepare<[], { n: number }>("SELECT count(*) AS n FROM episodes").get()!.n

const countFts = (db: Database.Database): number =>
  db.prepare<[], { n: number }>("SELECT count(*) AS n FROM episodes_fts").get()!.n

describe("P1-1.5 FTS5 trigram 中文检索（§14.2.3）", () => {
  let dir: string
  let role: RoleDb
  let db: Database.Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-role-fts-"))
    role = openRoleDb(join(dir, "role-agent.db"))
    db = role.db
  })

  afterEach(() => {
    role.close()
  })

  it("空临时路径上可建库 + 迁移，且存在 episodes_fts 索引", () => {
    expect(role).toBeDefined()
    const n = db
      .prepare<[], { n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'episodes_fts'")
      .get()!.n
    expect(n).toBe(1)
  })

  it("trigram MATCH 命中含中文字串的行，且不命中无关行", () => {
    insertEpisode(db, "ep-force", "物理老师讲解受力分析的解题方法")
    insertEpisode(db, "ep-exam", "期末考试安排在月底进行")
    insertEpisode(db, "ep-meeting", "家长会安排在教室里举行")
    insertEpisode(db, "ep-board", "黑板上的板书内容十分清晰")

    const ids = (rows: FtsRow[]): string[] => rows.map((r) => r.episode_id).sort()

    expect(ids(matchGist(db, "受力分析"))).toEqual(["ep-force"])
    expect(ids(matchGist(db, "期末考试"))).toEqual(["ep-exam"])
    expect(ids(matchGist(db, "家长会"))).toEqual(["ep-meeting"])
    expect(ids(matchGist(db, "板书内容"))).toEqual(["ep-board"])

    // 无关词元一个不命中
    expect(matchGist(db, "运动会")).toEqual([])
  })

  it("三个触发器保持索引同步：INSERT 可查、UPDATE 换新、DELETE 消失", () => {
    insertEpisode(db, "ep-sync", "初始内容记录了受力分析的要点")
    expect(countEpisodes(db)).toBe(1)
    expect(matchGist(db, "受力分析").map((r) => r.episode_id)).toEqual(["ep-sync"])

    db.prepare<[string, string], unknown>("UPDATE episodes SET gist = ? WHERE episode_id = ?").run(
      "更新后记录了期末考试的范围",
      "ep-sync",
    )
    expect(matchGist(db, "受力分析")).toEqual([])
    expect(matchGist(db, "期末考试").map((r) => r.episode_id)).toEqual(["ep-sync"])

    db.prepare<[string], unknown>("DELETE FROM episodes WHERE episode_id = ?").run("ep-sync")
    expect(matchGist(db, "期末考试")).toEqual([])

    // 计数也同步：触发器不残留半截索引
    expect(countFts(db)).toBe(countEpisodes(db))
    expect(countEpisodes(db)).toBe(0)
  })

  it("bm25() 为负（越负越相关），取反归一后落在 [0,1] 且最相关记分为 1.0", () => {
    insertEpisode(db, "ep-force", "受力分析是本节课的重点")
    insertEpisode(db, "ep-force-heavy", "受力分析受力分析")

    const rows = matchGist(db, "受力分析")
    expect(rows).toHaveLength(2)

    for (const r of rows) expect(r.bm25).toBeLessThan(0)

    // 更负 = 更相关（子串出现更多次）
    const byRelevance = [...rows].sort((a, b) => a.bm25 - b.bm25)
    expect(byRelevance[0]!.episode_id).toBe("ep-force-heavy")

    const scores = normalizeRelevance(byRelevance)
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
    expect(scores[0]).toBe(1)
  })
})