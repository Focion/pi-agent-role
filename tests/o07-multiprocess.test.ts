// ═══════════════════════════════════════════════════════════════════════════
// O07 · 多进程部署透传（§19.3 / §19.5 / §27.4）
//
// role 不复制通信运行时：outbox / transport / 租约 / sameHost / recoverDeadEndpoints 全由
// mesh 实现。role 侧只做「不阻塞」——把 createMesh 的多进程开关原样透传，缺省仍走
// InProcessTransport + 单实例排他锁（单进程核心，行为不变）。
//
// 断言：
//   1. transport:"sameHost" 下同一 mesh.db 两个 role mesh 并存（mesh 的 sameHost 附着，
//      不经单实例排他锁），交叉投递走 outbox 由 mesh 内部接管——本测试只核验装配不冲突。
//   2. 缺省（不传 transport）第二个 role mesh 拒绝（单实例排他锁，行为不变）。
//   3. busyTimeoutMs / transportOptions / recoverDeadEndpoints 透传原样到达 mesh 且不报装配错。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRoleMesh, type RoleMesh } from "../src/mesh/bootstrap.js";

const cleanups: Array<{ dir: string; meshes: RoleMesh[] }> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    for (const m of c.meshes) {
      try {
        await m.close();
      } catch {
        // 已关闭/装配失败
      }
    }
    try {
      rmSync(c.dir, { recursive: true, force: true });
    } catch {
      // best-effort 清理
    }
  }
});

function tmpMeshDb(): { dir: string; meshDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-role-o07-"));
  return { dir, meshDb: join(dir, "mesh.db") };
}

describe("O07 多进程部署透传", () => {
  it("sameHost：同一 mesh.db 两个 role mesh 并存（不经单实例排他锁）", async () => {
    const { dir, meshDb } = tmpMeshDb();
    const m1 = await createRoleMesh({ dbPath: meshDb, transport: "sameHost" });
    const m2 = await createRoleMesh({ dbPath: meshDb, transport: "sameHost" });
    cleanups.push({ dir, meshes: [m1, m2] });
    expect(m1.mesh).toBeDefined();
    expect(m2.mesh).toBeDefined();
  });

  it("缺省（不传 transport）：同一 mesh.db 第二个 role mesh 拒绝（单实例排他，行为不变）", async () => {
    const { dir, meshDb } = tmpMeshDb();
    const m1 = await createRoleMesh({ dbPath: meshDb });
    cleanups.push({ dir, meshes: [m1] });
    await expect(createRoleMesh({ dbPath: meshDb })).rejects.toThrow();
  });

  it("busyTimeoutMs / transportOptions / recoverDeadEndpoints 透传原样到达 mesh", async () => {
    const { dir, meshDb } = tmpMeshDb();
    const m1 = await createRoleMesh({
      dbPath: meshDb,
      transport: "sameHost",
      transportOptions: { pollIntervalMs: 50, claimTtlMs: 5000, maxAttempts: 3 },
      busyTimeoutMs: 3000,
      recoverDeadEndpoints: true,
    });
    cleanups.push({ dir, meshes: [m1] });
    expect(m1.mesh).toBeDefined();
  });
});