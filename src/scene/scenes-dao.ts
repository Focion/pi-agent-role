// ═══════════════════════════════════════════════════════════════════════════
// scenes 表 DAO（§18.3）——场景行的唯一持久化通道
//
// 本环场景边界：一行 scenes = 一个 group 会话 + 虚拟时间 + 轮次 + 预算。会话成员/caps
// 的权威在 mesh 成员表；scenes 只冗余 participants_json 快照（§18.3.1 末）。
//
// 分层纪律（§22.4）：不 import `@pi/agent-mesh`、不写 mesh_ 表、不写领域层 dot 字面量。
// 类型经 ../mesh/*.js 的 type 再出口，值（MeshHost/Observer）由 runtime 注入。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import { ValidationError } from "../runtime/errors.js";
import type { NewSceneInput, SceneInjection, SceneParticipant, SceneRow, SceneStatus, SceneStore } from "./types.js";

/** scenes 表物理行（snake_case，与 001_init.sql 逐列对应）。 */
interface SceneDbRow {
  scene_id: string;
  name: string | null;
  facility_id: string | null;
  facility_json: string | null;
  conversation_id: string | null;
  host_account_id: string | null;
  floor_mode: string | null;
  conv_bound_at: string | null;
  virtual_start: string | null;
  virtual_now: string | null;
  participants_json: string;
  turn_policy: string | null;
  turn_count: number;
  token_budget: number | null;
  token_spent: number;
  status: string;
  created_at: string;
  ended_at: string | null;
}

/** 新建场景的结构化入参；participants 在本层序列化。 */
export type { NewSceneInput } from "./types.js";

const SELECT_COLS = `scene_id, name, facility_id, facility_json, conversation_id, host_account_id, floor_mode,
  conv_bound_at, virtual_start, virtual_now, participants_json, turn_policy, turn_count,
  token_budget, token_spent, status, created_at, ended_at`;

function mapRow(r: SceneDbRow): SceneRow {
  return {
    sceneId: r.scene_id,
    name: r.name,
    facilityId: r.facility_id,
    facilityJson: r.facility_json,
    conversationId: r.conversation_id,
    hostAccountId: r.host_account_id,
    floorMode: r.floor_mode,
    convBoundAt: r.conv_bound_at,
    virtualStart: r.virtual_start,
    virtualNow: r.virtual_now,
    participantsJson: r.participants_json,
    turnPolicy: r.turn_policy,
    turnCount: r.turn_count,
    tokenBudget: r.token_budget,
    tokenSpent: r.token_spent,
    status: r.status as SceneStatus,
    createdAt: r.created_at,
    endedAt: r.ended_at,
  };
}

/** participants_json → 结构化参与者列表（非法 JSON 视为数据缺陷抛校验错）。 */
export function decodeParticipants(json: string): SceneParticipant[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) throw new Error("not an array");
    return arr as SceneParticipant[];
  } catch (err) {
    throw new ValidationError(`corrupt scenes.participants_json: ${(err as Error).message}`);
  }
}

export class ScenesDao implements SceneStore {
  private readonly db: Database.Database;
  private readonly stmtGet: Database.Statement;
  private readonly stmtGetByConv: Database.Statement;
  private readonly stmtInsert: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.stmtGet = db.prepare(`SELECT ${SELECT_COLS} FROM scenes WHERE scene_id = ?`);
    this.stmtGetByConv = db.prepare(
      `SELECT ${SELECT_COLS} FROM scenes WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`,
    );
    this.stmtInsert = db.prepare(
      `INSERT INTO scenes
         (scene_id, name, facility_id, facility_json, conversation_id, host_account_id, floor_mode, conv_bound_at,
          virtual_start, virtual_now, participants_json, turn_policy, turn_count,
          token_budget, token_spent, status, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 'active', ?, NULL)`,
    );
  }

  /** 建档；sceneId 冲突抛校验错（§7.1 幂等由编曲器先 get 判断）。 */
  insert(inp: NewSceneInput): void {
    const existing = this.get(inp.sceneId);
    if (existing) throw new ValidationError(`scene already exists: ${inp.sceneId}`);
    const participantsJson = JSON.stringify(inp.participants);
    this.stmtInsert.run(
      inp.sceneId,
      inp.name,
      inp.facilityId,
      inp.facilityJson,
      inp.conversationId,
      inp.hostAccountId ?? null,
      inp.floorMode,
      inp.convBoundAt,
      inp.virtualStart,
      inp.virtualNow,
      participantsJson,
      inp.turnPolicy,
      inp.tokenBudget,
      inp.createdAt,
    );
  }

  get(sceneId: string): SceneRow | undefined {
    const r = this.stmtGet.get(sceneId) as SceneDbRow | undefined;
    return r ? mapRow(r) : undefined;
  }

  /** 反查：conversationId → 最新场景行（§7.2 策略槽经它定位当前场景）。 */
  getByConversation(conversationId: string): SceneRow | undefined {
    const r = this.stmtGetByConv.get(conversationId) as SceneDbRow | undefined;
    return r ? mapRow(r) : undefined;
  }

  /** 推进一轮：写 virtual_now + turn_count + token_spent（单语句原子递增）。 */
  advance(sceneId: string, virtualNow: string, deltaTokens: number): { turnCount: number; tokenSpent: number; changed: boolean } {
    // A08：条件推进——只在 status 仍为 active 时更新。并发 close 已标 ended 时 0 行生效，
    // 编曲器据此停在轮次边界而不发「已关闭场景」后的推进写。
    const info = this.db
      .prepare(
        `UPDATE scenes SET virtual_now = ?, turn_count = turn_count + 1,
                            token_spent = token_spent + ? WHERE scene_id = ? AND status = 'active'`,
      )
      .run(virtualNow, deltaTokens, sceneId);
    const r = this.db
      .prepare(`SELECT turn_count, token_spent FROM scenes WHERE scene_id = ?`)
      .get(sceneId) as { turn_count: number; token_spent: number } | undefined;
    return r
      ? { turnCount: r.turn_count, tokenSpent: r.token_spent, changed: info.changes > 0 }
      : { turnCount: 0, tokenSpent: 0, changed: false };
  }

  /** 结束/中止：写 status + ended_at。 */
  end(sceneId: string, status: Extract<SceneStatus, "ended" | "aborted">, endedAt: string): void {
    this.db.prepare(`UPDATE scenes SET status = ?, ended_at = ? WHERE scene_id = ?`).run(status, endedAt, sceneId);
  }

  /** 暂停：active→paused（条件写，已非 active 则 0 行生效）。 */
  pause(sceneId: string): boolean {
    const info = this.db.prepare(`UPDATE scenes SET status = 'paused' WHERE scene_id = ? AND status = 'active'`).run(sceneId);
    return info.changes > 0;
  }

  /** 恢复：paused→active（条件写，非 paused 则 0 行生效）。 */
  unpause(sceneId: string): boolean {
    const info = this.db.prepare(`UPDATE scenes SET status = 'active' WHERE scene_id = ? AND status = 'paused'`).run(sceneId);
    return info.changes > 0;
  }

  /** 记一笔场景注入（injectId 幂等键；冲突时按数据库唯一约束抛出，由编曲器先查后插）。 */
  recordInjection(inj: SceneInjection): void {
    this.db
      .prepare(
        `INSERT INTO scene_injections (inject_id, scene_id, conversation_id, message_id, from_account, msg_class, text, virtual_ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(inj.injectId, inj.sceneId, inj.conversationId, inj.messageId, inj.fromAccount, inj.msgClass, inj.text, inj.virtualTs, inj.createdAt);
  }

  /** 按幂等键回读注入。 */
  getInjection(injectId: string): SceneInjection | undefined {
    const r = this.db
      .prepare(`SELECT inject_id, scene_id, conversation_id, message_id, from_account, msg_class, text, virtual_ts, created_at FROM scene_injections WHERE inject_id = ?`)
      .get(injectId) as
      | { inject_id: string; scene_id: string; conversation_id: string; message_id: string; from_account: string; msg_class: string; text: string; virtual_ts: string | null; created_at: string }
      | undefined;
    return r
      ? {
          injectId: r.inject_id,
          sceneId: r.scene_id,
          conversationId: r.conversation_id,
          messageId: r.message_id,
          fromAccount: r.from_account,
          msgClass: r.msg_class,
          text: r.text,
          virtualTs: r.virtual_ts,
          createdAt: r.created_at,
        }
      : undefined;
  }

  /** 活跃场景列表（resume 后自检 / 巡检用）。 */
  listActive(): SceneRow[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM scenes WHERE status = 'active' ORDER BY created_at`)
      .all() as unknown as SceneDbRow[];
    return rows.map(mapRow);
  }
}