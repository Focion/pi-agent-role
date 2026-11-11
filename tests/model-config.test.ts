// ═══════════════════════════════════════════════════════════════════════════
// R06 运行期模型覆盖（§5.4 / E09）—— applyRuntimeModelOverride 纯函数 + setModelConfig 集成
//
// 覆盖：
//   R06-1  dialogue 覆盖 → runtime_override 层，未覆盖叶子保持原层，不 mutate 入参；
//   R06-2  reflection 覆盖独立于 dialogue，继承叶子保留（存库时 reflection 已整株物化）；
//   R06-3  budget 覆盖（tokenBudgetTotal 等）→ runtime_override；
//   R06-4  setModelConfig 写回 DB + 返回定稿配置/来源，并回调主/自省账号同步内存绑定；
//   R06-5  只改模型段：spec_hash / identity 相关列不受影响（独立于 respec）；
//   R06-6  不存在 / 无模型配置的 agent → ValidationError。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyRuntimeModelOverride } from "../src/compile/model-resolver.js";
import type { ModelConfig, ModelConfigSource } from "../src/compile/types.js";
import { modelConfigHash } from "../src/compile/fingerprint.js";
import { openRoleDb } from "../src/db/db.js";
import { KnowledgeDao } from "../src/knowledge/dao.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { MemoryDao } from "../src/memory/dao.js";
import { ReflectionDao } from "../src/reflect/dao.js";
import { makeAgentApi } from "../src/runtime/agents.js";
import { ValidationError } from "../src/runtime/errors.js";

function baseConfig(): ModelConfig {
  return {
    dialogue: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "low" },
    reflection: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "low" },
    budget: { onExceed: "warn" },
  };
}

function baseSource(): ModelConfigSource {
  return {
    "dialogue.provider": "runtime_default",
    "dialogue.modelId": "runtime_default",
    "dialogue.thinkingLevel": "runtime_default",
    "reflection.provider": "runtime_default",
    "reflection.modelId": "runtime_default",
    "reflection.thinkingLevel": "runtime_default",
    "budget.onExceed": "runtime_default",
  };
}

describe("applyRuntimeModelOverride (§5.4 R06)", () => {
  it("R06-1: dialogue override marks runtime_override, leaves untouched and inputs unmutated", () => {
    const current = baseConfig();
    const source = baseSource();
    const { modelConfig, source: nextSource } = applyRuntimeModelOverride(current, source, {
      dialogue: { modelId: "claude-opus-5", temperature: 0.4 },
    });
    expect(modelConfig.dialogue.modelId).toBe("claude-opus-5");
    expect(modelConfig.dialogue.temperature).toBe(0.4);
    expect(nextSource["dialogue.modelId"]).toBe("runtime_override");
    expect(nextSource["dialogue.temperature"]).toBe("runtime_override");
    // 未覆盖叶子保持原层。
    expect(nextSource["dialogue.provider"]).toBe("runtime_default");
    expect(nextSource["dialogue.thinkingLevel"]).toBe("runtime_default");
    // reflection 未被 dialogue 覆盖波及，仍整株独立可改。
    expect(modelConfig.reflection?.modelId).toBe("claude-sonnet-5");
    // 入参零突变。
    expect(current.dialogue.modelId).toBe("claude-sonnet-5");
    expect(source).toEqual(baseSource());
  });

  it("R06-2: reflection override is independent and keeps inherited leaves", () => {
    const current = baseConfig();
    const source = baseSource();
    const { modelConfig, source: nextSource } = applyRuntimeModelOverride(current, source, {
      reflection: { thinkingLevel: "high" },
    });
    expect(modelConfig.reflection?.thinkingLevel).toBe("high");
    expect(modelConfig.reflection?.modelId).toBe("claude-sonnet-5"); // 继承叶子保留
    expect(nextSource["reflection.thinkingLevel"]).toBe("runtime_override");
    expect(nextSource["reflection.modelId"]).toBe("runtime_default");
    expect(nextSource["dialogue.thinkingLevel"]).toBe("runtime_default"); // 主帐完全不动
  });

  it("R06-3: budget override marks runtime_override", () => {
    const { modelConfig, source } = applyRuntimeModelOverride(baseConfig(), baseSource(), {
      budget: { tokenBudgetTotal: 100000, onExceed: "halt" },
    });
    expect(modelConfig.budget.tokenBudgetTotal).toBe(100000);
    expect(modelConfig.budget.onExceed).toBe("halt");
    expect(source["budget.tokenBudgetTotal"]).toBe("runtime_override");
    expect(source["budget.onExceed"]).toBe("runtime_override");
  });
});

describe("agents.setModelConfig (§5.4 / E09 integration)", () => {
  it("R06-4 .. R06-5: writes back model-only override and notifies main/reflect account sync", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-setmodel-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      const now = "2026-01-01T00:00:00.000Z";
      roleDb.db
        .prepare(
          `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at,
                               mesh_account_id, mesh_reflect_account_id, spec_hash,
                               model_config_json, model_config_source_json)
           VALUES (?, 'role', '/b', ?, 'active', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ag",
          "0".repeat(64),
          now,
          "acct-ag",
          "acct-ag:reflect",
          "specHASH",
          JSON.stringify(baseConfig()),
          JSON.stringify(baseSource()),
        );

      const knowledge = new KnowledgeService({
        dao: new KnowledgeDao(roleDb.db, { nowReal: () => now }),
        knownAgents: () => new Set<string>(),
      });
      const notified: Array<{ mainAccountId: string | null; reflectAccountId: string | null }> = [];
      const api = makeAgentApi({
        root: dir,
        roleDb: roleDb.db,
        knowledge,
        pairingId: "p-setmodel-test",
        registerProjection: async () => ({ accountId: "acct-ag", endpointId: "ep" }),
        registerReflect: async () => ({
          reflectAccountId: "acct-ag:reflect",
          reflectEndpointId: "ep-r",
          reflectConversationId: "conv-r",
        }),
        onModelConfigUpdated: (input) =>
          notified.push({ mainAccountId: input.mainAccountId, reflectAccountId: input.reflectAccountId }),
      });

      const result = api.setModelConfig("ag", {
        dialogue: { modelId: "claude-opus-5", temperature: 0.2 },
        reflection: { thinkingLevel: "off" },
      });

      expect(result.modelConfig.dialogue.modelId).toBe("claude-opus-5");
      expect(result.modelConfig.dialogue.temperature).toBe(0.2);
      expect(result.modelConfig.reflection?.thinkingLevel).toBe("off");
      expect(result.modelConfigSource["dialogue.modelId"]).toBe("runtime_override");
      expect(result.modelConfigSource["reflection.thinkingLevel"]).toBe("runtime_override");

      // DB 已写回。
      const row = roleDb.db
        .prepare("SELECT model_config_json, model_config_source_json, spec_hash FROM agents WHERE agent_id = ?")
        .get("ag") as { model_config_json: string; model_config_source_json: string; spec_hash: string | null };
      expect(JSON.parse(row.model_config_json).dialogue.modelId).toBe("claude-opus-5");
      expect(JSON.parse(row.model_config_source_json)["dialogue.modelId"]).toBe("runtime_override");
      // 只改模型段：spec_hash 不动（独立于 respec）。
      expect(row.spec_hash).toBe("specHASH");

      // 主/自省账号都得以同步。
      expect(notified).toEqual([{ mainAccountId: "acct-ag", reflectAccountId: "acct-ag:reflect" }]);
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R06-6: unknown agent throws ValidationError", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-setmodel-miss-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      const knowledge = new KnowledgeService({
        dao: new KnowledgeDao(roleDb.db, { nowReal: () => new Date().toISOString() }),
        knownAgents: () => new Set<string>(),
      });
      const api = makeAgentApi({
        root: dir,
        roleDb: roleDb.db,
        knowledge,
        pairingId: "p",
        registerProjection: async () => ({ accountId: "x", endpointId: "e" }),
        registerReflect: async () => ({ reflectAccountId: "x:r", reflectEndpointId: "e-r", reflectConversationId: "c" }),
        onModelConfigUpdated: () => {},
      });
      expect(() => api.setModelConfig("nope", { dialogue: { modelId: "claude-opus-5" } })).toThrow(ValidationError);
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("model_config_hash 写入（§5.4 E09）", () => {
  function insertAgent(db: ReturnType<typeof openRoleDb>["db"], agentId: string, modelConfigJson: string | null): void {
    db.prepare(
      `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at, model_config_json)
       VALUES (?, 'role', '/b', ?, 'active', '2026-01-01T00:00:00.000Z', ?)`,
    ).run(agentId, "0".repeat(64), modelConfigJson);
  }

  it("E09-1: 情节/自省/检索/知识写实际配置哈希；无配置 agent 标 null 不伪造", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-cfghash-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      const db = roleDb.db;
      const cfg = baseConfig();
      insertAgent(db, "ag", JSON.stringify(cfg));
      const expected = modelConfigHash(cfg);
      const nowReal = (): string => "2026-01-01T00:00:00.000Z";

      // 情节
      const mem = new MemoryDao(db, { nowReal });
      mem.insertEpisode({
        episodeId: "ep1",
        ownerAgent: "ag",
        kind: "fact",
        gist: "g",
        salience: 1,
        confidence: 0.5,
        virtualTs: "W1D1T1",
        virtualHours: 1,
        retention: 1,
        subjects: [],
      });
      expect((db.prepare("SELECT model_config_hash AS h FROM episodes WHERE episode_id = 'ep1'").get() as { h: string | null }).h).toBe(expected);

      // 自省
      const refl = new ReflectionDao({ db, nowReal });
      refl.insertReflection({
        reflectionId: "r1",
        ownerAgent: "ag",
        trigger: "manual",
        sceneId: null,
        reflectMsgId: null,
        inputJson: "{}",
        status: "running",
        startedAt: nowReal(),
      });
      expect((db.prepare("SELECT model_config_hash AS h FROM reflections WHERE reflection_id = 'r1'").get() as { h: string | null }).h).toBe(expected);

      // 检索日志
      mem.insertRetrievalLog({
        ownerAgent: "ag",
        queryJson: "{}",
        candidates: 1,
        selectedJson: "{}",
        tokensL2: 0,
        tokensL1: 0,
        tokensTransient: 0,
        tokensPurpose: 0,
        tokensTotal: 0,
        clamped: 1,
        renderedCard: "card",
        cardSha256: "s",
      });
      const rl = db.prepare("SELECT model_config_hash AS h FROM retrieval_log").get() as { h: string | null };
      expect(rl.h).toBe(expected);

      // 知识（applyChange isNew + seedItem）
      const kn = new KnowledgeDao(db, { nowReal });
      kn.applyChange({
        owner: "ag",
        knId: "kn1",
        topic: "t1",
        claim: "c1",
        isNew: true,
        mastery: "heard",
        confidence: 0.5,
        practiceCount: 0,
        lastPracticedVhours: 0,
        lastPracticedAt: null,
        retention: 1.0,
        isMisconception: 0,
        wrongBelief: null,
        taughtBy: "self",
        sourceKind: "episode",
        firstSeenAt: nowReal(),
        events: [],
      });
      expect((db.prepare("SELECT model_config_hash AS h FROM knowledge_items WHERE kn_id = 'kn1'").get() as { h: string | null }).h).toBe(expected);

      // 无配置 agent（无 agents 行）→ null，不伪造
      mem.insertEpisode({
        episodeId: "ep2",
        ownerAgent: "ghost",
        kind: "fact",
        gist: "g2",
        salience: 1,
        confidence: 0.5,
        virtualTs: "W1D1T1",
        virtualHours: 1,
        retention: 1,
        subjects: [],
      });
      expect((db.prepare("SELECT model_config_hash AS h FROM episodes WHERE episode_id = 'ep2'").get() as { h: string | null }).h).toBeNull();
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});