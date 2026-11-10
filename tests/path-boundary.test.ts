// ═══════════════════════════════════════════════════════════════════════════
// 文件边界回归（R02 / A01 / A02 / A15 / A16）
//
// 逐条锁定统一审计计划登记的反例：路径穿越（agentId / overlay 维度 / stagingId /
// targetId）在拼路径前被拒；物化半成品在失败时自清理（同 ID 可重试）；promote 的
// provenance 元数据保留到 rename 提交之后（rename 前失败不丢，可重试）。
//
// 全部走确定性假模型，不触达真实 LLM。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { materialize } from "../src/compile/materialize.js";
import { stringifyYaml } from "../src/compile/yaml.js";
import { createBlueprintAuthor } from "../src/authoring/driver.js";
import type { AuthorModel, AuthorModelResponse } from "../src/authoring/types.js";

const cleanups: string[] = [];
function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-bound-"));
  cleanups.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

/** 最小蓝本目录：manifest + personal，足够 materialize 复制。 */
function writeBlueprint(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), stringifyYaml({ identity: { id: "id-min" }, files: [] }));
  writeFileSync(join(dir, "personal.yaml"), stringifyYaml({ name: { full: "测试" }, role: "tester" }));
}

const teacherModel: AuthorModel = {
  name: "deterministic",
  async generate(): Promise<AuthorModelResponse> {
    return { files: {} };
  },
};

describe("文件边界（R02 / A01 / A02 / A15 / A16）", () => {
  it("A01 materialize 拒绝 agentId 路径穿越，不越出 root 写文件", async () => {
    const root = setup();
    const bp = join(root, "bp");
    writeBlueprint(bp);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });

    await expect(
      materialize({ blueprintDir: bp, root, agentId: "../../outside", overlay: undefined }),
    ).rejects.toThrow(/invalid agentId/);

    // 越界目录没有被当成目标写进任何文件
    expect(readdirSync(outside)).toEqual([]);
  });

  it("A01 materialize 拒绝 overlay 维度名路径穿越", async () => {
    const root = setup();
    const bp = join(root, "bp");
    writeBlueprint(bp);

    await expect(
      materialize({ blueprintDir: bp, root, agentId: "a1", overlay: { "../escape": { x: 1 } } }),
    ).rejects.toThrow(/invalid overlay dimension/);
  });

  it("A15 物化失败自清理半成品，同 agentId 可重试", async () => {
    const root = setup();
    const bp = join(root, "bp");
    writeBlueprint(bp);

    // 覆盖不存在的维度 → cp 已成功但 overlay 抛错，物化须自清理 identityDir
    await expect(
      materialize({ blueprintDir: bp, root, agentId: "a1", overlay: { ghost: { x: 1 } } }),
    ).rejects.toThrow();
    expect(existsSync(join(root, "agents", "a1", "identity"))).toBe(false);

    // 清理后同 ID 重试成功（不再被「已存在」卡死）
    const ok = await materialize({ blueprintDir: bp, root, agentId: "a1", overlay: undefined });
    expect(ok.filesCopied.length).toBeGreaterThan(0);
  });

  it("A02 promote 拒绝 stagingId 与 targetId 路径穿越", async () => {
    const root = setup();
    const author = createBlueprintAuthor({ root });

    await expect(author.promote("../../outside")).rejects.toThrow(/invalid stagingId/);

    const report = await author.generate({
      description: "这是一名老师，今年三十岁。",
      kind: "identity",
      model: teacherModel,
    });
    await expect(author.promote(report.stagingId, { targetId: "../../../outside" })).rejects.toThrow(
      /invalid targetId/,
    );
    // 穿越目标未落盘
    expect(existsSync(join(root, "templates"))).toBe(false);
  });

  it("A16 promote 的 provenance 元数据保留到 rename 提交之后，rename 前失败可重试", async () => {
    const root = setup();
    const author = createBlueprintAuthor({ root });
    const report = await author.generate({
      description: "这是一名老师，今年三十岁。",
      kind: "identity",
      suggestedId: "teacher-a16",
      model: teacherModel,
    });

    // 让 mkdir(templateRoot) 失败：把 <root>/templates 占成文件 → ENOTDIR
    writeFileSync(join(root, "templates"), "not a dir");
    await expect(author.promote(report.stagingId)).rejects.toThrow();

    // 关键不变量：失败后 staging 的 provenance 元数据仍完整（未被 rename 前删掉）
    expect(existsSync(join(root, "staging", report.stagingId, ".provenance-meta.json"))).toBe(true);

    // 移除阻塞后同 stagingId 重试成功，且隐藏元数据不随 rename 进入蓝本目录
    rmSync(join(root, "templates"), { force: true });
    const result = await author.promote(report.stagingId);
    expect(result.targetId).toBe("teacher-a16");
    expect(existsSync(result.blueprintDir)).toBe(true);
    expect(existsSync(join(result.blueprintDir, ".provenance-meta.json"))).toBe(false);
  });
});