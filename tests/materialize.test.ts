// ═══════════════════════════════════════════════════════════════════════════
// materialize 单元测试（§6.1 / 约束 C5）
//
// 覆盖：蓝本复制 → overlay 打补丁（对象递归合并 / null 删键 / 保留旧字段）→
// 蓝本哈希跨 agent 稳定 → 重复物化同一 agentId 抛 ValidationError。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { materialize } from "../src/compile/materialize.js";
import { readYamlFile, stringifyYaml } from "../src/compile/yaml.js";
import { ValidationError } from "../src/runtime/errors.js";

/** 写一份最小蓝本：manifest / personal / agent_protocol 三个维度文件。 */
function writeBlueprint(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), stringifyYaml({ version: "2.0", name: "demo", priority: "normal" }));
  writeFileSync(
    join(dir, "personal.yaml"),
    stringifyYaml({ name: { full: "王小明", given: "小明" }, age: 12, gender: "男" }),
  );
  writeFileSync(join(dir, "agent_protocol.yaml"), stringifyYaml({ capabilities: ["chat"], initiate: ["chat"] }));
}

describe("materialize (§6.1 / C5)", () => {
  it("复制蓝本并返回正确的 identityDir / filesCopied", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-mat-"));
    const blueprintDir = join(root, "blueprint");
    writeBlueprint(blueprintDir);

    const res = await materialize({ blueprintDir, root, agentId: "a1" });

    expect(res.identityDir).toBe(join(root, "agents", "a1", "identity"));
    expect(res.filesCopied).toEqual(["agent_protocol.yaml", "manifest.yaml", "personal.yaml"]);
    expect(res.overlayApplied).toEqual([]);
  });

  it("overlay 递归合并进实例文件，并保留未提字段", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-mat-"));
    const blueprintDir = join(root, "blueprint");
    writeBlueprint(blueprintDir);

    const res = await materialize({
      blueprintDir,
      root,
      agentId: "a2",
      overlay: { personal: { name: { full: "刘明涛" }, age: 15 } },
    });

    expect(res.overlayApplied).toEqual(["personal"]);

    const personal = readYamlFile<{
      name: { full: string; given: string };
      age?: number;
      gender: string;
    }>(join(res.identityDir, "personal.yaml"))!;

    expect(personal.name.full).toBe("刘明涛");
    expect(personal.name.given).toBe("小明"); // 未在 overlay 里的旧字段保留
    expect(personal.age).toBe(15);
    expect(personal.gender).toBe("男"); // 顶层旧字段保留
  });

  it("overlay 里的 null 删除对应键", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-mat-"));
    const blueprintDir = join(root, "blueprint");
    writeBlueprint(blueprintDir);

    const res = await materialize({
      blueprintDir,
      root,
      agentId: "a3",
      overlay: { personal: { age: null } },
    });

    const personal = readYamlFile<{ age?: number; gender: string }>(
      join(res.identityDir, "personal.yaml"),
    )!;

    expect(personal.age).toBeUndefined();
    expect(personal.gender).toBe("男");
  });

  it("蓝本哈希跨 agentId 稳定，filesCopied 正确", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-mat-"));
    const blueprintDir = join(root, "blueprint");
    writeBlueprint(blueprintDir);

    const r1 = await materialize({ blueprintDir, root, agentId: "b1" });
    const r2 = await materialize({ blueprintDir, root, agentId: "b2" });

    expect(r1.blueprintHash).toBe(r2.blueprintHash);
    expect(r1.blueprintHash).toHaveLength(64);
    expect(r2.filesCopied).toEqual(["agent_protocol.yaml", "manifest.yaml", "personal.yaml"]);
  });

  it("同一 agentId 物化两次抛 ValidationError", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-role-mat-"));
    const blueprintDir = join(root, "blueprint");
    writeBlueprint(blueprintDir);

    await materialize({ blueprintDir, root, agentId: "dup" });
    await expect(materialize({ blueprintDir, root, agentId: "dup" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});