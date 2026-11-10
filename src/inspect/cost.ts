// ═══════════════════════════════════════════════════════════════════════════
// 自省成本两段拼接排除（§20.2.4 / §13.6）—— 观测出口的第二/三段
//
// 「角色之间对话」的成本必须把自省流（每个 Agent 的 :reflect Account）排除掉，否则
// 唤醒数虚高、静默率虚低。唯一正确的做法（§20.2.2 结论）：放弃计数器，从 mesh 的
// 投递/消息行重算分子分母，再在本环侧按 agents 表过滤。三段：
//   · 段一（mesh 侧只读分组）：经 src/mesh/cost-lookup 触达（R2：mesh SQL 只在 mesh/**）。
//   · 段二（本环 agents 表）：唯一权威——mesh_reflect_account_id / mesh_account_id。
//   · 段三（应用层）：先过滤再求和（E1），绝不求和后相减。
//
// 本文件不 import @pi/agent-mesh，也不含 mesh_ 表名 SQL（R1/R2）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import { meshCostGroups } from "../mesh/cost-lookup.js";
import { evaluatePairing } from "../runtime/pairing.js";

/** 排除自省流后的角色成本指标（§20.2.4 roleMetricsExcludingReflect 的返回值）。 */
export interface RoleCostMetrics {
  window: { since: string; until: string };
  /** 排除自省后的投递总数（对话口径）。 */
  deliveriesTotal: number;
  /** 排除自省后的消息总数（对话口径）。 */
  messagesTotal: number;
  /** 唤醒 / 消息（唤醒率）。 */
  wakePerMessage: number | null;
  /** 静默投递占比。 */
  silentRate: number | null;
  /** P1 原文投递占比（verbatim 下界，§20.2.4 注）。 */
  p1RatePerDelivery: number | null;
  /** 被排除的自省流投递行数（对话口径之外，供核对「两栏之和等于全量」）。 */
  excludedReflectDeliveries: number;
  /** 被排除的自省流消息行数。 */
  excludedReflectMessages: number;
  /** 既非自省流也非已知角色的 accountId（@system、设施、外部端点），必须显式暴露（E4）。 */
  unattributedAccounts: string[];
  /** 口径边界（E5：近似量 + 保留期观 + 未接线的实例校验），跟着数字一起返回。 */
  caveats: string[];
}

const DEFAULT_SINCE = "1970-01-01T00:00:00.000Z";
const DEFAULT_UNTIL = "9999-12-31T23:59:59.000Z";

/**
 * 两段拼接排除（§20.2.4）。`roleDb` 是 DB-A 连接，`meshDbPath` 是 DB-B 路径。
 * E3（mesh_instance_tag 校验，R33）：取数前先 `evaluatePairing` 核对双库配对——错库 /
 * 缺锚点整体抛 PairingError 拒绝出数；无已注册映射（vacant）时安全零值，不把「换了
 * mesh」按单库假设混过去。
 */
export function costMetricsExcludingReflect(
  roleDb: Database.Database,
  meshDbPath: string,
  opts: { since?: string; until?: string; agentIds?: string[] } = {},
): RoleCostMetrics {
  const since = opts.since ?? DEFAULT_SINCE;
  const until = opts.until ?? DEFAULT_UNTIL;
  const caveats: string[] = [
    "verbatim_copies 计在 Renderer 出口（P1/P2/steer 三来源），SQL 只能给 P1 来源的下界",
    "唤醒的闲/忙分支无法由 mesh_deliveries 区分（woke 是布尔）",
    "仅在 mesh 保留期窗口内有效",
  ];

  // B2 降级 → R33 收紧：无已注册映射（vacant）时才安全零值（mesh 缺失或首次启动）。
  // 有映射但缺锚点/错库由 evaluatePairing 抛 PairingError，整体拒绝（E3）。
  const pairing = evaluatePairing(roleDb, meshDbPath);
  if (pairing.state === "vacant") {
    return {
      window: { since, until },
      deliveriesTotal: 0,
      messagesTotal: 0,
      wakePerMessage: null,
      silentRate: null,
      p1RatePerDelivery: null,
      excludedReflectDeliveries: 0,
      excludedReflectMessages: 0,
      unattributedAccounts: [],
      caveats,
    };
  }

  // ── 段一（mesh DB-B）：原始分组量。必须先取（§20.2.5 方向安全性）。──
  const groups = meshCostGroups(meshDbPath, since, until);

  // ── 段二（DB-A）：自省流 accountId 全集 + 主 accountId 集合（唯一权威，不解析命名后缀 E2）。
  //    §20.2.5 规定段二必须**后取**：若两段之间新注册了 Agent，后取只会「多知道一个映射」
  //    （不会漏排除）；反序（段二先取）则可能漏排除新注册 Agent 的自省流量。──
  const reflect = new Set(
    roleDb
      .prepare<[], { account_id: string }>(
        `SELECT mesh_reflect_account_id AS account_id FROM agents WHERE mesh_reflect_account_id IS NOT NULL`,
      )
      .all()
      .map((r) => r.account_id),
  );
  const primary = new Set(
    roleDb
      .prepare<[], { account_id: string }>(
        `SELECT mesh_account_id AS account_id FROM agents WHERE mesh_account_id IS NOT NULL`,
      )
      .all()
      .map((r) => r.account_id),
  );

  // A36：agentIds 作用域时，把段三的分子分母收紧到这些 Agent 的主/自省账号；
  // 作用域外账号的投递/消息整行跳过（不是求和后相减）。这是 scope.agentIds 的权威落点。
  const scopeIds = opts.agentIds?.length ? opts.agentIds : undefined;
  const scopePrimary = scopeIds
    ? new Set(
        roleDb
          .prepare<unknown[], { account_id: string }>(
            `SELECT mesh_account_id AS account_id FROM agents WHERE mesh_account_id IS NOT NULL AND agent_id IN (${scopeIds.map(() => "?").join(",")})`,
          )
          .all(...scopeIds)
          .map((r) => r.account_id),
      )
    : undefined;
  const scopeReflect = scopeIds
    ? new Set(
        roleDb
          .prepare<unknown[], { account_id: string }>(
            `SELECT mesh_reflect_account_id AS account_id FROM agents WHERE mesh_reflect_account_id IS NOT NULL AND agent_id IN (${scopeIds.map(() => "?").join(",")})`,
          )
          .all(...scopeIds)
          .map((r) => r.account_id),
      )
    : undefined;

  // ── 段三：先过滤再求和（E1）。──
  const unattributed = new Set<string>();
  let deliveriesTotal = 0;
  let silentGrade = 0;
  let wakesTotal = 0;
  let p1 = 0;
  let excludedReflectDeliveries = 0;
  for (const g of groups.deliveries) {
    if (scopePrimary) {
      if (scopeReflect!.has(g.accountId)) {
        excludedReflectDeliveries += g.deliveriesTotal;
        continue;
      }
      if (!scopePrimary.has(g.accountId)) continue; // 作用域外
    } else if (reflect.has(g.accountId)) {
      excludedReflectDeliveries += g.deliveriesTotal;
      continue;
    }
    if (!primary.has(g.accountId)) unattributed.add(g.accountId);
    deliveriesTotal += g.deliveriesTotal;
    silentGrade += g.silentGrade;
    wakesTotal += g.wakesTotal;
    p1 += g.p1Deliveries;
  }

  let messagesTotal = 0;
  let excludedReflectMessages = 0;
  for (const m of groups.messages) {
    if (scopePrimary) {
      if (scopeReflect!.has(m.accountId)) {
        excludedReflectMessages += m.messagesTotal;
        continue;
      }
      if (!scopePrimary.has(m.accountId)) continue; // 作用域外
    } else if (reflect.has(m.accountId)) {
      excludedReflectMessages += m.messagesTotal;
      continue;
    }
    if (!primary.has(m.accountId)) unattributed.add(m.accountId);
    messagesTotal += m.messagesTotal;
  }

  return {
    window: { since, until },
    deliveriesTotal,
    messagesTotal,
    wakePerMessage: messagesTotal > 0 ? wakesTotal / messagesTotal : null,
    silentRate: deliveriesTotal > 0 ? silentGrade / deliveriesTotal : null,
    p1RatePerDelivery: deliveriesTotal > 0 ? p1 / deliveriesTotal : null,
    excludedReflectDeliveries,
    excludedReflectMessages,
    unattributedAccounts: [...unattributed].sort(),
    caveats,
  };
}