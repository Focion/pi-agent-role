// ═══════════════════════════════════════════════════════════════════════════
// 发言权状态控制器（§3.7 末尾）——编曲器与策略槽共享的同源可变快照
//
// 一实例一控制器：createRoleMesh 的 makeFloorPolicy(controller) 与 createSceneOrchestrator
// 的 { floorState: controller } 拿同一个对象。编曲器每轮 cue 前 set()，策略槽在投递
// 事务内同步 get()。快照从不持久化（§13.2）；崩溃后发言权归属丢失，恢复时重新点名。
//
// 分层纪律：纯值容器，不 import `@pi/agent-mesh`、不碰 ext、不碰 DB。
// ═══════════════════════════════════════════════════════════════════════════

import type { FloorStateController, SceneFloorState } from "./types.js";

export function makeFloorStateController(): FloorStateController {
  let current: SceneFloorState | null = null;
  return {
    set(state: SceneFloorState): void {
      current = state;
    },
    get(): SceneFloorState | null {
      return current;
    },
    clear(): void {
      current = null;
    },
  };
}