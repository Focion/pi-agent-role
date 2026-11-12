// ═══════════════════════════════════════════════════════════════════════════
// observe scenario —— ReflectApi / InspectApi / ReplayApi 观测·自省·回放全景走查
//
// 流程：注册两枚 MBTI 画像 → 建/跑/关一场小场景（round_robin 两轮）→ 触发自省 →
// 巡检（不变量 / mesh 一致性 / 悬挂扫描 / 成本 / 时间线 / 印象 / 成本视图）→
// 记录回放 + 隔离重执行 + 结构化比较。
//
// 无 LLM（ctx.fake）时：fake streamPort 仍会产生 system cue 史 + 轮次判定（memory_decisions）
// 与检索快照；reflect/replay 走完整 DAO 路径。真实成本/用量为 0。
//
// 分层纪律：只 import 公开的 `@pi/agent-role`；相对导入带 .ts 后缀；双空格缩进、双引号。
// ═══════════════════════════════════════════════════════════════════════════

import type {
  CostView,
  DomainDecisionReplay,
  ImpressionEvolution,
  MemoryTimeline,
  ReflectSnapshot,
  ReflectionRunResult,
  ReplayCompareResult,
  RoleCostMetrics,
  Runtime,
} from "@pi/agent-role";

import { openRuntime, registerPersonas } from "../harness.ts";
import { parseFlags, type Scenario, type ScenarioContext } from "../context.ts";

/** 步骤横幅的圈数码（①…）。 */
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮"];

function banner(n: number, title: string): void {
  console.log(`\n── ${CIRCLED[n - 1] ?? n} ${title} ──`);
}

/** 单步包装：打横幅、try/catch 后继续（步骤失败不中断整场走查）。 */
async function step(n: number, title: string, fn: () => void | Promise<void>): Promise<void> {
  banner(n, title);
  try {
    await fn();
  } catch (err) {
    console.log(`✗ ${title} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 可读地截断一个值（长文本只留前缀）。 */
function short(v: unknown, n = 96): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function p(label: string, value: unknown): void {
  console.log(`  ${label}: ${short(value, 120)}`);
}

/** ReflectionRunResult 的一行摘要。 */
function runSummary(r: ReflectionRunResult): string {
  return [
    `agentId=${r.agentId}`,
    `trigger=${r.trigger}`,
    `depth=${r.depth}`,
    `sent=${r.sent}`,
    r.reflectionId ? `reflectionId=${r.reflectionId}` : "",
    r.decayed !== undefined ? `decayed=${r.decayed}` : "",
    r.settled !== undefined ? `settled=${r.settled}` : "",
    r.skipped ? `skipped=${r.skipped}` : "",
  ]
    .filter(Boolean)
    .join("  ");
}

export const scenario: Scenario = {
  name: "observe",
  description: "ReflectApi / InspectApi / ReplayApi：自省、巡检与回放的脚本化走查",
  async run(ctx: ScenarioContext): Promise<void> {
    const flags = parseFlags(ctx.argv);
    const rawTurns = flags["turns"];
    const turns =
      typeof rawTurns === "string" && !Number.isNaN(Number(rawTurns)) ? Math.max(1, Number(rawTurns)) : 2;

    if (ctx.fake) {
      console.log("[notice] fake 模式：无模型文本与真实用量；reflect/replay 仍走完整 DAO 路径，成本/用量计 0。");
    }

    const rt: Runtime = await openRuntime({ root: ctx.root, db: ctx.db, config: ctx.config, fake: ctx.fake });
    try {
      // ── ① 注册两枚 MBTI 画像 ──────────────────────────────────────────────
      await step(1, "注册两枚 MBTI 画像（infj / entp）", async () => {
        const ids = await registerPersonas(rt, ctx.root, ["infj", "entp"]);
        p("已注册", ids.join(", "));
      });

      // ── ② 建 / 跑 / 关一场小场景 ──────────────────────────────────────────
      await step(2, `投递一幕 round_robin 场景（maxTurns=${turns}）并关场`, async () => {
        const est = await rt.scenes.create({
          sceneId: "observe-demo",
          name: "观察演示·小组对谈",
          participants: [
            { agentId: "infj", role: "teacher" },
            { agentId: "entp", role: "student" },
          ],
          floorMode: "round_robin",
          maxTurns: turns,
        });
        p("建立", `sceneId=${est.sceneId}  conversationId=${est.conversationId}  floor=${est.floorMode}`);

        const ran = await rt.scenes.run("observe-demo");
        p("run", `stopReason=${ran.stopReason}  turnsCompleted=${ran.turnsCompleted}  dissolved=${ran.dissolved}`);

        // 关场以触达日终自省（day-end）；公开门面不返回日终明细，这里只观察关场结果。
        const closed = await rt.scenes.close("observe-demo");
        p(
          "close",
          `stopReason=${closed.stopReason}  dissolved=${closed.dissolved}  invariantViolations=${closed.invariantViolations.length}  degradeTrace=${closed.degradeTrace.length}`,
        );
      });

      // ── ③ 单次自省 ────────────────────────────────────────────────────────
      await step(3, "reflect.run(infj, trigger=manual)", async () => {
        const r = await rt.reflect.run("infj", { trigger: "manual" });
        p("result", runSummary(r));
      });

      // ── ④ 阈值触发器 + 广播触发器 ─────────────────────────────────────────
      await step(4, "reflect.maybe(infj, scene_end) + reflect.runAll(scene_end)", async () => {
        const single = await rt.reflect.maybe("infj", "scene_end");
        p("maybe", single ? runSummary(single) : "undefined（阈值未达）");

        const all = await rt.reflect.runAll({ trigger: "scene_end" });
        p("runAll", `${all.length} 个 role agent`);
        for (const r of all) console.log(`    · ${runSummary(r)}`);
      });

      // ── ⑤ 自省快照 ────────────────────────────────────────────────────────
      await step(5, "reflect.read(infj) —— 快照摘要", async () => {
        const snap: ReflectSnapshot = await rt.reflect.read("infj");
        p("profiles", snap.profiles.length);
        p("reflections", snap.reflections.length);
        p("state", `mood=${snap.state.mood} / 强度=${snap.state.moodIntensity} / 精力=${snap.state.energy}`);
        const last = snap.reflections.slice(0, 3).map((x) => `${x.trigger}:${x.status}`);
        if (last.length) p("最近自省", last.join(" | "));
        const prof = snap.profiles[0];
        if (prof) p("首个画像", `${prof.subject} → ${prof.impression ?? "（无印象）"}`);
      });

      // ── ⑥ 不变量检查 ──────────────────────────────────────────────────────
      await step(6, "inspect.checkInvariants()", async () => {
        const inv = await rt.inspect.checkInvariants();
        p("mesh", `ok=${inv.mesh.ok}  checked=${inv.mesh.checked}  violations=${inv.mesh.violations.length}`);
        p("role", `ok=${inv.role.ok}  checked=${inv.role.checked}  violations=${inv.role.violations.length}`);
        for (const v of inv.role.violations.slice(0, 3)) console.log(`    · ${v.id}: ${v.assertion} (${v.count})`);
      });

      // ── ⑦ mesh 一致性 ─────────────────────────────────────────────────────
      await step(7, "inspect.checkMeshConsistency()", async () => {
        const mc = await rt.inspect.checkMeshConsistency();
        p("notChecked", `${mc.notChecked.length} 项`);
        for (const n of mc.notChecked) console.log(`    · ${short(n, 100)}`);
        p("agents", mc.agents.length);
        for (const a of mc.agents) {
          if (a.findings.length) {
            for (const f of a.findings) console.log(`    · ${a.agentId}: ${f.code}${f.field ? `(${f.field})` : ""} → ${f.repair}`);
          } else {
            console.log(`    · ${a.agentId}: 无 finding`);
          }
        }
      });

      // ── ⑧ 悬挂引用扫描 ────────────────────────────────────────────────────
      await step(8, "inspect.scanDanglingMessages()", async () => {
        const d = await rt.inspect.scanDanglingMessages();
        p("scanned", d.scanned);
        p("dangling", d.dangling.length);
        p("byKind", d.byKind);
        p("marked(降置信)", d.marked);
        p("audited(审计行)", d.audited);
        p("skippedNoAnchor", d.skippedNoAnchor);
      });

      // ── ⑨ 成本指标（排除自省流） ──────────────────────────────────────────
      await step(9, "inspect.costMetrics()", async () => {
        const c: RoleCostMetrics = await rt.inspect.costMetrics();
        p("window", `${c.window.since} → ${c.window.until}`);
        p("deliveries/messages", `${c.deliveriesTotal} / ${c.messagesTotal}`);
        p("wakePerMessage", c.wakePerMessage);
        p("silentRate", c.silentRate);
        p("p1RatePerDelivery", c.p1RatePerDelivery);
        p("排除自省流投递/消息", `${c.excludedReflectDeliveries} / ${c.excludedReflectMessages}`);
        p("unattributed", c.unattributedAccounts.length ? c.unattributedAccounts.join(", ") : "（无）");
        for (const cv of c.caveats) console.log(`    · caveat: ${short(cv, 100)}`);
      });

      // ── ⑩ 记忆时间线 ──────────────────────────────────────────────────────
      await step(10, "inspect.memoryTimeline(infj)", async () => {
        const tl: MemoryTimeline = await rt.inspect.memoryTimeline("infj");
        const items = tl.scenes.reduce((n, s) => n + s.items.length, 0);
        p("ownerAgent", tl.ownerAgent);
        p("scenes", `${tl.scenes.length} 个场景 / ${items} 条记忆`);
        p("truncated", tl.truncated);
        for (const s of tl.scenes) {
          console.log(`    · ${s.sceneId}: turnCount=${s.turnCount}  items=${s.items.length}  status=${s.status}`);
        }
      });

      // ── ⑪ 印象演化 ────────────────────────────────────────────────────────
      await step(11, "inspect.impressionEvolution(infj, person, entp)", async () => {
        const ev: ImpressionEvolution = await rt.inspect.impressionEvolution("infj", "person", "entp");
        p("subject", `${ev.subjectType}:${ev.subjectId}`);
        p("curve", `points=${ev.points.length}  jumps=${ev.jumps.length}`);
        p(
          "current",
          `impression=${ev.current.impression ?? "（无）"}  valence=${ev.current.valence ?? "—"}  closeness=${ev.current.closeness ?? "—"}  trust=${ev.current.trust ?? "—"}`,
        );
        for (const j of ev.jumps.slice(0, 3)) {
          console.log(`    · jump: Δvalence=${j.valenceDelta}  ${j.verdict} ${j.reflectionId ? `(reflection=${j.reflectionId})` : ""}`);
        }
      });

      // ── ⑫ 成本视图 ────────────────────────────────────────────────────────
      await step(12, "inspect.costView()", async () => {
        const cv: CostView = await rt.inspect.costView();
        p("window", `${cv.window.since} → ${cv.window.until}`);
        p("scope", `sceneIds=${Array.isArray(cv.scope.sceneIds) ? cv.scope.sceneIds.join(",") || "（无）" : cv.scope.sceneIds}  agentIds=${Array.isArray(cv.scope.agentIds) ? cv.scope.agentIds.join(",") || "（无）" : cv.scope.agentIds}`);
        p("meshCounters", `messages=${cv.meshCounters.messagesTotal}  deliveries=${cv.meshCounters.deliveriesTotal}  wakePerMsg=${cv.meshCounters.derived.wakePerMessage}`);
        p("roleOnly", `messages=${cv.roleOnly.messagesTotal}  deliveries=${cv.roleOnly.deliveriesTotal}  silentRate=${cv.roleOnly.silentRate}`);
        p("roleNormalized", `turns=${cv.roleNormalized.turns}`);
        p("retrieval", `calls=${cv.localOverhead.retrieval.calls}  tokensTotal=${cv.localOverhead.retrieval.tokensTotal}`);
        p("reflection", `runs=${cv.localOverhead.reflection.runs}  episodesWritten=${cv.localOverhead.reflection.episodesWritten}`);
        p("health", `danglingEvidence=${cv.health.danglingEvidence}  L0/L1/L2=${cv.health.evidenceLevelMix.L0}/${cv.health.evidenceLevelMix.L1}/${cv.health.evidenceLevelMix.L2}`);
      });

      // ── ⑬ 回放：record ×2、结构化比较、隔离重执行 ─────────────────────────
      await step(13, "replay.record / compare / reexecute", async () => {
        const rec1: DomainDecisionReplay = await rt.replay.record("infj");
        const rec2: DomainDecisionReplay = await rt.replay.record("entp");
        p("rec1(infj)指纹", `spec=${rec1.fingerprint.specHash?.slice(0, 12) ?? "—"}  blueprint=${rec1.fingerprint.blueprintHash?.slice(0, 12) ?? "—"}  model=${rec1.fingerprint.modelConfigHash?.slice(0, 12) ?? "—"}`);
        p("rec1内容", `turns=${rec1.turns.length}  retrievals=${rec1.retrievals.length}  episodes=${rec1.memory.episodes}  reflections=${rec1.memory.reflections}`);
        p("rec2内容", `turns=${rec2.turns.length}  retrievals=${rec2.retrievals.length}  episodes=${rec2.memory.episodes}  reflections=${rec2.memory.reflections}`);
        if (rec1.missing.length) p("rec1.missing", rec1.missing.join(" | ") || "（无）");

        const cmp: ReplayCompareResult = rt.replay.compare(rec1, rec2);
        p("compare", `sameMemory=${cmp.sameMemory}  sameDecisions=${cmp.sameDecisions}`);
        for (const m of [...cmp.memory, ...cmp.decisions, ...cmp.retrieval]) {
          console.log(`    · ${m.key}: left=${m.left}  right=${m.right}  delta=${m.delta}`);
        }

        // 隔离重执行：用 rec1 读出的冻结指纹 + 冻结探针脚本，构造一条最小合法输入。
        const rexec: DomainDecisionReplay = await rt.replay.reexecute({
          fingerprint: rec1.fingerprint,
          probes: [
            { from: "entp", text: "如果记忆可以回放，你会先看哪一段？", turn: 1, remember: "讨论记忆回放的意义" },
            { from: "entp", text: "再补一条：证据链与成本，哪个更该优先？", turn: 2, noteSelf: "我倾向于先保证证据链完整" },
          ],
          virtualStart: "W1D1T8",
          usagePerStep: { tokensIn: 120, tokensOut: 60 },
        });
        p("reexecute", `source=${rexec.source}  turns=${rexec.turns.length}  episodes=${rexec.memory.episodes}  reflections=${rexec.memory.reflections}  cost=${JSON.stringify(rexec.cost)}`);

        const cmp2 = rt.replay.compare(rec1, rexec);
        p("compare(record vs reexecuted)", `sameMemory=${cmp2.sameMemory}  sameDecisions=${cmp2.sameDecisions}`);
      });

      console.log("\n✓ observe 场景走查完成。");
    } finally {
      await rt.close();
    }
  },
};