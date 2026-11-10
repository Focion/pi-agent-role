// ═══════════════════════════════════════════════════════════════════════════
// ReplayApi 装配（H03 / R37 / R38）
//
// · record   记录回放：读 role 库已保存的逐轮/空轮决策 + 检索快照（只读）。
// · reexecute 隔离重执行：独立新环境跑冻结探针脚本，返回重执行回放，用后即弃。
// · compare  结构化比较：两条回放的记忆/知识/决策/检索/成本硬指标差异。
//
// 分层纪律：不 import @pi/agent-mesh（R1）；本文件只接 role 库与 replay 纯函数。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

import { compareReplays } from "../replay/compare.js";
import { readDomainDecisionReplay } from "../replay/record.js";
import { runIsolatedReexecute } from "../replay/reexecute.js";
import type { ReplayApi } from "./types.js";

export function makeReplayApi(db: Database.Database): ReplayApi {
  return {
    async record(ownerAgent, opts) {
      return readDomainDecisionReplay(db, ownerAgent, opts);
    },
    async reexecute(input) {
      const run = await runIsolatedReexecute(input);
      // 重执行数据已物化进 replay，临时环境用后即弃（不泄漏临时库句柄）。
      run.dispose();
      return run.replay;
    },
    compare(left, right) {
      return compareReplays(left, right);
    },
  };
}