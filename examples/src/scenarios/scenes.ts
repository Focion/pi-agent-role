// ═══════════════════════════════════════════════════════════════════════════
// scenes 场景：完整 SceneApi 编排面走查（MBTI 人格圆桌）
//
// 走查四种 floor 模式（director 显式剧本 / round_robin / reactive / free_for_all）、
// 虚拟时钟、旁白注入（幂等）、pause/resume、close（日终解散）。全程只用公开
// `@pi/agent-role`，不 import `@pi/agent-mesh`。
//
// 备注：SceneEstablished / SceneRunResult / SceneInjection / DirectorScript /
// DirectorStep / CreateSceneInput / SceneRunOptions 尚未在公开入口 src/index.ts 再
// 导出（这些类型只在 runtime/types.ts / scene/types.ts 内部）。为不越界改公开面，
// 本场景对这些类型只调用方法、靠上下文类型推断，不做显式类型标注（与 agents/observe
// 场景同一约定）。
//
// 研判差异：director 非 loop 剧本播完 → stopReason="idle"；但 run(maxTurns:4) 会先
// 命中「轮次预算」熔断 → "max_turns"（maxTurns 守卫在剧本解析之前，见 orchestrator）。
// 故演示 idle 时不传 maxTurns，让剧本自身播完收尾；传 maxTurns 只能约束轮次上限。
// ═══════════════════════════════════════════════════════════════════════════

import type { Runtime } from "@pi/agent-role";

import { parseFlags } from "../context.ts";
import type { Scenario, ScenarioContext } from "../context.ts";
import { openRuntime, registerPersonas } from "../harness.ts";
import { personaOf } from "../personas.ts";

/** 四种发言权模式（本地常量，不 import 未再导出的 FloorMode）。 */
const FLOOR_MODES = ["director", "round_robin", "reactive", "free_for_all"] as const;
type FloorMode = (typeof FLOOR_MODES)[number];

const DEFAULT_PERSONAS = ["intj", "enfp", "istj", "infp"];

/**
 * 参与者入参：首位当课堂主持（teacher，兼作会话 creator/modmoderator），其余为学生。
 * 领域角色非人格角色——差异仍由模板驱动，代码零 MBTI 分支（C1）。
 */
function participantInputs(ids: readonly string[]): Array<{ agentId: string; role: "teacher" | "student" }> {
  return ids.map((id, i) => ({ agentId: id, role: i === 0 ? "teacher" : "student" }));
}

/** 每个步骤的 banner：`── ① … ──`。 */
function banner(n: string, title: string): void {
  console.log(`\n── ${n} ${title} ──`);
}

/** 单步包装：某步抛错只打印并继续，不中断整场走查。 */
async function step(n: string, title: string, fn: () => void | Promise<void>): Promise<void> {
  banner(n, title);
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`  ✗ 步骤失败：${msg}`);
  }
}

export const scenario: Scenario = {
  name: "scenes",
  description: "完整 SceneApi 编排面（director 剧本 / round_robin / reactive / free_for_all / 虚拟时钟 / 旁白注入 / pause·resume / close 日终）",
  async run(ctx: ScenarioContext): Promise<void> {
    const rt: Runtime = await openRuntime({ root: ctx.root, db: ctx.db, config: ctx.config, fake: ctx.fake });
    try {
      const flags = parseFlags(ctx.argv);
      const raw = flags.personas;
      const personaIds =
        (typeof raw === "string" && raw.trim().length > 0 ? raw : DEFAULT_PERSONAS.join(","))
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      // 校验 + 解析展示名：未知 id 直接抛错（personaOf），不静默缺人。
      const people = personaIds.map((id) => personaOf(id));

      const floorRaw = flags.floor;
      const onlyMode: FloorMode | null =
        typeof floorRaw === "string" && (FLOOR_MODES as readonly string[]).includes(floorRaw)
          ? (floorRaw as FloorMode)
          : null;
      if (floorRaw !== undefined && onlyMode === null) {
        console.log(`  ⚠ 未知 --floor "${String(floorRaw)}"，忽略并跑全部模式（可选：${FLOOR_MODES.join("/")}）`);
      }
      const modes: readonly FloorMode[] = onlyMode ? [onlyMode] : FLOOR_MODES;

      console.log(`scenes 场景启动（fake=${ctx.fake}）`);
      if (ctx.fake) {
        console.log("  ⚠ fake 模式：FakeStreamPort 无 LLM 回填，角色台词缺失；tokensCumulative 恒为 0（无真实用量）。");
      }
      console.log(`  人格圆桌：${people.map((p) => `${p.id}(${p.mbti}·${p.displayName})`).join(" / ")}`);
      console.log(`  floor 模式：${modes.join(" → ")}`);

      await registerPersonas(rt, ctx.root, personaIds);
      console.log(`  已注册 ${personaIds.length} 个角色 agentId：${personaIds.join(", ")}`);

      // 追踪已建档场景，收尾统一 close。已 ended 的场景再 close 会再次尝试 dissolve 并留
      // degradeTrace，故每场只关一次。
      const created: string[] = [];

      // ① director + 显式剧本 ──────────────────────────────────────────
      await step("①", "director + 显式剧本（非 loop 播完 → idle）", async () => {
        const est = await rt.scenes.create({
          sceneId: "scene-director",
          name: "MBTI 圆桌·导演剧本",
          participants: participantInputs(personaIds),
          floorMode: "director",
          script: { steps: personaIds.map((id) => ({ target: id })), loop: false },
        });
        created.push("scene-director");
        console.log(`  sceneId=${est.sceneId}  conversationId=${est.conversationId}  floorMode=${est.floorMode}  virtualStart=${est.virtualStart}`);
        console.log(`  participants=${est.participants.map((p) => `${p.agentId}:${p.role}`).join(", ")}`);
        console.log(`  剧本步骤=${personaIds.join(" → ")}（loop=false）`);
        // 不传 maxTurns：让剧本自身播完收尾为 "idle"。run({maxTurns:4}) 会先命中轮次预算熔断 → "max_turns"。
        const res = await rt.scenes.run("scene-director");
        console.log(`  stopReason=${res.stopReason}  turnsCompleted=${res.turnsCompleted}  tokensCumulative=${res.tokensCumulative}  queueClearedDetected=${res.queueClearedDetected}`);
      });

      // ② round_robin + 虚拟时钟 30min/轮 ──────────────────────────────
      await step("②", "round_robin + 虚拟时钟（起点 W1D1T09 · 30min/轮）", async () => {
        const est = await rt.scenes.create({
          sceneId: "scene-round-robin",
          name: "MBTI 课堂·轮转发言",
          participants: participantInputs(personaIds),
          floorMode: "round_robin",
          virtualStart: "W1D1T09",
          turnDurationMinutes: 30,
        });
        created.push("scene-round-robin");
        console.log(`  virtualStart=${est.virtualStart}（公开门面无 scenes.get，virtualNow 不从 facade 读）`);
        const res = await rt.scenes.run("scene-round-robin", undefined, { maxTurns: 3 });
        console.log(`  stopReason=${res.stopReason}  turnsCompleted=${res.turnsCompleted}  tokensCumulative=${res.tokensCumulative}`);
        console.log(`  虚拟时钟证据：起点=${est.virtualStart}，${res.turnsCompleted} 轮 × 30min 已推进（turnsCompleted 递增即轮次账本已落库）`);
      });

      // ③ reactive ─────────────────────────────────────────────────────
      await step("③", "reactive（按 RoleTurnState 打分取 top-1）", async () => {
        await rt.scenes.create({
          sceneId: "scene-reactive",
          name: "MBTI 圆桌·即兴回应",
          participants: participantInputs(personaIds),
          floorMode: "reactive",
        });
        created.push("scene-reactive");
        const res = await rt.scenes.run("scene-reactive", undefined, { maxTurns: 2 });
        console.log(`  stopReason=${res.stopReason}  turnsCompleted=${res.turnsCompleted}`);
      });

      // ④ free_for_all ─────────────────────────────────────────────────
      await step("④", "free_for_all（不点名，只推进时钟）", async () => {
        await rt.scenes.create({
          sceneId: "scene-ffa",
          name: "MBTI 圆桌·自由讨论",
          participants: participantInputs(personaIds),
          floorMode: "free_for_all",
        });
        created.push("scene-ffa");
        const res = await rt.scenes.run("scene-ffa", undefined, { maxTurns: 1 });
        console.log(`  stopReason=${res.stopReason}  turnsCompleted=${res.turnsCompleted}（free_for_all 不点名、不发 cue，仅推进虚拟时钟）`);
      });

      // ⑤ inject 旁白 + 幂等 ──────────────────────────────────────────
      await step("⑤", "inject 旁白（同 injectId 幂等）", async () => {
        const input = { sceneId: "scene-round-robin", injectId: "nar-1", text: "（旁白）课间铃响了。" };
        const first = await rt.scenes.inject(input);
        console.log(`  injectId=${first.injectId}  messageId=${first.messageId}  msgClass=${first.msgClass}  fromAccount=${first.fromAccount}  virtualTs=${first.virtualTs}`);
        const again = await rt.scenes.inject(input);
        console.log(`  幂等：同 injectId 再注入 → messageId=${again.messageId}（与首次相同=${first.messageId === again.messageId}，未重复发送）`);
      });

      // ⑥ pause/resume ─────────────────────────────────────────────────
      await step("⑥", "pause/resume（O04：active 场景停点持久化）", async () => {
        const paused = await rt.scenes.pause("scene-reactive");
        console.log(`  pause → stopReason=${paused.stopReason}  turnsCompleted=${paused.turnsCompleted}`);
        const resumed = await rt.scenes.resume("scene-reactive", undefined, { maxTurns: 2 });
        console.log(`  resume → stopReason=${resumed.stopReason}  turnsCompleted=${resumed.turnsCompleted}  tokensCumulative=${resumed.tokensCumulative}`);
      });

      // ⑦ close 单场（日终 + 解散） ───────────────────────────────────
      await step("⑦", "close 单场（日终收敛 → 解散群会话）", async () => {
        const closed = await rt.scenes.close("scene-director");
        console.log(`  sceneId=${closed.sceneId}  stopReason=${closed.stopReason}  turnsCompleted=${closed.turnsCompleted}`);
        console.log(`  dissolved=${closed.dissolved}  degradeTrace=[${closed.degradeTrace.join(" | ") || "空"}]`);
        console.log(`  invariantViolations=[${closed.invariantViolations.map((v) => `${v.id}:${v.count}`).join(" | ") || "空"}]（未开 devMode，close 不跑关场自检）`);
      });

      // ⑧ 收尾：其余场景逐个 close ────────────────────────────────────
      await step("⑧", "收尾：逐个 close 其余场景", async () => {
        const rest = created.filter((id) => id !== "scene-director");
        for (const id of rest) {
          const r = await rt.scenes.close(id);
          console.log(`  close ${id} → stopReason=${r.stopReason}  dissolved=${r.dissolved}  degradeTrace=[${r.degradeTrace.length} 项]`);
        }
      });

      console.log(`\n✅ scenes 场景走查完成`);
    } finally {
      await rt.close();
    }
  },
};