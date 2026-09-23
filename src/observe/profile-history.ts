// ═══════════════════════════════════════════════════════════════════════════
// 印象演化曲线 builder（§20.3.2）
//
// 单库查询：从 DB-A 的 state_writes 还原某个 subject 的评价轨迹。
// 全部数据来自本环侧，无需回查 mesh。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import type { ImpressionEvolution, ImpressionJump, ImpressionPoint } from "./types.js";

/** 跳变检测的默认幅度阈值（§20.3.2：需真实语料定标，先取经验值）。 */
const JUMP_VALENCE_THRESHOLD = 0.4;

interface StateWriteRow {
  write_id: string;
  real_ts: string;
  actor: string;
  reflection_id: string | null;
  valence: number | null;
  closeness: number | null;
  impression: string | null;
  scene_id: string | null;
  before_json: string | null;
}

/**
 * 从 state_writes 构建某个 subject 的印象演化曲线。
 *
 * @param db DB-A 连接句柄
 * @param ownerAgent 角色 agentId
 * @param subjectType §16.1 的六值主体空间
 * @param subjectId 被评价对象 id
 */
export function buildImpressionEvolution(
  db: Database.Database,
  ownerAgent: string,
  subjectType: string,
  subjectId: string,
): ImpressionEvolution {
  // ── 当前快照 ──
  const current = db
    .prepare<[string, string, string], {
      impression: string | null;
      valence: number | null;
      closeness: number | null;
      trust: number | null;
      updated_at: string;
    }>(
      `SELECT impression, valence, closeness, trust, updated_at
         FROM subject_profiles
        WHERE owner_agent = ? AND subject_type = ? AND subject_id = ?`,
    )
    .get(ownerAgent, subjectType, subjectId);

  // ── 演化轨迹（§20.3.2 伴随查询）──
  const targetId = `${subjectType}:${subjectId}`;
  const rows = db
    .prepare<{ self: string; target: string; targetId: string }, StateWriteRow>(
      `SELECT w.write_id, w.real_ts, w.actor, w.reflection_id,
              json_extract(w.after_json, '$.valence')    AS valence,
              json_extract(w.after_json, '$.closeness')  AS closeness,
              json_extract(w.after_json, '$.impression') AS impression,
              json_extract(w.before_json, '$.scene_id')  AS scene_id,
              w.before_json
         FROM state_writes w
        WHERE w.owner_agent = :self
          AND w.target      = :target
          AND w.target_id   = :targetId
        ORDER BY w.real_ts`,
    )
    .all({ self: ownerAgent, target: "subject_profile", targetId });

  // ── 解析 evidenceEpisodeIds ──
  function extractEpisodeIds(beforeJson: string | null): string[] {
    if (!beforeJson) return [];
    try {
      const obj = JSON.parse(beforeJson);
      const evidence = obj.evidence_json;
      if (typeof evidence === "string") {
        const parsed = JSON.parse(evidence);
        if (Array.isArray(parsed)) {
          return parsed
            .map((e: { episode_id?: string }) => e.episode_id)
            .filter((id: unknown): id is string => typeof id === "string");
        }
      } else if (Array.isArray(evidence)) {
        return evidence
          .map((e: { episode_id?: string }) => e.episode_id)
          .filter((id: unknown): id is string => typeof id === "string");
      }
    } catch {
      // evidence 不可解析时返回空
    }
    return [];
  }

  const points: ImpressionPoint[] = rows.map((r) => ({
    realTs: r.real_ts,
    writeId: r.write_id,
    valence: r.valence,
    closeness: r.closeness,
    impression: r.impression,
    actor: r.actor,
    reflectionId: r.reflection_id,
    sceneId: r.scene_id,
    evidenceEpisodeIds: extractEpisodeIds(r.before_json),
  }));

  // ── 跳变检测 ──
  const jumps = detectJumps(points, JUMP_VALENCE_THRESHOLD);

  return {
    ownerAgent,
    subjectType,
    subjectId,
    current: {
      impression: current?.impression ?? null,
      valence: current?.valence ?? null,
      closeness: current?.closeness ?? null,
      trust: current?.trust ?? null,
      updatedAt: current?.updated_at ?? "",
    },
    points,
    jumps,
  };
}

/**
 * 邻近比较检测跳变：相邻两点的 |valence delta| 超过阈值标记为 jump。
 * verdict 只在跳变幅度大 AND evidenceEpisodeIds 为空时才判 "unexplained"。
 */
function detectJumps(points: ImpressionPoint[], threshold: number): ImpressionJump[] {
  const jumps: ImpressionJump[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (prev.valence == null || cur.valence == null) continue;
    const delta = cur.valence - prev.valence;
    if (Math.abs(delta) < threshold) continue;
    jumps.push({
      fromTs: prev.realTs,
      toTs: cur.realTs,
      valenceDelta: delta,
      hasEvidence: cur.evidenceEpisodeIds.length > 0,
      reflectionId: cur.reflectionId,
      verdict: cur.evidenceEpisodeIds.length > 0 ? "explained" : "unexplained",
    });
  }
  return jumps;
}