// ═══════════════════════════════════════════════════════════════════════════
// DayEndService（R16 / Q02）—— 场景收场触发的一次「日终」编排
//
// 把散落在记忆/自省/知识三个服务里的收尾原语，按 §15.5 的固定顺序串成一次幂等日终：
//   ① 记忆衰减（decaySweep）→ ② 自省/知识迁移（scene_end 触发）→ ③ 知识衰减（decay）
//     → ④ 学习队列整理（organizeLearningQueue）。
//
// 幂等判据（Q02「同角色同虚拟日去重」「恢复不重复日终」）：agent_state 里写入
//   key = `day_end:<virtualDay>`（value_json 记 depth / 降级留痕 / 完成时刻）。
//   同一个 owner 在同一虚拟日重复触发直接返回 alreadyDone，不重跑衰减、不重复给模型发 cue。
// 该 key 的唯一写者只本服务（S05「每个键指定唯一写入服务」），前置由调用方（scene close）
//   串行推进，不引入第二把并发锁。
//
// 分层纪律：本文件属 src/reflect/**，不 import @pi/agent-mesh、不写 mesh_ 表、不出现
//   ext 字段；mesh 类型经 public-types、值经注入。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import { defaultMemoryPolicy, type MemoryPolicy } from "../compile/types.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { RoleAccountRegistry } from "../mesh/accounts.js";
import type { MemoryDao } from "../memory/dao.js";
import { virtualDayOf, virtualHoursOf } from "../runtime/virtual-clock.js";
import type { ReflectionDepth, ReflectionRunResult } from "./types.js";
import { ReflectionService } from "./service.js";

/** agent_state 里日终台账 key 前缀（`day_end:<virtualDay>`）。 */
const DAY_END_KEY_PREFIX = "day_end:";

/** 一次日终针对单个角色的结果。 */
export interface DayEndAgentResult {
  agentId: string;
  /** 自省三档（复读 RunResult.depth）：skip 通常是「已日终过」或「非角色」。 */
  depth: ReflectionDepth;
  /** 记忆衰减扫到的 active 情节数。 */
  memoryDecayed: number;
  /** 知识衰减扫到的非 forgotten 条目数。 */
  knowledgeDecayed: number;
  /** 队列整理后的条数（§17.5.2 上限 7）。 */
  queueConsolidated: number;
  /** 降级留痕（reflect 发送失败 / 无 policy 等），空数组 = 无降级。 */
  degraded: string[];
  /** true = 本虚拟日已日终过，本轮为幂等空操作（恢复不重复日终）。 */
  alreadyDone: boolean;
}

/** 一次场景收场的日终汇总。 */
export interface DayEndResult {
  sceneId: string | null;
  virtualTs: string;
  virtualDay: number;
  ran: DayEndAgentResult[];
}

export interface DayEndServiceDeps {
  db: Database.Database;
  memoryDao: MemoryDao;
  knowledge: KnowledgeService;
  reflection: ReflectionService;
  registry: RoleAccountRegistry;
  policyOf: (accountId: string) => Promise<MemoryPolicy | undefined>;
}

export class DayEndService {
  private readonly db: Database.Database;
  private readonly memoryDao: MemoryDao;
  private readonly knowledge: KnowledgeService;
  private readonly reflection: ReflectionService;
  private readonly registry: RoleAccountRegistry;
  private readonly policyOf: (accountId: string) => Promise<MemoryPolicy | undefined>;

  constructor(deps: DayEndServiceDeps) {
    this.db = deps.db;
    this.memoryDao = deps.memoryDao;
    this.knowledge = deps.knowledge;
    this.reflection = deps.reflection;
    this.registry = deps.registry;
    this.policyOf = deps.policyOf;
  }

  /** 只读判断：某 owner 在指定虚拟时刻的虚拟日是否已完成日终（R30 devMode 关场校验也用它）。 */
  hasRun(owner: string, virtualTs: string): boolean {
    return this.readLedger(owner, virtualDayOf(virtualTs)) !== undefined;
  }

  /** 对一组 role agent 逐个跑一次日终（幂等）。非 role agent 直接跳过。 */
  async runForScene(opts: {
    sceneId: string;
    agentIds: string[];
    virtualTs: string;
  }): Promise<DayEndResult> {
    const virtualDay = virtualDayOf(opts.virtualTs);
    const ran: DayEndAgentResult[] = [];
    for (const agentId of opts.agentIds) {
      ran.push(await this.runOne(agentId, opts.sceneId, opts.virtualTs));
    }
    return { sceneId: opts.sceneId, virtualTs: opts.virtualTs, virtualDay, ran };
  }

  private async runOne(agentId: string, sceneId: string, virtualTs: string): Promise<DayEndAgentResult> {
    const rec = this.registry.byAgentId(agentId);
    if (!rec || rec.agentType !== "role") {
      return {
        agentId,
        depth: "skip",
        memoryDecayed: 0,
        knowledgeDecayed: 0,
        queueConsolidated: 0,
        degraded: ["not a role agent"],
        alreadyDone: false,
      };
    }

    const virtualDay = virtualDayOf(virtualTs);
    if (this.readLedger(agentId, virtualDay) !== undefined) {
      return {
        agentId,
        depth: "skip",
        memoryDecayed: 0,
        knowledgeDecayed: 0,
        queueConsolidated: 0,
        degraded: [],
        alreadyDone: true,
      };
    }

    const virtualHours = virtualHoursOf(virtualTs);
    const policy = (await this.policyOf(rec.accountId)) ?? defaultMemoryPolicy();
    const degraded: string[] = [];

    // ① 记忆衰减。
    const sweep = this.memoryDao.decaySweep(agentId, virtualHours, policy);
    // ② 自省/知识迁移（scene_end 档：有情节 full，否则 light 只衰减收尾）。
    let reflectionResult: ReflectionRunResult;
    try {
      reflectionResult = await this.reflection.run(agentId, {
        trigger: "scene_end",
        sceneId,
        virtualTs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reflectionResult = { agentId, trigger: "scene_end", depth: "light", sent: false, skipped: `day-end reflection failed: ${msg}` };
      degraded.push(`reflection failed: ${msg}`);
    }
    // ②.5 pending_taught 回补（§17.2 Q05）：必须**先于** ③ 知识衰减——刚被确认「讲对了」
    // 而升到 mastered 的条目不因同次日终按旧 mastery 衰减（S5 状态迁移先于衰减）。
    const taughtBackfilled = this.knowledge.backfillPendingTaught(agentId, { virtualTs, virtualHours });
    // ③ 知识衰减。
    const kd = this.knowledge.decay(agentId, virtualHours, policy.tau0Hours);
    // ④ 学习队列整理（无新模型意图，继承 + 出队已掌握项 + 封顶 7；Q2 三日降档在日终执行）。
    const queue = this.knowledge.organizeLearningQueue(agentId, [], { virtualHours });

    if (!reflectionResult.sent && reflectionResult.depth === "full") {
      degraded.push(reflectionResult.skipped ?? "reflection cue not sent");
    }

    this.writeLedger(agentId, virtualDay, {
      depth: reflectionResult.depth,
      sceneId,
      virtualTs,
      memoryDecayed: sweep.scanned,
      knowledgeDecayed: kd.scanned,
      taughtBackfilled,
      queueConsolidated: queue.length,
      degraded,
      finishedAt: new Date().toISOString(),
    });

    return {
      agentId,
      depth: reflectionResult.depth,
      memoryDecayed: sweep.scanned,
      knowledgeDecayed: kd.scanned,
      queueConsolidated: queue.length,
      degraded,
      alreadyDone: false,
    };
  }

  // ─── 台账读写（agent_state，唯一写者 = 本服务）────────────────────────────

  private readLedger(owner: string, virtualDay: number): unknown | undefined {
    const row = this.db
      .prepare<[string, string], { value_json: string }>(
        `SELECT value_json FROM agent_state WHERE agent_id = ? AND key = ?`,
      )
      .get(owner, DAY_END_KEY_PREFIX + String(virtualDay));
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return undefined;
    }
  }

  private writeLedger(owner: string, virtualDay: number, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO agent_state (agent_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(owner, DAY_END_KEY_PREFIX + String(virtualDay), JSON.stringify(value), new Date().toISOString());
  }
}