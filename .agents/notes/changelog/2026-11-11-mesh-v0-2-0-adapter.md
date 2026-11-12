---
title: mesh v0.2.0 适配变更说明
date: 2026-11-11
status: done
owner: Fakedonair
tags: [changelog, mesh, adapter, pi-durable, role-agent]
related:
  - ../archive/2026-09-14-mesh-strategy-slot-signatures.md
  - ../archive/2026-11-02-consolidated-audit-and-mesh-alignment-plan.md
  - ../tech/ROLE-AGENT-DESIGN.md
---

## 概要

`@pi/agent-role` 已适配同级 `@pi/agent-mesh` **v0.2.0**（pi SDK 链迁移到 `@earendil-works/*` 1.5.0，`better-sqlite3 ^13.0.3`，Node ≥ 24）。公开入口不变（仍是 `createRuntime` + 类型 + 错误），全部变化收敛在 `src/mesh/**` 适配层与编译层。本次为文档收尾：九策略槽签名文档校准并归档，本 changelog 记录界限与验证结果；除清理 3 处引用旧 mesh 工厂名的过时注释外，无功能代码改动。

## 适配内容（v0.1.0 → v0.2.0 关键差异与 role 侧落地）

| 差异 | v0.1.0（历史） | v0.2.0（现行） | role 侧落地 |
| --- | --- | --- | --- |
| `SessionFactory` 字段 | `piSessionId` | `runtimeRef` | `session-factory.ts`/`pi-backend.ts` 用 `runtimeRef`，编码为 `encodeRuntimeRef({storagePath, conversationId})`（mesh MD7 不透明编码） |
| pi 会话后端 | coding-agent（`SessionManager`/`createAgentSession`） | pi-durable 1.5（`Harness.open`/`root`） | M01–M02：`createPiBackend` 逐账号装配，`AgentChange.model`/`instructions` 注入，`GenerationHooks.beforeRequest` 注入记忆上下文，`CompactionHooks.beforeCompact` 抢救提炼 |
| `AccessControl` 钩子 | 9 个 | 10 个（新增 `canSubscribe`） | 仍只实现 `canSend` + `canInitiateDirect`，其余缺省放行 |
| `clock` 槽 | 用默认 `WallClockLogicalClock` | role 实现 | `src/scene/clock.ts` 的 `makeLogicalClock()`（虚拟时钟 `W<周>D<日>T<时段>` 的 `compare`/`format`） |
| `beforeClearQueue` API | role 存在旧调用 | mesh 已移除 | M04：退役旧协议，保留 submission 幂等、中止、close 与恢复，不伪造 `consumed` |
| 多进程传输 | — | `transport:"sameHost"`/outbox/租约全在 mesh | O07：`createRuntime` 透传 `transport`/`transportOptions`/`recoverDeadEndpoints`/`busyTimeoutMs`，缺省单实例不变 |
| 模型凭据 | — | pi-durable 1.5 无缺省目录，需显式 key | M05：`credentialFor` → `InMemoryCredentialStore`，自定义 provider 走 `baseUrl` + `pi-ai/api/*.lazy` |
| SDK 装载 | — | 惰性装载，clipboard 卫兵延迟到装载时 | R01：`loadDurableSdk` 内设 `process.env.TERMUX_VERSION ??= "1"`，不改模块加载时进程环境 |

## 破坏性变更

| 变更 | 影响范围 | 迁移方式 |
| --- | --- | --- |
| 公开 API | 无（`createRuntime` 及公开类型不变） | 无需迁移 |
| `runtimeRef` 内部字段 | 仅 `src/mesh/**` 会话层，对宿主不透明 | 无需迁移（旧库若存裸路径，按 `decodeRuntimeRef` 兜底为 `storagePath`） |
| pi SDK 链 1.5.0 | 真实模型后端，需 Node ≥ 24.0.0 且提供 pi SDK 凭据 | `npm ci` 全新安装；fake 后端测试通过不代表真实模型调用可用 |

## 新增

- `src/mesh/pi-backend.ts`：pi-durable 1.5 自建会话后端（M01–M02），含真实用量回读 `usageBreakdownFor`（A07）。

## 修复

- 清理 3 处引用 mesh 旧工厂名 `createPiSessionFactory` 及「P1 待接」的过时注释（`session-factory.ts`、`bootstrap.ts`），改为描述现行 `createPiBackend`/pi-durable 1.5 路径。

## 升级步骤

1. 满足前置：Node ≥ 24.0.0（本库 root `engines`）、本机编译工具链（`better-sqlite3` 原生依赖）、同级 mesh 仓库 `pi-agent-mesh` 产物可用、pi SDK 凭据（真实模型时才需要）。
2. `npm ci` 全新安装依赖（mesh 经 `file:../pi-agent-mesh` 引用）。
3. 依次验证：`npm run check:imports` → `npm run typecheck` → `npm test` → `npm run build`。

## 回滚方式

- 无 schema 变更、无公开 API 变更，无需数据迁移；回滚即切回旧 mesh 版本 + 对应 `src/mesh/**` 快照。

## 验证结果（本次实跑）

- `npm run check:imports`：✓ 通过（93 个源文件）。
- `npm run typecheck`：✓ 通过。
- `npm test`：✓ **326 passed | 3 skipped**（3 个真实模型测试因缺凭据跳过；fake/faux 全绿）。
- 无残留禁用 API 调用：`beforeClearQueue`/`clearQueue`/`forkFrom`/`forkAt`/`piSessionId` 在 `src` 中均无活动调用点。