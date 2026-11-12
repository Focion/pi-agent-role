// ═══════════════════════════════════════════════════════════════════════════
// agents 场景：完整 AgentApi 生命周期 + 记忆门面（MBTI 人格走查）
//
// 走查 create / createBatch / setModelConfig / reproject / reconcile / respec /
// checkMeshConsistency / exportAsBlueprint / retire / restore / deleteAgent，
// 以及 memory.stats + memory.recall 两个只读门面。全程只用公开 `@pi/agent-role`，
// 不 import `@pi/agent-mesh`。
//
// 备注：`ExportAsBlueprintInput/Result` 与 `ReprojectResult/ReconcileResult` 尚未在
// 公开入口 src/index.ts 再导出（§6.4 / §6.2 的类型仍只在 runtime/types.ts 内部）。
// 为不越界改公开面，本场景对这两处只调用方法、靠上下文类型推断，不做显式类型标注。
// ═══════════════════════════════════════════════════════════════════════════

import type {
  CreateAgentInput,
  CreateBatchItemResult,
  DeleteAgentResult,
  MeshConsistencyReport,
  MemoryRecallResult,
  MemoryStats,
  RespecResult,
  RestoreResult,
  RetireResult,
  Runtime,
  SetModelConfigResult,
} from "@pi/agent-role";

import { parseFlags } from "../context.ts";
import type { Scenario, ScenarioContext } from "../context.ts";
import { openRuntime } from "../harness.ts";
import { ALL_PERSONA_IDS, personaOf, writePersonaBlueprint } from "../personas.ts";

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
  name: "agents",
  description: "完整 AgentApi 生命周期 + 记忆门面（create/batch/modelConfig/reproject/reconcile/respec/consistency/export/retire/restore/delete + memory）",
  async run(ctx: ScenarioContext): Promise<void> {
    const rt: Runtime = await openRuntime({ root: ctx.root, db: ctx.db, config: ctx.config, fake: ctx.fake });
    try {
      const flags = parseFlags(ctx.argv);
      const raw = flags.personas;
      const personaList = (typeof raw === "string" ? raw : "intj,enfp,istj,infp,entj")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (personaList.length < 5) {
        throw new Error(
          `--personas 至少需要 5 个角色（默认 intj,enfp,istj,infp,entj），当前只有 ${personaList.length} 个`,
        );
      }
      const [a0, a1, a2, a3, a4] = personaList as [string, string, string, string, string];
      // 牺牲者：从八种人格里挑一个不在 --personas 里的，只用于第 ⑩ 步 deleteAgent。
      const sacrificial = ALL_PERSONA_IDS.find((id) => !personaList.includes(id)) ?? "isfp";

      console.log(`agents 场景启动（fake=${ctx.fake}）`);
      console.log(`  persona 计划：`)
      console.log(`    ① 单建：${a0} / ${a1}`);
      console.log(`    ② 批建：${a2} / ${a3} / ${a4}`);
      console.log(`    ③④⑤⑦⑨ 主对象：${a0}，④ 另用 ${a1}，⑧ 用 ${a2}`);
      console.log(`    ⑩ 牺牲者：${sacrificial}（只建只删）`);

      // 缓存第 ① 步 a0 的模型 id，供第 ③ 步非 fake 路径拼 "-tuned"。
      let a0ModelId = "";

      // ① agents.create × 2 ──────────────────────────────────────────────
      await step("①", `agents.create × 2（${a0} / ${a1}）`, async () => {
        for (const id of [a0, a1]) {
          const p = personaOf(id);
          const blueprint = writePersonaBlueprint(ctx.root, p);
          const r = await rt.agents.create({ blueprint, agentId: p.id, displayName: p.displayName });
          if (id === a0) a0ModelId = r.modelConfig.dialogue.modelId;
          console.log(`  agentId=${r.agentId}  displayName=${p.displayName}`);
          console.log(`    blueprintId=${r.blueprintId}`);
          console.log(`    blueprintHash=${r.blueprintHash}`);
          console.log(`    promptVersion=${r.promptVersion}`);
          console.log(`    modelConfig.provider=${r.modelConfig.dialogue.provider}  modelId=${r.modelConfig.dialogue.modelId}  thinkingLevel=${r.modelConfig.dialogue.thinkingLevel}`);
          console.log(`    mesh.accountId=${r.mesh.accountId}  endpointId=${r.mesh.endpointId}`);
        }
      });

      // ② createBatch × 3 ──────────────────────────────────────────────
      await step("②", `createBatch × 3（${a2} / ${a3} / ${a4}）`, async () => {
        const inputs: CreateAgentInput[] = [a2, a3, a4].map((id) => {
          const p = personaOf(id);
          return { blueprint: writePersonaBlueprint(ctx.root, p), agentId: p.id, displayName: p.displayName };
        });
        const items: CreateBatchItemResult[] = await rt.agents.createBatch(inputs);
        for (const item of items) {
          if (item.after === "active") {
            console.log(`  [active]  agentId=${item.result?.agentId}  promptVersion=${item.result?.promptVersion}`);
          } else {
            console.log(`  [${item.after}]  agentId=${item.agentId}  error=${item.error?.message ?? "—"}`);
          }
        }
        console.log(`  （库不承诺整批原子回滚：已成功项保留，失败项按失败阶段推进，这里只如实汇报）`);
      });

      // ③ setModelConfig ────────────────────────────────────────────────
      await step("③", `setModelConfig（${a0}）`, async () => {
        const patch = ctx.fake
          ? { dialogue: { thinkingLevel: "high" as const } }
          : { dialogue: { modelId: `${a0ModelId}-tuned` } };
        const r: SetModelConfigResult = rt.agents.setModelConfig(a0, patch);
        console.log(`  patch=`, patch);
        console.log(`  modelConfig.provider=${r.modelConfig.dialogue.provider}  modelId=${r.modelConfig.dialogue.modelId}  thinkingLevel=${r.modelConfig.dialogue.thinkingLevel}`);
        console.log(`  modelConfigSource=`, r.modelConfigSource);
      });

      // ④ reproject + reconcile ─────────────────────────────────────────
      await step("④", `reproject + reconcile（${a1}）`, async () => {
        const reproj = rt.agents.reproject(a1);
        console.log(`  reproject → 写出 ${reproj.files.length} 个实例文件`);
        for (const f of reproj.files) console.log(`    - ${f}`);
        const rec = rt.agents.reconcile(a1);
        console.log(`  reconcile → imported=${rec.imported.length}  ignored=${rec.ignored.length}  reprojected=${rec.reprojected.length}`);
        console.log(`  （幂等：未手工改模板时 imported=0，等同一次 no-op 对账）`);
      });

      // ⑤ respec ────────────────────────────────────────────────────────
      await step("⑤", `respec（${a0}）`, async () => {
        const r: RespecResult = await rt.agents.respec(a0);
        console.log(`  agentId=${r.agentId}`);
        console.log(`  promptVersion=${r.promptVersion}`);
        console.log(`  specHashChanged=${r.specHashChanged}`);
        console.log(`  pendingMeshDrift=${r.pendingMeshDrift.length} 项`);
        for (const d of r.pendingMeshDrift) {
          console.log(`    - ${d.field}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}  (repair=${d.repair})`);
        }
      });

      // ⑥ checkMeshConsistency ──────────────────────────────────────────
      await step("⑥", "inspect.checkMeshConsistency()", async () => {
        const report: MeshConsistencyReport = await rt.inspect.checkMeshConsistency();
        console.log(`  checkedAt=${report.checkedAt}`);
        console.log(`  notChecked=${report.notChecked.length} 项`);
        for (const n of report.notChecked) console.log(`    - ${n}`);
        console.log(`  有 findings 的 agent 数 = ${report.agents.length}`);
        for (const a of report.agents) {
          console.log(`    - ${a.agentId}: ${a.findings.length} 项 findings`);
          for (const f of a.findings) {
            console.log(`        ${f.code}  field=${f.field ?? "—"}  repair=${f.repair}`);
          }
        }
      });

      // ⑦ exportAsBlueprint ─────────────────────────────────────────────
      await step("⑦", `exportAsBlueprint（${a0}，include: skills/specialties）`, async () => {
        const r = await rt.agents.exportAsBlueprint({
          agentId: a0,
          blueprintId: `x-${a0}-export`,
          include: ["skills", "specialties"],
          note: "agents 场景导出的谱系蓝本（仅 skills/specialties）",
        });
        console.log(`  blueprintId=${r.blueprintId}`);
        console.log(`  blueprintDir=${r.blueprintDir}`);
        console.log(`  blueprintHash=${r.blueprintHash}`);
        console.log(`  lineage.generation=${r.lineage.generation}`);
      });

      // ⑧ retire → restore ──────────────────────────────────────────────
      await step("⑧", `retire → restore（${a2}）`, async () => {
        const ret: RetireResult = rt.agents.retire(a2);
        console.log(`  retire → status=${ret.status}  retiredAt=${ret.retiredAt ?? "—"}  alreadyRetired=${ret.alreadyRetired}`);
        const res: RestoreResult = rt.agents.restore(a2);
        console.log(`  restore → status=${res.status}`);
      });

      // ⑨ memory.stats + memory.recall ──────────────────────────────────
      await step("⑨", "memory.stats() + memory.recall()", async () => {
        const stats: MemoryStats = await rt.memory.stats();
        console.log(`  stats.agents=${stats.agents.length} 个`);
        for (const a of stats.agents) {
          console.log(`    - ${a.agentId}: episodes=${a.episodes}  subjects=${a.subjects}  knowledgeItems=${a.knowledgeItems}  reflections=${a.reflections}`);
        }
        const rec: MemoryRecallResult = await rt.memory.recall(a0, "我们聊过的印象最深的点", { limit: 3 });
        console.log(`  recall(ownerAgent=${rec.ownerAgent})  query="${rec.query}"`);
        console.log(`  hit count=${rec.items.length}`);
        for (const it of rec.items) {
          console.log(`    - [${it.kind}/${it.status}]  salience=${it.salience.toFixed(2)}  ${it.gist}`);
        }
      });

      // ⑩ deleteAgent ───────────────────────────────────────────────────
      await step("⑩", `deleteAgent（牺牲者 ${sacrificial}，先建后删）`, async () => {
        const p = personaOf(sacrificial);
        await rt.agents.create({ blueprint: writePersonaBlueprint(ctx.root, p), agentId: p.id, displayName: p.displayName });
        const r: DeleteAgentResult = rt.agents.deleteAgent(sacrificial);
        console.log(`  agentId=${r.agentId}  deleted=${r.deleted}`);
      });

      console.log(`\n✅ agents 场景走查完成`);
    } finally {
      await rt.close();
    }
  },
};