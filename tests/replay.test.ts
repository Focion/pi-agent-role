// ═══════════════════════════════════════════════════════════════════════════
// R37/R38 回放与比较（H03）——记录回放 + 隔离重执行 + 结构化比较
//
// 覆盖：
//   REP-1 record 只读已保存的逐轮判定 + 检索快照，核对卡片 hash + 指纹 + 缺失标记；
//   REP-2 reexecute 冻结探针脚本独立新环境重跑领域决策，source/指纹/成本正确；
//   REP-3 reexecute 确定性可重现（两次相同 fixture 比较 sameDecisions/sameMemory）；
//   REP-4 重执行不写原环境（原库 record 前/后一致）。
//
// 分层纪律：本文件不 import @pi/agent-mesh（R1）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/compile/fingerprint.js";
import { openRoleDb, type RoleDb } from "../src/db/db.js";
import { runIsolatedReexecute } from "../src/replay/reexecute.js";
import { compareReplays } from "../src/replay/compare.js";
import { makeReplayApi } from "../src/runtime/replay.js";
import type { AgentFingerprint, ReplayProbeStep } from "../src/replay/types.js";

const NOW = "2026-01-01T00:00:00.000Z";

function seedAgent(db: RoleDb["db"], agentId: string, extra: Partial<Record<string, unknown>> = {}): void {
  db.prepare(
    `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, spec_hash, model_config_json, status, created_at)
     VALUES (?, 'role', '<b>', ?, ?, ?, 'active', ?)`,
  ).run(
    agentId,
    (extra.blueprint_hash as string) ?? "bp-1",
    (extra.spec_hash as string) ?? "spec-1",
    (extra.model_config_json as string | null) ?? null,
    NOW,
  );
}

const FROZEN: AgentFingerprint = { specHash: "spec-frozen", blueprintHash: "bp-frozen", modelConfigHash: null };

const probes = (): ReplayProbeStep[] => [
  { text: "今天讲受力分析", from: "teacher", remember: "受力分析要画受力图" },
  { text: "受力分析要画受力图", from: "teacher" }, // 正文与上轮 gist 相同 → 自动注入命中落 retrieval_log
];

describe("R37 记录回放（record）", () => {
  it("REP-1: 读判定/检索快照 + 卡片 hash 核验 + 指纹 + 缺失标记", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-replay-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      const db = roleDb.db;
      seedAgent(db, "ag", { model_config_json: '{"provider":"fake","model":"fake"}' });

      db.prepare(
        `INSERT INTO memory_decisions
           (owner_agent, source_msg_id, path, score, write_decided, written, nudged, components_json, virtual_ts, decided_at)
         VALUES ('ag', 'm1', 'P1', 0.62, 1, 1, 0, '{"novelty":0.5}', 'W1D1T8', ?),
                ('ag', 'm2', 'P1', 0.11, 0, 0, 1, '{bad-json', 'W1D1T9', ?)`,
      ).run(NOW, NOW);

      const card = "<<<MEMORY x MEMORY>>>";
      db.prepare(
        `INSERT INTO retrieval_log
           (retrieval_id, owner_agent, scene_id, turn, trigger_msg_id, query_json, candidates, selected_json,
            tokens_l2, tokens_l1, tokens_transient, tokens_total, clamped, rendered_card, card_sha256, real_ts, model_config_hash)
         VALUES ('r1', 'ag', 's1', 1, 'm1', '{"query":"数学"}', 2, '["ep1"]', 0, 90, 0, 90, 0, ?, ?, ?, NULL),
                ('r2', 'ag', 's1', 2, 'm2', '{"query":"语文"}', 0, '[]', 0, 0, 0, 0, 0, NULL, NULL, ?, NULL)`,
      ).run(card, sha256Hex(card), NOW, NOW);

      const replay = await makeReplayApi(db).record("ag");
      expect(replay.source).toBe("recorded");
      expect(replay.ownerAgent).toBe("ag");
      expect(replay.fingerprint.specHash).toBe("spec-1");
      expect(replay.fingerprint.modelConfigHash).toBeTruthy();

      expect(replay.turns).toHaveLength(2);
      expect(replay.turns[0]!.fidelity).toBe("full");
      expect(replay.turns[0]!.components).toEqual({ novelty: 0.5 });
      expect(replay.turns[1]!.fidelity).toBe("components_missing");
      expect(replay.turns[1]!.components).toBeNull();

      expect(replay.retrievals).toHaveLength(2);
      const r1 = replay.retrievals.find((r) => r.retrievalId === "r1")!;
      const r2 = replay.retrievals.find((r) => r.retrievalId === "r2")!;
      expect(r1.integrity).toBe("ok");
      expect(r1.selectedIds).toEqual(["ep1"]);
      expect(r2.integrity).toBe("missing_card");

      expect(replay.missing).toEqual(
        expect.arrayContaining(["components_missing:m2", "card_missing:r2"]),
      );
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REP-1b: 卡片 hash 不符 → hash_mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-replay-hash-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      const db = roleDb.db;
      seedAgent(db, "ag");
      db.prepare(
        `INSERT INTO retrieval_log
           (retrieval_id, owner_agent, query_json, candidates, selected_json,
            tokens_l2, tokens_l1, tokens_transient, tokens_total, clamped, rendered_card, card_sha256, real_ts)
         VALUES ('rh', 'ag', '{}', 0, '[]', 0, 0, 0, 0, 0, 'CARD', ?, ?)`,
      ).run(sha256Hex("OTHER"), NOW);

      const replay = await makeReplayApi(db).record("ag");
      expect(replay.retrievals[0]!.integrity).toBe("hash_mismatch");
      expect(replay.missing).toContain("card_hash_mismatch:rh");
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R37 隔离重执行（reexecute）", () => {
  it("REP-2: 冻结探针独立环境重跑 → source/指纹/成本正确，不写原环境", async () => {
    const run = await runIsolatedReexecute({
      fingerprint: FROZEN,
      probes: probes(),
      usagePerStep: { tokensIn: 10, tokensOut: 5 },
    });
    try {
      const replay = run.replay;
      expect(replay.source).toBe("reexecuted");
      expect(replay.fingerprint.specHash).toBe("spec-frozen");
      expect(replay.fingerprint.blueprintHash).toBe("bp-frozen");
      expect(replay.turns).toHaveLength(2);
      expect(replay.turns.filter((t) => t.written)).toHaveLength(1); // 第一轮 remember 落 episode
      // 第二轮正文与上轮 gist 相同 → 自动注入命中落 retrieval_log。
      expect(replay.retrievals.length).toBeGreaterThanOrEqual(1);
      expect(replay.cost).toEqual({ source: "injected", tokensIn: 20, tokensOut: 10, steps: 2 });
      expect(replay.memory.episodes).toBe(1);
    } finally {
      run.dispose();
    }
  });

  it("REP-4: 重执行不改原库（record 前/后一致）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-replay-orig-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      const db = roleDb.db;
      seedAgent(db, "ag");
      db.prepare(
        `INSERT INTO memory_decisions
           (owner_agent, source_msg_id, path, score, write_decided, written, nudged, components_json, virtual_ts, decided_at)
         VALUES ('ag', 'm1', 'P1', 0.5, 1, 1, 0, '{}', 'W1D1T8', ?)`,
      ).run(NOW);

      const before = await makeReplayApi(db).record("ag");

      const run = await runIsolatedReexecute({ fingerprint: FROZEN, probes: probes() });
      run.dispose();

      const after = await makeReplayApi(db).record("ag");
      expect(after.turns).toHaveLength(before.turns.length);
      expect(after.memory.episodes).toBe(before.memory.episodes);
      expect(after.ownerAgent).toBe("ag"); // 重执行 owner 名独立，不落在原库
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R38 结构化比较（compare）", () => {
  it("REP-3: 相同 fixture 两次重执行确定可重现 → sameDecisions/sameMemory", async () => {
    const a = await runIsolatedReexecute({ fingerprint: FROZEN, probes: probes() });
    const b = await runIsolatedReexecute({ fingerprint: FROZEN, probes: probes() });
    try {
      const cmp = compareReplays(a.replay, b.replay);
      expect(cmp.sameDecisions).toBe(true);
      expect(cmp.sameMemory).toBe(true);
      expect(cmp.decisions.find((m) => m.key === "turnCount")!.delta).toBe(0);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("REP-3b: 记忆写与不写 → 结构化差异非零", async () => {
    const wrote = await runIsolatedReexecute({
      fingerprint: FROZEN,
      probes: [{ text: "今天讲受力分析", from: "teacher", remember: "画受力图" }],
    });
    const silent = await runIsolatedReexecute({
      fingerprint: FROZEN,
      probes: [{ text: "今天讲受力分析", from: "teacher" }],
    });
    try {
      const cmp = compareReplays(wrote.replay, silent.replay);
      expect(cmp.memory.find((m) => m.key === "episodes")!.delta).toBe(-1); // silent 少 1 条
      expect(cmp.sameMemory).toBe(false);
    } finally {
      wrote.dispose();
      silent.dispose();
    }
  });
});