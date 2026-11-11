// ═══════════════════════════════════════════════════════════════════════════
// DIF08 · 只经公开入口走真实 SDK 闭环（重启 + 换模型，历史 hash 不变）
//
// 与 `real-model.test.ts` 的区别：本文件只用 `createRuntime`（公开入口）与公开 `Runtime`
// 门面（agents / scenes / replay / close），不 import `createRuntimeInternals`、不 touch
// `rt.mesh` / `rt.registry` / `rt.registerAgent` 等内部句柄——证明候选包对外能被宿主驱动走完
// 真实生成 + 重启恢复 + 换模型，且「历史 hash」（蓝本血缘 blueprint_hash + 身份 spec_hash）
// 在重启与换模型后都不变（只有 model_config hash 在换模型时按 R06/E09 变化）。
//
// 卫兵：`PI_ROLE_REAL_MODEL=1` 才拨真实模型（凭据读 `../pi-agent-mesh/examples/demo.config.json`，
// 不落盘、不复写、不提交）；未设置 / 缺凭据时整体 skip，CI / 无凭据环境零费用。
// ═══════════════════════════════════════════════════════════════════════════

// 卫兵顺序：pi-ai 顶层运行值经动态 import 延迟装载（clipboard 原生模块），
// TERMUX_VERSION 须在任何 pi import 之前就绪。
process.env.TERMUX_VERSION ??= "1";

import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type AgentFingerprint, type Runtime } from "../src/index.js";
import type { ModelCredential } from "../src/mesh/pi-backend.js";
import { writeRoleBlueprint } from "./helpers/role-agents.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempdir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pi-role-dif08-"));
  tmpDirs.push(d);
  return d;
}

interface RealModelConfig {
  provider: string;
  modelId: string;
  credential: ModelCredential;
}

/** 读 mesh 演示配置（不落盘凭据）。找不到 / 缺 apiKey 时返回 null 以 skip。 */
function loadDemoConfig(): RealModelConfig | null {
  const candidates = [
    join(process.cwd(), "..", "pi-agent-mesh", "examples", "demo.config.json"),
    join(process.cwd(), "examples", "demo.config.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8")) as {
        llm?: { model?: string; providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: string }> };
      };
      const model = cfg.llm?.model ?? "";
      const colon = model.indexOf(":");
      if (colon <= 0) continue;
      const provider = model.slice(0, colon).trim();
      const modelId = model.slice(colon + 1).trim();
      const pconf = cfg.llm?.providers?.[provider];
      if (!provider || !modelId || !pconf?.apiKey) continue;
      return {
        provider,
        modelId,
        credential: {
          type: "api_key",
          key: pconf.apiKey,
          baseUrl: pconf.baseUrl,
          api: pconf.api ?? "openai-completions",
        },
      };
    } catch {
      continue;
    }
  }
  return null;
}

const real = process.env.PI_ROLE_REAL_MODEL ? loadDemoConfig() : null;

describe.skipIf(real === null)("DIF08 只经公开入口走真实 SDK 闭环", () => {
  function open(dir: string, db: string): Promise<Runtime> {
    // 公开入口 createRuntime；fake:{} ⇒ 真实 PiStreamPort + InProcessTransport + 真实 pi backend。
    return createRuntime({
      root: dir,
      db,
      fake: {},
      modelDefaults: { dialogue: { provider: real!.provider, modelId: real!.modelId, thinkingLevel: "off" } },
      credentialFor: (p) => (p === real!.provider ? real!.credential : undefined),
    });
  }

  it("create → 真实 run → 重启 → 换模型：blueprint/spec hash 不变，model_config hash 仅换模型时变", async () => {
    const dir = await tempdir();
    const db = join(dir, "role-agent.db");
    const blueprint = writeRoleBlueprint(dir, "role");
    const agentId = "teacher";

    // ① 公开入口建 agent + 一轮真实生成（真实闭环），拿到 initial 指纹。
    let f1: AgentFingerprint;
    {
      const rt = await open(dir, db);
      try {
        const created = await rt.agents.create({ blueprint, agentId, displayName: "王老师" });
        expect(created.blueprintHash).toBeTruthy();

        await rt.scenes.create({
          sceneId: "s1",
          participants: [{ agentId, role: "teacher" }],
          floorMode: "director",
          maxTurns: 1,
        });
        const res = await rt.scenes.run("s1", undefined, { maxTurns: 1 });
        // A07：真实生成带回非零用量（否则是注入缝或假借内部句柄救场）。
        expect(res.tokensCumulative).toBeGreaterThan(0);

        const fpr = (await rt.replay.record(agentId)).fingerprint;
        expect(fpr.blueprintHash).toBe(created.blueprintHash);
        expect(fpr.specHash).toBeTruthy();
        expect(fpr.modelConfigHash).toBeTruthy();
        f1 = fpr;
      } finally {
        await rt.close();
      }
    }

    // ② 重启：同一 root/db 重开（恢复期），历史 hash 不变，model_config hash 亦不变。
    let f2: AgentFingerprint;
    {
      const rt = await open(dir, db);
      try {
        f2 = (await rt.replay.record(agentId)).fingerprint;
      } finally {
        await rt.close();
      }
    }
    expect(f2.blueprintHash).toBe(f1.blueprintHash);
    expect(f2.specHash).toBe(f1.specHash);
    expect(f2.modelConfigHash).toBe(f1.modelConfigHash);

    // ③ 换模型：setModelConfig 只改模型段，历史（blueprint/spec）不变，仅 model_config hash 变化（R06/E09）。
    let f3: AgentFingerprint;
    {
      const rt = await open(dir, db);
      try {
        const switched = rt.agents.setModelConfig(agentId, { dialogue: { modelId: `${real!.modelId}-switched` } });
        expect(switched.modelConfig.dialogue.modelId).toBe(`${real!.modelId}-switched`);
        f3 = (await rt.replay.record(agentId)).fingerprint;
      } finally {
        await rt.close();
      }
    }
    expect(f3.blueprintHash).toBe(f1.blueprintHash); // 历史 hash 不变
    expect(f3.specHash).toBe(f1.specHash); // 身份 hash 不变
    expect(f3.modelConfigHash).not.toBe(f1.modelConfigHash); // 只有模型配置 hash 变
  }, 120_000);
});