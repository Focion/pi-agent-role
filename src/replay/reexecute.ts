// ═══════════════════════════════════════════════════════════════════════════
// 隔离重执行（H03/R37 ②）：冻结探针脚本 → 独立新 role 库固定条件重跑领域决策
//
// · 不复制 mesh 会话/投递权威状态、不等待 forkAt、不重编译模型、不调真模型；
// · 冻结的是「领域决策机制」：起轮打分 → （可选）固定 remember/recall/note_self →
//   轮终结算，虚拟时间与预算全由探针脚本给定；
// · 原环境（调用方 runtime 的 role 库）从不打开写、从不受影响；重执行结果有自己的
//   身份与来源（source:"reexecuted"），新成本按冻结 usagePerStep 另记，不改原用量。
//
// 分层纪律：不 import @pi/agent-mesh（R1）。MemoryService.attach 消费的探针 mesh
// 只用最小 on/nudge 面，cast 收敛在装配点。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultMemoryPolicy, type MemoryPolicy } from "../compile/types.js";
import { openRoleDb } from "../db/db.js";
import type { KnowledgeService } from "../knowledge/service.js";
import { RoleAccountRegistry } from "../mesh/accounts.js";
import { MemoryDao } from "../memory/dao.js";
import { MemoryService } from "../memory/service.js";
import { advanceVirtualTs } from "../runtime/virtual-clock.js";
import { readDomainDecisionReplay } from "./record.js";
import type { DomainDecisionReplay, ReplayCost, ReplayReexecuteInput, ReplayProbeStep } from "./types.js";

const DEFAULT_VIRTUAL_START = "W1D1T8";

type ToolExecuteLoose = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<{ content: unknown; details?: unknown }>;

interface ProbeRun {
  replay: DomainDecisionReplay;
  /** 关闭临时角色库并删除临时目录。重执行数据已物化进 replay，dispose 之后仍可用。 */
  dispose(): void;
}

/** 冲刷微任务队列：MemoryService 事件处理器内部是 `void asyncFn()`，不阻塞派发。 */
const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

function envelopeOf(step: ReplayProbeStep, i: number, ownerAgent: string, virtualTs: string): Record<string, unknown> {
  return {
    id: `probe-${i}`,
    seq: i,
    from: step.from,
    fromEndpoint: `ep-${step.from}`,
    routedAt: "2026-01-01T00:00:00.000Z",
    idempotencyKey: `k-probe-${i}`,
    conversationId: "conv-reexec",
    kind: "chat",
    expect: "none",
    payload: { text: step.text },
    to: [ownerAgent],
    ext: { virtualTs, sceneId: step.sceneId ?? "scene-reexec", turn: step.turn ?? i + 1 },
  };
}

/**
 * 在独立临时角色库中按冻结探针脚本重跑领域决策，返回重执行回放。
 * 练习完由 caller 调 run.roleDb.close() 并删除临时目录（临时库在系统 tmp 下）。
 */
export async function runIsolatedReexecute(input: ReplayReexecuteInput): Promise<ProbeRun> {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-reexec-"));
  const roleDb = openRoleDb(join(dir, "role-agent.db"));
  const db = roleDb.db;
  // 重执行身份独立：不与原 owner 同名，杜绝「重执行写进原 owner」的可能。
  const ownerAgent = "reexec-owner";
  const stepMinutes = input.stepMinutes ?? 60;
  const usageIn = input.usagePerStep?.tokensIn ?? 0;
  const usageOut = input.usagePerStep?.tokensOut ?? 0;
  const policy: MemoryPolicy = (input.policy as MemoryPolicy | undefined) ?? defaultMemoryPolicy();

  // 冻结指纹落库（agents 行），使随后的 record 读到同一 spec/blueprint 指纹，
  // 证明本次重执行确在冻结 spec 下进行；model_config_json 不重编译故为 NULL。
  db.prepare(
    `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, spec_hash, status, created_at)
     VALUES (?, 'role', '<frozen>', ?, ?, 'active', ?)`,
  ).run(ownerAgent, input.fingerprint.blueprintHash ?? "", input.fingerprint.specHash, "2026-01-01T00:00:00.000Z");

  const registry = new RoleAccountRegistry();
  registry.register({ agentId: ownerAgent, agentType: "role", accountId: ownerAgent, endpointId: `ep-${ownerAgent}` });

  let tick = 0;
  const nowReal = (): string => new Date(Date.UTC(2026, 0, 1) + tick++).toISOString();
  const dao = new MemoryDao(db, { nowReal });
  const service = new MemoryService({
    dao,
    registry,
    knowledge: { learningQueue: () => [], summary: () => "" } as unknown as KnowledgeService,
    policyOf: async () => policy,
  });

  const hooks = new Map<string, (p: unknown) => void>();
  service.attach({
    on: (kind: string, h: (p: unknown) => void) => {
      hooks.set(kind, h);
    },
    nudge: async () => undefined,
  } as unknown as Parameters<MemoryService["attach"]>[0]);

  // 逐步执行探针脚本：起轮 → 固定动作 → 轮终结算；每步冲刷保证异步 ready 就绪。
  let virtualTs = input.virtualStart ?? DEFAULT_VIRTUAL_START;
  let i = 0;
  for (const step of input.probes) {
    virtualTs = step.virtualTs ?? (i === 0 ? virtualTs : advanceVirtualTs(virtualTs, stepMinutes));
    const env = envelopeOf(step, i, ownerAgent, virtualTs);
    hooks.get("message_delivered")?.({ envelope: env, accountId: ownerAgent, path: "P1", woke: true });
    await flush();

    // 模拟真实会话的自动注入：起轮后、模型调用前落一次 retrieval_log（若自动检索候选非空）。
    const ctxHook = service.contextHookFor(ownerAgent);
    await ctxHook({ messages: [] } as unknown as Parameters<typeof ctxHook>[0], undefined);

    const tools = await service.domainHandlersFor(ownerAgent);
    if (step.remember) await (tools.remember as unknown as ToolExecuteLoose)("tc", { gist: step.remember });
    if (step.recall) await (tools.recall as unknown as ToolExecuteLoose)("tc", { query: step.recall });
    if (step.noteSelf) await (tools.note_self as unknown as ToolExecuteLoose)("tc", { text: step.noteSelf });

    hooks.get("message_consumed")?.({ envelope: env, accountId: ownerAgent, partial: false });
    await flush();
    i += 1;
  }

  const replay = readDomainDecisionReplay(db, ownerAgent);
  const cost: ReplayCost = { source: "injected", tokensIn: usageIn * i, tokensOut: usageOut * i, steps: i };
  return {
    replay: { ...replay, source: "reexecuted", cost },
    dispose: () => {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}