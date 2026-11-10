// ═══════════════════════════════════════════════════════════════════════════
// P5 知识记忆测试（§17）—— 掌握度状态机 + 证据门槛 + taught_by + 误区 + 学习队列
//
// 用真实 DB-A DDL（openRoleDb）+ KnowledgeService 直接驱动（不走 mesh / 反射往返），验证：
//   · T1–T11 封闭迁移集：合法边推进、非法边驳回（ILLEGAL_TRANSITION / EVIDENCE_MISSING）；
//   · evidenceEpisode 的 NOT_FOUND / NOT_OWNED 区分；
//   · T4 mastered 的「≥2 solved 且跨 ≥2 虚拟日」查库门槛；taught 证据直通；
//   · T5 跳级补中间事件，补写事件不计入 second solved；
//   · T6 同态只维护计数（practiced，无事件）；T11 纠错降级 + 置误区 + wrong_belief 保留；
//   · confidence 单次 ±0.15 限幅；taught_by 归因（未知 person → self）；
//   · seedFromTemplate 幂等种入 + decay 衰减；
//   · learningQueue 整理（Q4 误区自动入队 / Q1 掌握出队 / Q3 封顶）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openRoleDb, type RoleDb } from "../src/db/db.js";
import { KnowledgeDao } from "../src/knowledge/dao.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import type { KnowledgeUpdateProposal } from "../src/knowledge/types.js";

const cleanups: Array<{ dir: string; roleDb: RoleDb }> = [];
function setup(knownAgents: string[] = []): { dir: string; roleDb: RoleDb; db: RoleDb["db"]; svc: KnowledgeService } {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-kn-"));
  const roleDb = openRoleDb(join(dir, "role-agent.db"));
  const db = roleDb.db;
  let t = 0;
  const nowReal = (): string => new Date(Date.UTC(2026, 0, 1) + t++ * 1000).toISOString();
  const dao = new KnowledgeDao(db, { nowReal });
  const svc = new KnowledgeService({ dao, knownAgents: () => new Set(knownAgents) });
  cleanups.push({ dir, roleDb });
  return { dir, roleDb, db, svc };
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

function addEpisode(db: RoleDb["db"], episodeId: string, owner: string): void {
  db.prepare(
    `INSERT INTO episodes (episode_id, owner_agent, kind, gist, real_ts) VALUES (?, ?, 'event', 'gist', ?)`,
  ).run(episodeId, owner, "2026-01-01T00:00:00.000Z");
}

/** 一条最小提案（topic + 目标态 + 证据 + 虚拟时钟）。 */
function proposal(topic: string, toMastery: KnowledgeUpdateProposal["toMastery"], evidenceKind: KnowledgeUpdateProposal["evidenceKind"], overrides: Partial<KnowledgeUpdateProposal> = {}): KnowledgeUpdateProposal {
  return { topic, toMastery, evidenceKind, evidence: "e", ...overrides };
}

describe("P5 知识状态机（§17.1/§17.2）", () => {
  it("T1 unseen→heard 需要 mentioned；证据不足驳回", () => {
    const { db, svc } = setup();
    const bad = svc.applyUpdate("ag-stu", proposal("kn:a", "heard", "solved"), { virtualTs: "W1D1T8" });
    expect(bad).toMatchObject({ ok: false, reason: "EVIDENCE_MISSING" });

    const ok = svc.applyUpdate("ag-stu", proposal("kn:a", "heard", "mentioned", { evidence: "课上提到了" }), { virtualTs: "W1D1T8" });
    expect(ok).toMatchObject({ ok: true, from: null, to: "heard" });
    if (ok.ok) expect(ok.eventIds.length).toBe(1);

    const row = db.prepare("SELECT mastery, source_kind FROM knowledge_items WHERE owner_agent = 'ag-stu'").get();
    expect(row).toMatchObject({ mastery: "heard", source_kind: "inferred" });
  });

  it("T2/T3/T4 阶梯：heard→understood→applied→mastered 的证据链", () => {
    const { db, svc } = setup();
    svc.applyUpdate("ag-stu", proposal("kn:calc", "heard", "mentioned"), { virtualTs: "W1D1T8" });
    svc.applyUpdate("ag-stu", proposal("kn:calc", "understood", "explained"), { virtualTs: "W1D1T8" });
    const applied = svc.applyUpdate("ag-stu", proposal("kn:calc", "applied", "solved", { evidence: "独立推完" }), { virtualTs: "W1D1T9" });
    expect(applied).toMatchObject({ ok: true, to: "applied" });

    // mastered：已有 1 次 solved 且仅 1 个虚拟日 → 次数不足先驳回。
    const tooFew = svc.applyUpdate("ag-stu", proposal("kn:calc", "mastered", "solved"), { virtualTs: "W1D1T10" });
    expect(tooFew).toMatchObject({ ok: false, reason: "MASTERED_SPAN_TOO_SHORT" });

    // 跨到第 2 个虚拟日再 solved 一次 → 满足 ≥2 次且 ≥2 日。
    const mastered = svc.applyUpdate("ag-stu", proposal("kn:calc", "mastered", "solved"), { virtualTs: "W1D2T9" });
    expect(mastered).toMatchObject({ ok: true, to: "mastered" });

    const solved = db.prepare("SELECT COUNT(*) AS n FROM knowledge_events WHERE evidence_kind = 'solved' AND owner_agent = 'ag-stu'").get() as { n: number };
    expect(solved.n).toBe(2); // applied 的 1 次 + mastered 的第 2 次（被 T4 拒绝的那次未落库）
  });

  it("T4 mastered 的 solved 门槛；taught 证据直通不查库", () => {
    const { svc } = setup();
    // taught 从 applied→mastered 直通（cross-owner 校验延迟成立，见 §17.2 尾段）。
    svc.applyUpdate("ag-stu", proposal("kn:b", "heard", "mentioned"), { virtualTs: "W1D1T8" });
    svc.applyUpdate("ag-stu", proposal("kn:b", "applied", "solved"), { virtualTs: "W1D1T9" });
    const masteredViaTaught = svc.applyUpdate("ag-stu", proposal("kn:b", "mastered", "taught", { taughtBy: "person:ag-teacher-01" }), { virtualTs: "W1D1T10" });
    expect(masteredViaTaught).toMatchObject({ ok: true, to: "mastered" });
  });

  it("T5 跳级 heard→applied 补中间事件，且不把补写事件算作 second solved", () => {
    const { db, svc } = setup();
    svc.applyUpdate("ag-stu", proposal("kn:c", "heard", "mentioned"), { virtualTs: "W1D1T8" });
    const skip = svc.applyUpdate("ag-stu", proposal("kn:c", "applied", "solved"), { virtualTs: "W1D1T9" });
    expect(skip).toMatchObject({ ok: true, to: "applied" });
    if (skip.ok) expect(skip.eventIds.length).toBe(2);
    const solved = db.prepare("SELECT COUNT(*) AS n FROM knowledge_events WHERE evidence_kind = 'solved' AND owner_agent = 'ag-stu'").get() as { n: number };
    expect(solved.n).toBe(1); // 补写的中间事件是 self_explained，不算 solved
  });

  it("非法迁移（heard→mastered / 目标 fading/forgotten / decay 证据）一律 ILLEGAL_TRANSITION", () => {
    const { svc } = setup();
    svc.applyUpdate("ag-stu", proposal("kn:d", "heard", "mentioned"), { virtualTs: "W1D1T8" });
    expect(svc.applyUpdate("ag-stu", proposal("kn:d", "mastered", "solved"), { virtualTs: "W1D1T9" })).toMatchObject({
      ok: false,
      reason: "ILLEGAL_TRANSITION",
    });
    expect(svc.applyUpdate("ag-stu", proposal("kn:e", "fading", "mentioned"), { virtualTs: "W1D1T8" })).toMatchObject({
      ok: false,
      reason: "ILLEGAL_TRANSITION",
    });
    expect(svc.applyUpdate("ag-stu", proposal("kn:d", "heard", "decay"), { virtualTs: "W1D1T9" })).toMatchObject({
      ok: false,
      reason: "ILLEGAL_TRANSITION",
    });
  });

  it("T6 同态只维护计数（practiced，无事件）；confidence 限幅 ±0.15", () => {
    const { db, svc } = setup();
    svc.applyUpdate("ag-stu", proposal("kn:f", "heard", "mentioned"), { virtualTs: "W1D1T8" });
    const practice = svc.applyUpdate("ag-stu", proposal("kn:f", "heard", "mentioned", { confidenceDelta: 0.9 }), { virtualTs: "W1D1T9" });
    expect(practice).toMatchObject({ ok: true, practiced: true, to: "heard" });
    if (practice.ok) expect(practice.eventIds.length).toBe(0);
    const row = db.prepare("SELECT practice_count, confidence FROM knowledge_items WHERE owner_agent = 'ag-stu'").get() as { practice_count: number; confidence: number };
    expect(row.practice_count).toBe(2);
    expect(row.confidence).toBeCloseTo(0.65); // 0.5 + 0.15（0.9 被夹到上限）
  });

  it("T11 纠错降级 + 置误区 + wrong_belief 错误值保留", () => {
    const { db, svc } = setup();
    svc.applyUpdate("ag-stu", proposal("kn:g", "heard", "mentioned"), { virtualTs: "W1D1T8" });
    svc.applyUpdate("ag-stu", proposal("kn:g", "applied", "solved"), { virtualTs: "W1D1T9" });
    const correct = svc.applyUpdate(
      "ag-stu",
      proposal("kn:g", "understood", "corrected", { wrongBelief: "摩擦力总是与运动方向相反" }),
      { virtualTs: "W1D2T8" },
    );
    expect(correct).toMatchObject({ ok: true, to: "understood" });
    const row = db.prepare("SELECT mastery, is_misconception, wrong_belief FROM knowledge_items WHERE owner_agent = 'ag-stu'").get() as { mastery: string; is_misconception: number; wrong_belief: string };
    expect(row.mastery).toBe("understood");
    expect(row.is_misconception).toBe(1);
    expect(row.wrong_belief).toContain("摩擦力");
  });

  it("R27 纠正裁决：误区 1→0 返回 misconceptionCorrected；置误区（0→1）不返回", () => {
    const { svc } = setup(["ag-teacher-01"]);
    svc.applyUpdate("ag-stu", proposal("kn:j", "heard", "mentioned"), { virtualTs: "W1D1T8" });
    svc.applyUpdate("ag-stu", proposal("kn:j", "applied", "solved"), { virtualTs: "W1D1T9" });

    // 置误区（0→1）：corrected 证据触发 T11，不触发纠正情节。
    const setMiss = svc.applyUpdate(
      "ag-stu",
      proposal("kn:j", "understood", "corrected", { wrongBelief: "旧的错误理解", taughtBy: "person:ag-teacher-01" }),
      { virtualTs: "W1D2T8" },
    );
    expect(setMiss).toMatchObject({ ok: true });
    expect(setMiss.ok && setMiss.misconceptionCorrected).toBeUndefined();

    // 纠正（1→0）：T3 understood→applied + isMisconception:false 清误区 → 裁决带纠正载荷。
    const corr = svc.applyUpdate(
      "ag-stu",
      proposal("kn:j", "applied", "solved", { isMisconception: false, taughtBy: "person:ag-teacher-01" }),
      { virtualTs: "W1D2T9" },
    );
    expect(corr).toMatchObject({ ok: true, to: "applied" });
    expect(corr.ok && corr.misconceptionCorrected).toMatchObject({
      topic: "kn:j",
      corrector: "person:ag-teacher-01",
      wrongBelief: "旧的错误理解",
    });
  });

  it("evidenceEpisode：不存在 / 不属于 owner 的区分", () => {
    const { db, svc } = setup(["ag-teacher-01"]);
    addEpisode(db, "ep-1", "ag-teacher-01");
    svc.applyUpdate("ag-stu", proposal("kn:h", "heard", "mentioned"), { virtualTs: "W1D1T8" });

    expect(
      svc.applyUpdate("ag-stu", proposal("kn:h", "understood", "explained", { evidenceEpisode: "ep-none" }), { virtualTs: "W1D1T9" }),
    ).toMatchObject({ ok: false, reason: "EVIDENCE_NOT_FOUND" });
    expect(
      svc.applyUpdate("ag-stu", proposal("kn:h", "understood", "explained", { evidenceEpisode: "ep-1" }), { virtualTs: "W1D1T9" }),
    ).toMatchObject({ ok: false, reason: "EVIDENCE_NOT_OWNED" });
  });

  it("taught_by 归因：未知 person 回退 self，已知 person 保留", () => {
    const { db, svc } = setup(["ag-teacher-01"]);
    svc.applyUpdate("ag-stu", proposal("kn:i", "heard", "mentioned"), { virtualTs: "W1D1T8" });
    svc.applyUpdate("ag-stu", proposal("kn:i", "understood", "explained", { taughtBy: "person:ag-stranger" }), { virtualTs: "W1D1T9" });
    let row = db.prepare("SELECT taught_by FROM knowledge_items WHERE owner_agent = 'ag-stu'").get() as { taught_by: string };
    expect(row.taught_by).toBe("self");

    svc.applyUpdate("ag-stu", proposal("kn:i", "applied", "solved", { taughtBy: "person:ag-teacher-01" }), { virtualTs: "W1D2T8" });
    row = db.prepare("SELECT taught_by FROM knowledge_items WHERE owner_agent = 'ag-stu'").get() as { taught_by: string };
    expect(row.taught_by).toBe("person:ag-teacher-01");
  });

  it("seedFromTemplate 幂等种入（heard + template_seed）", () => {
    const { db, svc } = setup();
    const items = [
      { topic: "kn:weak-1", claim: "想不明白量子叠加" },
      { topic: "kn:weak-2", claim: "distinction of derivatives" },
    ];
    expect(svc.seedFromTemplate("ag-stu", items)).toBe(2);
    expect(svc.seedFromTemplate("ag-stu", items)).toBe(0); // 幂等
    const rows = db.prepare("SELECT topic, mastery, source_kind FROM knowledge_items WHERE owner_agent = 'ag-stu' ORDER BY topic").all() as Array<{ topic: string; mastery: string; source_kind: string }>;
    expect(rows.map((r) => r.mastery)).toEqual(["heard", "heard"]);
    expect(rows.every((r) => r.source_kind === "template_seed")).toBe(true);
  });
});

describe("P5 知识衰减（§17.5.1）", () => {
  it("长期未用跌破阈值 → fading → forgotten，各留一条 decay 事件", () => {
    const { db, svc } = setup();
    svc.seedFromTemplate("ag-stu", [{ topic: "kn:dim", claim: "x" }]);
    // 模拟很久以前练过：把 practice 起点拨回 0，再推高虚拟小时差。
    db.prepare("UPDATE knowledge_items SET mastery = 'understood', last_practiced_vhours = 0 WHERE owner_agent = 'ag-stu'").run();

    // τ0=100，masteryFactor(understood)=1，use_count=0 ⇒ τ=100。dt=150 → retention≈0.22 ∈ (0.10, 0.35)。
    const res1 = svc.decay("ag-stu", 150, 100);
    expect(res1.newlyFading).toHaveLength(1);
    expect(res1.newlyForgotten).toHaveLength(0);

    let row = db.prepare("SELECT mastery, retention FROM knowledge_items WHERE owner_agent = 'ag-stu'").get() as { mastery: string; retention: number };
    expect(row.mastery).toBe("fading");
    expect(row.retention).toBeLessThan(0.35);
    expect(row.retention).toBeGreaterThan(0.10);

    // dt=300 → retention≈0.05 < 0.10，fading → forgotten。
    const res2 = svc.decay("ag-stu", 300, 100);
    expect(res2.newlyFading).toHaveLength(0);
    expect(res2.newlyForgotten).toHaveLength(1);

    row = db.prepare("SELECT mastery, retention FROM knowledge_items WHERE owner_agent = 'ag-stu'").get() as { mastery: string; retention: number };
    expect(row.mastery).toBe("forgotten");

    const events = db.prepare("SELECT evidence_kind, from_mastery, to_mastery FROM knowledge_events WHERE owner_agent = 'ag-stu' ORDER BY virtual_hours").all() as Array<{ evidence_kind: string; from_mastery: string; to_mastery: string }>;
    expect(events.map((e) => `${e.from_mastery}->${e.to_mastery}`)).toEqual(["understood->fading", "fading->forgotten"]);
    expect(events.every((e) => e.evidence_kind === "decay")).toBe(true);
  });

  it("A32 同 now 重复衰减幂等：不会因二次扫描换小 factor 把 fading 再压到 forgotten", () => {
    const { db, svc } = setup();
    svc.seedFromTemplate("ag-stu", [{ topic: "kn:once", claim: "x" }]);
    db.prepare("UPDATE knowledge_items SET mastery = 'mastered', last_practiced_vhours = 0 WHERE owner_agent = 'ag-stu'").run();

    // mastered factor=4, use_count=0 ⇒ τ=400。dt=600 → retention=exp(-1.5)=0.223 ∈ (0.10,0.35)。
    const first = svc.decay("ag-stu", 600, 100);
    expect(first.newlyFading).toHaveLength(1);
    expect(first.newlyForgotten).toHaveLength(0);

    // 同一虚拟小时再扫一次：幂等跳过，不再用 fading 的 factor=1 重算（否则 retention≈0.0025 会 forgotten）。
    const again = svc.decay("ag-stu", 600, 100);
    expect(again.newlyFading).toHaveLength(0);
    expect(again.newlyForgotten).toHaveLength(0);

    const row = db.prepare("SELECT mastery, decay_from, last_decay_vhours FROM knowledge_items WHERE owner_agent = 'ag-stu'").get() as {
      mastery: string;
      decay_from: string | null;
      last_decay_vhours: number | null;
    };
    expect(row.mastery).toBe("fading");
    expect(row.decay_from).toBe("mastered");
    expect(row.last_decay_vhours).toBe(600);
  });

  it("A14 fading 恢复晋级封顶 = 衰减前状态，恢复后清空 decay_from", () => {
    const { db, svc } = setup();
    svc.seedFromTemplate("ag-stu", [{ topic: "kn:cap", claim: "x" }]);
    db.prepare("UPDATE knowledge_items SET mastery = 'applied', last_practiced_vhours = 0 WHERE owner_agent = 'ag-stu'").run();

    // applied factor=2 ⇒ τ=200。dt=400 → retention=exp(-2)=0.135 < 0.35 → fading，decay_from=applied。
    const d = svc.decay("ag-stu", 400, 100);
    expect(d.newlyFading).toHaveLength(1);
    expect(db.prepare("SELECT decay_from FROM knowledge_items WHERE owner_agent = 'ag-stu'").get()).toMatchObject({ decay_from: "applied" });

    // 自省提议一句 mentioned 直接 mastered：只能恢复到 applied，不能跳 mastered。
    const verdict = svc.applyUpdate("ag-stu", proposal("kn:cap", "mastered", "mentioned"), { virtualTs: "W2D1T8" });
    expect(verdict).toMatchObject({ ok: true, to: "applied" });

    const row = db.prepare("SELECT mastery, decay_from FROM knowledge_items WHERE owner_agent = 'ag-stu'").get() as { mastery: string; decay_from: string | null };
    expect(row).toMatchObject({ mastery: "applied", decay_from: null }); // 恢复后清空基线

    // 更保守的恢复（只回到 heard）原样放行。
    db.prepare("UPDATE knowledge_items SET mastery = 'fading', decay_from = 'applied' WHERE owner_agent = 'ag-stu'").run();
    const conservative = svc.applyUpdate("ag-stu", proposal("kn:cap", "heard", "mentioned"), { virtualTs: "W2D1T9" });
    expect(conservative).toMatchObject({ ok: true, to: "heard" });
  });

  it("T10 forgotten→heard 重新接触", () => {
    const { db, svc } = setup();
    svc.seedFromTemplate("ag-stu", [{ topic: "kn:reboot", claim: "x" }]);
    // 直接造一行 forgotten（衰减任务产物；服务端拒绝自省写 forgotten，仅此作测试入口）。
    db.prepare("UPDATE knowledge_items SET mastery = 'forgotten' WHERE owner_agent = 'ag-stu'").run();

    const renamed = svc.applyUpdate("ag-stu", proposal("kn:reboot", "heard", "mentioned"), { virtualTs: "W2D1T8" });
    expect(renamed).toMatchObject({ ok: true, from: "forgotten", to: "heard" });
  });
});

describe("P5 学习队列（§17.5.2）", () => {
  it("Q4 误区自动入队（high + 系统模糊动机）；Q1 掌握出队（误区除外）；Q3 封顶 7", () => {
    const { db, svc } = setup();

    // 两个误区，一个已 applied（A33：误区不因 applied 出队），一个 heard 留队。
    db.prepare(
      `INSERT INTO knowledge_items (kn_id, owner_agent, topic, claim, mastery, confidence, retention, practice_count, is_misconception, taught_by, source_kind, first_seen_at, updated_at)
       VALUES ('kn-a','ag-stu','kn:mis-a','x','applied',0.5,1,0,1,'self','inferred','2026-01-01','2026-01-01'),
              ('kn-b','ag-stu','kn:mis-b','y','heard',0.5,1,0,1,'self','inferred','2026-01-01','2026-01-01'),
              ('kn-c','ag-stu','kn:done','z','mastered',0.5,1,0,0,'self','inferred','2026-01-01','2026-01-01')`,
    ).run();

    // 模型还提议了几条 low：其中一条撞上已 applied 的误区（high 覆盖 low、且不出队），一条新题。
    const queue = svc.organizeLearningQueue("ag-stu", [
      { topic: "kn:mis-a", priority: "low", motivation: "想再练练" },
      { topic: "kn:extra", priority: "low", motivation: "竞赛要考" },
    ]);

    const topics = queue.map((q) => q.topic);
    expect(topics).toContain("kn:mis-b"); // Q4 自动入队（high）
    expect(topics).toContain("kn:mis-a"); // A33：仍是误区，applied 不出队
    expect(topics).not.toContain("kn:done"); // 本来就 mastered 且非误区
    const misA = queue.find((q) => q.topic === "kn:mis-a")!;
    expect(misA.priority).toBe("high"); // high 覆盖模型的 low
    const misB = queue.find((q) => q.topic === "kn:mis-b")!;
    expect(misB.priority).toBe("high");
    expect(misB.motivation).toBe("我好像哪里没搞对"); // 系统模糊语，不含 wrong_belief

    // Q3：灌满 8 条 low，封顶 7。
    const many = Array.from({ length: 8 }, (_, i) => ({ topic: `kn:z-${i}`, priority: "low" as const, motivation: "m" }));
    const capped = svc.organizeLearningQueue("ag-stu", many);
    expect(capped.length).toBe(7);
  });

  it("learningQueue 存/取：写入 reflections.output_json 后读回最新一条", () => {
    const { db, svc } = setup();
    const insert = (startedAt: string, json: unknown, status = "done"): void => {
      db.prepare(
        `INSERT INTO reflections (reflection_id, owner_agent, trigger, status, started_at, output_json)
         VALUES (?, 'ag-stu', 'manual', ?, ?, ?)`,
      ).run(`rf-${startedAt}`, status, startedAt, JSON.stringify(json));
    };
    insert("2026-01-01T00:00:00.000Z", { learningQueue: [{ topic: "kn:want", priority: "high", motivation: "上次被问住了" }] });
    insert("2026-01-02T00:00:00.000Z", { learningQueue: [{ topic: "kn:newer", priority: "low", motivation: "想搞懂" }] });

    const q = svc.learningQueue("ag-stu");
    expect(q).toEqual([{ topic: "kn:newer", priority: "low", motivation: "想搞懂" }]); // 最新一条
  });

  it("A34 模型省略 learningQueue 时继承上轮队列，非误区待办不消失", () => {
    const { db, svc } = setup();
    db.prepare(
      `INSERT INTO reflections (reflection_id, owner_agent, trigger, status, started_at, output_json)
       VALUES ('rf-prev', 'ag-stu', 'manual', 'done', '2026-01-01T00:00:00.000Z', ?)`,
    ).run(JSON.stringify({ learningQueue: [{ topic: "kn:pending", priority: "low", motivation: "上次被问住了" }] }));

    // 本轮模型省略 learningQueue（传空数组）：继承上轮的 kn:pending。
    const q = svc.organizeLearningQueue("ag-stu", []);
    expect(q).toContainEqual({ topic: "kn:pending", priority: "low", motivation: "上次被问住了" });
  });

  it("A35 lastLearningQueue 只看 done 反射，failed 的 {error} 不被误当最新队列", () => {
    const { db, svc } = setup();
    db.prepare(
      `INSERT INTO reflections (reflection_id, owner_agent, trigger, status, started_at, output_json)
       VALUES ('rf-failed', 'ag-stu', 'manual', 'failed', '2026-01-03T00:00:00.000Z', ?),
              ('rf-done', 'ag-stu', 'manual', 'done', '2026-01-02T00:00:00.000Z', ?)`,
    ).run(JSON.stringify({ error: "模型超时" }), JSON.stringify({ learningQueue: [{ topic: "kn:want", priority: "high", motivation: "上次被问住了" }] }));

    const q = svc.learningQueue("ag-stu");
    expect(q).toEqual([{ topic: "kn:want", priority: "high", motivation: "上次被问住了" }]);
  });
});