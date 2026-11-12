// ═══════════════════════════════════════════════════════════════════════════
// scenario: 蓝本生成（BlueprintApi）+ 设施 Agent（FacilityApi）演示
//
// 走一遍「描述 → blueprints.generate → blueprints.promote → facilities.create」
// 的蓝图流水线（§24 / §5.5），再顺手把一枚角色与一枚设施放进同一个场景跑一轮，
// 证明角色与设施能在同一个 runtime 里共存。
//
// 关键点：
//   · AuthorModel 由宿主注入，这里用确定性的 DemoAuthorModel（无 LLM / 无网络），
//     所以 fake 与 real 模式行为一致——只占时间，不烧 token。
//   · manifest.yaml 由驱动器的 scaffold 阶段生成（schema.ts 的 fileSpecs 也标注
//     「模型无需填写」），模型绝不可回填它：回填会被字段白名单削掉 files[]，
//     进而让 promote 判出「孤儿文件」而失败。因此 DemoAuthorModel 只填其余文件。
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AuthorModel,
  AuthorModelRequest,
  AuthorModelResponse,
  Runtime,
} from "@pi/agent-role";

import { openRuntime, registerPersona } from "../harness.ts";
import type { Scenario, ScenarioContext } from "../context.ts";

// ─── 确定性假模型（§24.5 `model`）───────────────────────────────────────────

/** 把描述归一化出的事实拼成一句话，作为「从 req.facts 回填字段」的证据。 */
function factSummary(req: AuthorModelRequest): string {
  return req.facts.map((f) => f.text).join(" ").trim();
}

/** identity 蓝本：只填冷启动核心文件；neverInfer（name.full 等）绝不填。 */
function fillIdentityFile(file: string, files: Record<string, unknown>, summary: string): void {
  switch (file) {
    case "personal":
      files.personal = { age: 30, gender: "女", role: summary };
      break;
    case "constraints":
      files.constraints = {
        constraints: [
          { text: "耐心倾听学生，不轻易打断", severity: "soft" },
          { text: "不评判学生作品的好坏，只谈技法与感受", severity: "hard" },
        ],
      };
      break;
    case "evolution":
      files.evolution = { mood: "温和", moodIntensity: 0.6, energy: 0.7 };
      break;
    case "narrative_voice":
      files.narrative_voice = {
        default_mode: "温柔耐心",
        fingerprint: {
          sentence_starters: ["嗯，慢慢来"],
          enders: ["好吗？"],
          metaphor_domains: ["色彩", "风景"],
        },
      };
      break;
    case "agent_protocol":
      files.agent_protocol = { capabilities: ["素描与水彩教学"], initiate: ["chat"] };
      break;
    case "psychology":
      files.psychology = { personality: ["温柔", "耐心"] };
      break;
    default:
      break; // manifest 由 scaffold 生成，不碰（否则会破坏 promote 的文件清单校验）
  }
}

/** facility 蓝本：manifest + facility + protocol + constraints（§5.5 与 authoring/schema.ts）。 */
function fillFacilityFile(file: string, files: Record<string, unknown>, summary: string): void {
  switch (file) {
    case "facility":
      files.facility = {
        name: summary || "图书馆",
        type: "library",
        duties: ["提供安静的阅读与借阅空间", "解答图书检索与借还流程"],
      };
      break;
    case "protocol":
      files.protocol = { capabilities: ["图书检索", "借还登记"], initiate: [] };
      break;
    case "constraints":
      files.constraints = {
        constraints: [
          { text: "保持安静，不发出噪音", severity: "hard" },
          { text: "借阅须登记，逾期温和提醒", severity: "soft" },
        ],
      };
      break;
    default:
      break;
  }
}

/** 确定性、廉价、无网络的蓝本生成模型——只为证明五步流水线走得通。 */
function demoAuthorModel(): AuthorModel {
  return {
    name: "demo-deterministic",
    async generate(req: AuthorModelRequest): Promise<AuthorModelResponse> {
      const files: Record<string, unknown> = {};
      const summary = factSummary(req);
      for (const t of req.targets) {
        if (req.kind === "identity") fillIdentityFile(t.file, files, summary);
        else fillFacilityFile(t.file, files, summary);
      }
      return { files, usage: { inputTokens: 128, outputTokens: 256 } };
    },
  };
}

// ─── 打印小工具 ─────────────────────────────────────────────────────────────

/** 单步执行 + 横幅；失败打印真实错误并继续后续步骤（演示不因单步崩而整体倒下）。 */
async function step(id: string, title: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n── ${id} ${title} ──`);
  try {
    await fn();
  } catch (err) {
    console.error(`  ✗ 本步失败（继续演示后续步骤）：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

// ─── Scenario───────────────────────────────────────────────────────────────

export const scenario: Scenario = {
  name: "authoring",
  description: "BlueprintApi（generate → promote）+ FacilityApi（facility agent create）+ 角色·设施同场",
  async run(ctx: ScenarioContext): Promise<void> {
    const rt: Runtime = await openRuntime({
      root: ctx.root,
      db: ctx.db,
      config: ctx.config,
      fake: ctx.fake,
    });
    try {
      const model = demoAuthorModel();

      let teacherReport: Awaited<ReturnType<typeof rt.blueprints.generate>> | null = null;
      let taught: Awaited<ReturnType<typeof rt.blueprints.promote>> | null = null;

      await step("①", "生成教师角色蓝本（identity）", async () => {
        teacherReport = await rt.blueprints.generate({
          description: "（示例）一个温柔耐心的美术老师",
          kind: "identity",
          suggestedId: "demo-art-teacher",
          model,
        });
        console.log("  stagingId:", teacherReport.stagingId);
        console.log("  core keys:", Object.keys(teacherReport.core).join(", "));
        console.log("  files:", teacherReport.files.map((f) => f.path).join(", "));
        console.log("  allocation.length:", teacherReport.allocation.length);
        console.log("  gaps.length:", teacherReport.gaps.length);
        console.log("  unallocated.length:", teacherReport.unallocated.length);
        console.log("  seeds.length:", teacherReport.seeds.length);
        console.log("  validation.ok:", teacherReport.validation.ok);
        console.log("  needsHumanReview:", teacherReport.needsHumanReview);
        if (teacherReport.needsHumanReview) {
          console.log("  reasons:", teacherReport.needsHumanReviewReasons.join("；"));
        }
      });

      await step("②", "落地教师角色蓝本（promote）", async () => {
        if (!teacherReport) throw new Error("缺少上一步的 generate 报告");
        const promoted = await rt.blueprints.promote(teacherReport.stagingId);
        console.log("  targetId:", promoted.targetId);
        console.log("  blueprintDir:", promoted.blueprintDir);
        console.log("  provenancePath:", promoted.provenancePath);
      });

      await step("③", "生成并落地图书馆设施蓝本（facility）", async () => {
        const report = await rt.blueprints.generate({
          description: "（示例）一座安静的图书馆设施",
          kind: "facility",
          suggestedId: "demo-library",
          model,
        });
        console.log("  stagingId:", report.stagingId);
        console.log("  files:", report.files.map((f) => f.path).join(", "));
        console.log("  validation.ok:", report.validation.ok);
        console.log("  needsHumanReview:", report.needsHumanReview);

        const promoted = await rt.blueprints.promote(report.stagingId);
        taught = promoted;
        console.log("  targetId:", promoted.targetId);
        console.log("  blueprintDir:", promoted.blueprintDir);
        console.log("  provenancePath:", promoted.provenancePath);
      });

      await step("④", "用落地蓝本创建设施 Agent（facilities.create）", async () => {
        if (!taught) throw new Error("缺少上一步的 promote 结果");
        const created = await rt.facilities.create({
          facilityId: "library",
          blueprint: taught.blueprintDir,
          displayName: "图书馆",
        });
        console.log("  facilityId:", created.facilityId);
        console.log("  blueprintId:", created.blueprintId);
        console.log("  promptVersion:", created.promptVersion);
        console.log("  blueprintHash:", created.blueprintHash);
        console.log("  accountId:", created.accountId);
        console.log("  endpointId:", created.endpointId);
      });

      await step("⑤", "角色 × 设施同场跑一轮（completeness）", async () => {
        await registerPersona(rt, ctx.root, "infp");
        await rt.scenes.create({
          sceneId: "demo-role-and-facility",
          participants: [
            { agentId: "infp", role: "student" },
            { agentId: "library", role: "facility" },
          ],
          maxTurns: 1,
        });
        const ran = await rt.scenes.run("demo-role-and-facility", undefined, { maxTurns: 1 });
        console.log("  stopReason:", ran.stopReason, "· turnsCompleted:", ran.turnsCompleted);
        const closed = await rt.scenes.close("demo-role-and-facility");
        console.log("  closed.dissolved:", closed.dissolved);
        console.log("  说明：角色（infp）与设施（library）已共存于同一 runtime / 同一场景。");
      });
    } finally {
      await rt.close();
    }
  },
};