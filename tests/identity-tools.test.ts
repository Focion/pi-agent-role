// ═══════════════════════════════════════════════════════════════════════════
// R08 identity_read / protocol_query 工具处理器（§5.3 / 附录 F）
//
// 覆盖：
//   R08-ID-1 白名单段可读：identity_read(section) 返回实例模板文本 + details 源；
//   R08-ID-2 越白名单拒绝：SECTION_NOT_ALLOWED（本环定义，非 mesh 码）；
//   R08-ID-3 入参缺失/非串：ARG_INVALID；
//   R08-ID-4 白名单内但文件被手工删：SECTION_MISSING；
//   R08-PQ-1 protocol_query 返回本人 capabilities/initiate（不读 mesh）；
//   R08-PQ-2 无规程投影：SCOPE_VIOLATION。
//
// 分层纪律：本文件不 import @pi/agent-mesh（R1）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openRoleDb, type RoleDb } from "../src/db/db.js";
import { makeIdentityDomainTools } from "../src/runtime/identity-tools.js";

type SimpleTool = (toolCallId: string, params: Record<string, unknown>) => Promise<{
  content: unknown;
  details?: unknown;
}>;

interface Harness {
  dir: string;
  roleDb: RoleDb;
  root: string;
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-idtools-"));
  const root = join(dir, "work");
  mkdirSync(join(root, "agents", "ag", "identity"), { recursive: true });
  writeFileSync(join(root, "agents", "ag", "identity", "psychology.yaml"), "personality:\n  - 好奇\n", "utf8");
  const roleDb = openRoleDb(join(dir, "role-agent.db"));
  const db = roleDb.db;
  db.prepare(
    `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, identity_dir, registered_projection, status, created_at)
     VALUES ('ag', 'role', '/b', ?, ?, ?, 'active', '2026-01-01T00:00:00.000Z')`,
  ).run(
    "0".repeat(64),
    "agents/ag/identity",
    JSON.stringify({ capabilities: ["question", "kind:role"], initiate: ["chat"] }),
  );
  // 编译期按需白名单：psychology / academic；cloud 不在白名单内。
  for (const [path, kind] of [
    ["psychology.yaml", "lazy"],
    ["academic.yaml", "lazy"],
    ["manifest.yaml", "cold_start"],
  ] as const) {
    db.prepare("INSERT INTO agent_specs (agent_id, spec_path, spec_hash, spec_kind, updated_at) VALUES (?, ?, '', ?, '2026-01-01T00:00:00.000Z')")
      .run("ag", path, kind);
  }
  return { dir, roleDb, root };
}

function codeOf(res: { content: unknown }): { code?: string; message?: string } | null {
  const c = res.content;
  if (Array.isArray(c)) return null;
  if (typeof c !== "string") return null;
  try {
    const parsed = JSON.parse(c) as { error?: { code?: string; message?: string } };
    return parsed.error ?? null;
  } catch {
    return null;
  }
}

describe("identity_read (§5.3 / R08)", () => {
  it("R08-ID-1: 白名单段返回实例模板文本 + source 详情", async () => {
    const { dir, roleDb, root } = setup();
    try {
      const { identity_read } = makeIdentityDomainTools({ db: roleDb.db, root, agentId: "ag" });
      const tool = identity_read as unknown as SimpleTool;
      const res = await tool("c", { section: "psychology" });
      expect(Array.isArray(res.content)).toBe(true);
      expect(((res.content as Array<{ text: string }>)[0]!).text).toContain("好奇");
      expect(res.details).toMatchObject({ section: "psychology", source: "instance_template" });
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R08-ID-2: 越白名单拒绝（本环码 SECTION_NOT_ALLOWED）", async () => {
    const { dir, roleDb, root } = setup();
    try {
      const { identity_read } = makeIdentityDomainTools({ db: roleDb.db, root, agentId: "ag" });
      const tool = identity_read as unknown as SimpleTool;
      const res = await tool("c", { section: "shadow" });
      expect(codeOf(res)?.code).toBe("SECTION_NOT_ALLOWED");
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R08-ID-3: 入参缺失返回 ARG_INVALID", async () => {
    const { dir, roleDb, root } = setup();
    try {
      const { identity_read } = makeIdentityDomainTools({ db: roleDb.db, root, agentId: "ag" });
      const tool = identity_read as unknown as SimpleTool;
      expect(codeOf(await tool("c", {}) )?.code).toBe("ARG_INVALID");
      expect(codeOf(await tool("c", { section: 42 }) )?.code).toBe("ARG_INVALID");
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R08-ID-4: 白名单内但文件缺失 → SECTION_MISSING", async () => {
    const { dir, roleDb, root } = setup();
    try {
      const { identity_read } = makeIdentityDomainTools({ db: roleDb.db, root, agentId: "ag" });
      const tool = identity_read as unknown as SimpleTool;
      // academic.yaml 在白名单，但未写盘。
      const res = await tool("c", { section: "academic" });
      expect(codeOf(res)?.code).toBe("SECTION_MISSING");
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("protocol_query（附录 F 第 5 号 / R08）", () => {
  it("R08-PQ-1: 返回本人 capabilities/initiate", async () => {
    const { dir, roleDb, root } = setup();
    try {
      const { protocol_query } = makeIdentityDomainTools({ db: roleDb.db, root, agentId: "ag" });
      const tool = protocol_query as unknown as SimpleTool;
      const res = await tool("c", { question: "我能不能主动发言" });
      expect(res.details).toMatchObject({ capabilities: ["question", "kind:role"], initiate: ["chat"] });
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R08-PQ-2: 无规程投影 → SCOPE_VIOLATION", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-role-idtools-noprog-"));
    const roleDb = openRoleDb(join(dir, "role-agent.db"));
    try {
      roleDb.db
        .prepare(
          `INSERT INTO agents (agent_id, agent_type, blueprint_dir, blueprint_hash, status, created_at)
           VALUES ('ag', 'role', '/b', ?, 'active', '2026-01-01T00:00:00.000Z')`,
        )
        .run("0".repeat(64));
      const { protocol_query } = makeIdentityDomainTools({ db: roleDb.db, root: dir, agentId: "ag" });
      const tool = protocol_query as unknown as SimpleTool;
      expect(codeOf(await tool("c", {}))?.code).toBe("SCOPE_VIOLATION");
    } finally {
      roleDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});