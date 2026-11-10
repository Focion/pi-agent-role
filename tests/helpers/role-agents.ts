// ═══════════════════════════════════════════════════════════════════════════
// 测试共用：走公开 agents.create()（而非 P0 后门 registerAgent）注册 role agent。
//
// 为什么非要 agents.create()：R30/G4 devMode 关场校验会跑 A1「owner_agent 必须命中
// agents 行」。P0 后门 registerAgent 只登记 mesh Account + registry、不落 agents 行
// （agents.blueprint_dir/blueprint_hash NOT NULL，后门无蓝本，落行=伪造），于是 A1 恒
// 命中。这里用 6 个冷启动文件的最小蓝本走正式 create：落 agents 行 + 自省流账号，
// initiate 含 task/event（角色发 scene_end 自省 cue 需要 task，A04）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stringifyYaml } from "../../src/compile/yaml.js";
import type { RuntimeInternals } from "../../src/runtime/runtime.js";

/** 写一个最小身份蓝本模板（§5.1 严格校验的 6 个冷启动文件齐整）。返回相对 root 的路径。 */
export function writeRoleBlueprint(root: string, name = "role"): string {
  const dir = join(root, "templates", name);
  mkdirSync(dir, { recursive: true });
  const files: [string, unknown][] = [
    [
      "manifest.yaml",
      {
        identity: { id: `id-${name}` },
        files: ["manifest", "personal", "constraints", "evolution", "narrative_voice", "agent_protocol"].map(
          (n) => ({ path: `${n}.yaml`, priority: "cold_start" }),
        ),
      },
    ],
    ["personal.yaml", { name: { full: "代理人" }, age: 30, gender: "female", role: "角色" }],
    ["constraints.yaml", { constraints: [{ id: "c1", text: "合规", severity: "hard" }] }],
    ["evolution.yaml", { mood: "平静", moodIntensity: 0.5, energy: 0.8 }],
    ["narrative_voice.yaml", { default_mode: "平实" }],
    ["agent_protocol.yaml", { capabilities: ["通用"], initiate: ["chat", "task", "event"] }],
  ];
  for (const [fname, data] of files) writeFileSync(join(dir, fname), stringifyYaml(data));
  return `templates/${name}`;
}

/** 走公开 agents.create() 注册一个 role agent；accountId 恒等 agentId（§4.2.1）。 */
export async function createRoleAgent(
  rt: RuntimeInternals,
  blueprint: string,
  agentId: string,
  displayName?: string,
): Promise<{ accountId: string }> {
  await rt.agents.create({ blueprint, agentId, displayName });
  return { accountId: agentId };
}