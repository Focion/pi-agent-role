// ═══════════════════════════════════════════════════════════════════════════
// 交互群聊场景（HEADLINE）：用户发言 → 场景注入旁白 → run 点名角色回复 → 转写打印。
//
// 回复唯一的读路径是 onEvent（公开门面没有 rt.mesh）。这里把 onEvent 交给 Transcript，
// 建场景后用 bind(conversationId) 收窄到本群会话，每轮 speak 后只打印新增行。
//
// floorMode 语义（与本库 src/scene/orchestrator.ts + src/mesh/policies/floor.ts 一致）：
//   round_robin 依次点名（最稳）、director 需显式剧本（这里按 persona 循环）、
//   reactive   按瞬时状态打分挑人、free_for_all 不点名（无人被 cue 唤醒，无回复）。
// ═══════════════════════════════════════════════════════════════════════════

import { createInterface } from "node:readline";

import { openRuntime, registerPersonas } from "./harness.ts";
import { parseFlags, type Scenario, type ScenarioContext } from "./context.ts";
import { personaOf } from "./personas.ts";
import { createTranscript } from "./transcript.ts";

const DEFAULT_PERSONAS = ["intj", "enfp", "istj", "infp"];
const FLOOR_MODES = ["round_robin", "director", "reactive", "free_for_all"] as const;
type Floor = (typeof FLOOR_MODES)[number];

type Rt = Awaited<ReturnType<typeof openRuntime>>;

function strFlag(v: string | true | undefined, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function intFlag(v: string | true | undefined, fallback: number): number {
  if (typeof v !== "string") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parsePersonas(v: string | true | undefined): string[] {
  const raw = strFlag(v, DEFAULT_PERSONAS.join(","));
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (ids.length === 0) return [...DEFAULT_PERSONAS];
  for (const id of ids) personaOf(id); // unknown id 抛出带候选的讯息
  return ids;
}

function parseFloor(v: string | true | undefined): Floor {
  const raw = strFlag(v, "round_robin");
  if ((FLOOR_MODES as readonly string[]).includes(raw)) return raw as Floor;
  throw new Error(`unknown --floor "${raw}"（可选：${FLOOR_MODES.join("/")}）`);
}

/** director 剧本：按选定 persona 顺序循环点名。 */
function directorScriptFor(ids: string[]): { loop: true; steps: Array<{ target: string }> } {
  return { loop: true, steps: ids.map((id) => ({ target: id })) };
}

interface ChatSetup {
  personaIds: string[];
  turns: number;
  floor: Floor;
  scripted?: string[];
}

// 有界 settle-drain 参数：run() 返回后转写若仍在增长，就按 count() 轮询去抖再打印。
const SETTLE_QUIET_MS = 300; // 静默窗口：无新行满该时长即视为本轮回复已落定
const SETTLE_MAX_MS = 2500; // 总等待上限（兜底防挂起）
const SETTLE_POLL_MS = 100; // 轮询间隔

/**
 * 有界 settle-drain：scenes.run() 返回后，把晚到的 message_routed（真实模型回复）
 * 一并纳入本轮转写再打印。个别回复会晚于 run() 返回才上浮（在途交付），单次
 * macrotask 让位不够；这里按 transcript.count() 轮询去抖：
 *   - 静默窗口从“最近一次观察到新行”的时刻起算，满 quietMs 无新增即落定；
 *   - 初始把“上一次新增”记为 quietMs 之前，因此 run() 返回后首个无新增的空轮
 *     即满足静默窗口（fake 模式没有晚到回复，立刻退出并照常打印摘要）；
 *   - 总等待超过 maxMs 强制退出，任何模式下都不会挂起。
 */
async function settleTranscript(
  transcript: ReturnType<typeof createTranscript>,
  opts: { quietMs?: number; maxMs?: number; pollMs?: number } = {},
): Promise<void> {
  const { quietMs = SETTLE_QUIET_MS, maxMs = SETTLE_MAX_MS, pollMs = SETTLE_POLL_MS } = opts;
  const started = Date.now();
  let lastCount = transcript.count();
  // 视作上次新增发生在 quietMs 前，好让首个空轮即可判稳（fake/已即时落定）。
  let lastGrowthAt = started - quietMs;

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const now = Date.now();
    const count = transcript.count();
    if (count !== lastCount) {
      lastCount = count;
      lastGrowthAt = now;
    }
    if (now - lastGrowthAt >= quietMs) return;
    if (now - started >= maxMs) return;
  }
}

async function runChat(rt: Rt, ctx: ScenarioContext, setup: ChatSetup, transcript: ReturnType<typeof createTranscript>): Promise<void> {
  const { personaIds, turns, floor, scripted } = setup;

  await registerPersonas(rt, ctx.root, personaIds);

  const sceneId = "group-chat";
  const est = await rt.scenes.create({
    sceneId,
    name: "MBTI 群聊",
    participants: personaIds.map((agentId) => ({ agentId, role: "student" as const })),
    floorMode: floor,
    ...(floor === "director" ? { script: directorScriptFor(personaIds) } : {}),
  });
  transcript.bind(est.conversationId);

  const roster = personaIds.map((id) => personaOf(id).displayName).join("、");
  console.log(`\n已入群（${personaIds.length} 位）：${roster}`);
  console.log(`floor=${floor} · 每条消息点名 ${turns} 轮；输入 /exit 退出`);
  if (floor === "free_for_all") console.log("[提示] free_for_all 不点名、无人被 cue 唤醒，因此角色不会回复（只会看到你的旁白）。");
  console.log("");

  let cursor = 0;
  let msgIndex = 0;
  let totalTurns = 0;
  let lastTokensCumulative = 0;

  const speak = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;
    msgIndex += 1;
    await rt.scenes.inject({ sceneId, injectId: `u${msgIndex}`, text });
    const res = await rt.scenes.run(sceneId, undefined, { maxTurns: turns });
    totalTurns += res.turnsCompleted;
    lastTokensCumulative = res.tokensCumulative;
    // 等晚到的 message_routed（真实模型回复）落定后再读新增行：单次 macrotask 不够，
    // 用有界 settle-drain 等转写停更（静默 SETTLE_QUIET_MS、上限 SETTLE_MAX_MS）。
    await settleTranscript(transcript);
    transcript.print(transcript.since(cursor));
    cursor = transcript.count();
  };

  if (scripted) {
    for (const msg of scripted) {
      if (msg.trim() === "/exit") break;
      await speak(msg);
    }
  } else if (!process.stdin.isTTY) {
    // stdin 被管道/重定向：读所有行直到 EOF，/exit 提前退出。
    const rl = createInterface({ input: process.stdin, terminal: false });
    for await (const line of rl) {
      if (line.trim() === "/exit") break;
      await speak(line);
    }
    rl.close();
  } else {
    // 交互式 TTY：逐行提示。
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const question = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));
    for (;;) {
      const line = await question("你 > ");
      const t = line.trim();
      if (t === "/exit" || t === "/quit") break;
      await speak(t);
    }
    rl.close();
  }

  console.log("");
  console.log("——— 摘要 ———");
  console.log(`用户消息      ：${msgIndex}`);
  console.log(`角色轮次累计  ：${totalTurns}`);
  console.log(`token 累计    ：${lastTokensCumulative}（末次 run 报告的 scenes.token_spent）`);
  console.log("角色展示名映射：");
  for (const id of personaIds) {
    const p = personaOf(id);
    console.log(`  ${p.id.padEnd(6)} ${p.mbti.padEnd(5)} ${p.title}（${p.displayName}）`);
  }
}

export const scenario: Scenario = {
  name: "chat",
  description: "MBTI 群聊：你发消息，角色按各自人格互相回复",
  async run(ctx: ScenarioContext): Promise<void> {
    const flags = parseFlags(ctx.argv);
    const setup: ChatSetup = {
      personaIds: parsePersonas(flags["personas"]),
      turns: Math.max(0, intFlag(flags["turns"], 2)),
      floor: parseFloor(flags["floor"]),
      scripted:
        typeof flags["messages"] === "string"
          ? flags["messages"].split("|").map((s) => s.trim()).filter((s) => s.length > 0)
          : undefined,
    };

    if (ctx.fake) {
      console.log("[fake] 无 LLM 冒烟：角色不会产出真实回复，只会看到旁白与点名 cue（正文为空）。");
    }

    const transcript = createTranscript();
    const rt = await openRuntime({
      root: ctx.root,
      db: ctx.db,
      config: ctx.config ?? null,
      fake: ctx.fake,
      onEvent: (e) => transcript.onEvent(e),
    });

    try {
      await runChat(rt, ctx, setup, transcript);
    } finally {
      await rt.close();
    }
  },
};