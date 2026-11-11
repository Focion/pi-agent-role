---
title: pi-agent-role 执行任务清单
date: 2026-09-14
status: archived
archived_date: 2026-11-02
archived_from: notes/plan/2026-09-14-pi-agent-role-tasks.md
archived_reason: 被 notes/archive/2026-11-02-consolidated-audit-and-mesh-alignment-plan.md 接管
owner: 待定
tags: [plan, tasks, role-agent]
related:
  - 2026-09-14-pi-agent-role-rollout.md
---

> **已归档（2026-11-02）**：本文档不再有效，请参见 `notes/archive/2026-11-02-consolidated-audit-and-mesh-alignment-plan.md`。

# pi-agent-role 执行任务清单

> 由 `notes/plan/2026-09-14-pi-agent-role-rollout.md` 展开。执行期逐项勾选。
> 依赖：`@pi/agent-mesh`（`file:../pi-agent-mesh`）。包名 `@pi/agent-role`。

## P0 · 接上 mesh，跑通一轮对话（地基）

- [x] 0.1 包骨架：`package.json` / `tsconfig.json` / `tsup.config.ts` / `vitest.config.ts` / `.gitignore`
- [x] 0.2 `src/runtime/errors.ts`：`ValidationError` / `SpecVersionMismatch` / `AgentLocked` / `BudgetExceeded`
- [x] 0.3 `src/index.ts`：`createRuntime` 单入口 + 公开类型
- [x] 0.4 `migrations/001_init.sql`（14 张表）+ `src/db/db.ts` migrate（`PRAGMA user_version`，不建 meta 表）
- [x] 0.5 `src/mesh/ext-role.ts`：`ext.role.*` 8 字段读写与类型
- [x] 0.6 `src/mesh/accounts.ts`：`agent_id ↔ (accountId, endpointId)` 映射唯一持有方
- [x] 0.7 `src/mesh/policies/{activation,floor,renderer,access-control}.ts`（4 槽）
- [x] 0.8 `src/mesh/tools.ts`：10 个领域工具注册 + 四条规则骨架
- [x] 0.9 `src/mesh/session-factory.ts`：`create`/`open` 等价 + 三钩子 + I23 链尾
- [x] 0.10 `src/mesh/bootstrap.ts`（`createRoleMesh`）：`createMesh` 装配（devMode、policies、limits、registerAgent）
- [x] 0.11 `src/mesh/events.ts`：mesh 15 事件 → 领域事件转译（`MeshForwardEvent`）
- [x] 0.12 `src/runtime/runtime.ts`（`createRuntime`）+ 7 个命名空间门面壳 + `RuntimeInternals` 测试后门
- [x] 0.13 三条守卫：裸 `clearQueue(` 扫描（check-imports R4） + `create`/`open` 一致（共享 `assembleTools`）；`context` 链尾(I23) 待 P1 接 `createPiSessionFactory` 后落（fake 后端无 context 钩子可守）
- [x] 0.14 测试：2 Agent direct 互发 10 条到 consumed 的冒烟测试（`tests/smoke.test.ts`）
- [x] 0.15 CI 门禁脚本：import 图（R1）/ `mesh_*`·`ext.` 词表（R2/R3）/ 裸 `clearQueue(`（R4）/ 策略槽 `ext` 纯度（R5）

## P1 · 单 Agent 可恢复 + 双库规约

- [x] 1.1 `compile/identity-loader.ts` → `AgentSpec`
- [x] 1.2 `compile/materialize.ts`（实例模板物化，C5）
- [x] 1.3 `compile/model-resolver.ts`（五层解析链，C6）+ `prompt_version` 指纹
- [x] 1.4 `runtime/agents.create()`（落库 + 注册 `topology:"unified"` Account/Endpoint）
- [x] 1.5 FTS5 trigram 中文分词验证
- [x] 1.6 双库跨引用规约：裸 `msg_id` + 悬挂检测扫描
- [x] 1.7 恢复链路：`SessionFactory.open`（跨进程 kill → resume）

## P2 · 多 Agent + 场景（群语义）

- [x] 2.1 `scene/orchestrator.ts`（建档 / 入会 / 预算 / 收尾）
- [x] 2.2 `scene/cue.ts`（点名：`kind:"system"`+`expect:"reply"`+`to`）
- [x] 2.3 `scene/clock.ts`（虚拟时钟）+ `ext.role.virtualTs`
- [x] 2.4 `runtime/scenes.create()/run(signal)/resume()`（abort 走 `beforeClearQueue`）
- [x] 2.5 设施 Account（`initiate:[]`）+ `facility.ts`
- [x] 2.6 发言权验收：唤醒 idle≤1.2/busy=0、点名必醒、沉默权不锁死

## P3 · 对话记忆 ★ 核心

- [x] 3.1 `memory/score.ts`（`scoreMemorability` 纯函数）
- [x] 3.2 `compile/policy-mapper.ts`（模板 → `MemoryPolicy`，C1 核心）
- [x] 3.3 `agent/tools/`：`remember` / `recall` + `episodes`/`episode_subjects`
- [x] 3.4 记忆卡片走 P2 `context` 钩子（与未读摘要共存，I23）
- [x] 3.5 发送方自记 + `ext.role.facilityEvent` → `observation`

## P4 · 自省与巩固

- [x] 4.1 reflect Account / `AccessControl.canSend` 只放行本人
- [x] 4.2 `agent/reflect.ts` + `reflect_result` 只挂 reflect 会话
- [x] 4.3 触发器（六值）+ 三档深度（gradeDepth）+ `session_before_compact` 抢救提炼
- [x] 4.4 巩固 L1→L2 + `subject_profiles`
- [x] 4.5 Projector 回写 + `reconcile` + delta 限幅（K3）
- [x] 4.6 自省成本两段拼接排除（用 `send` 的 cue 触发，非 `request/ack`）

> **P4 两处接线已补齐**：
> ① `session_before_compact` 钩子：经 `pi-backend.registerHookExtension` 把 `session_before_compact`
> handler 与 `context` 一并注册；runtime 侧 `beforeCompactFor` 只对角色主 Account 返回，抽
> `mesh.msg` 角色消息（H1）→ `reflection.harvest`（H2 source_msg_id 去重）→ `pre_compaction` full 自省。
> ② 成本排除 SQL：`mesh/cost-lookup.ts`（mesh 只读分组）+ `inspect/cost.ts`（agents 表过滤 +
> E1 先过滤再求和 + E4/E5）+ `inspect.costMetrics`。`role-agent.db` 已含 `mesh_instance_tag` 列（§18.2）。

> **残留（如实记录，非阻塞）**：① 抢救提炼的虚拟时间目前取默认起点——压缩钩子发生时本环
> 无 per-agent 全局虚拟时钟可读，需场景生命周期接线后才有权威值（§10.5）；② E3 的
> `mesh_instance_tag` 校验两侧均未产出实例 tag（列恒 NULL），按「单 mesh 库」处理并写入 caveats。

## P5 · 知识记忆

- [x] 5.1 掌握度七态状态机 + 证据门槛 + `taught_by`
- [x] 5.2 误区（`academic.yaml` 薄弱项）
- [x] 5.3 `learningQueue` → Agent 主动 `mesh_send`

> **P5 核心已落地**：`src/knowledge/types.ts`（七态 T1–T11 封闭迁移集 + 证据八值 + τ/阈值常量）、
> `src/knowledge/dao.ts`（知识/事件/衰减/种入/摘要/学习队列读取的 DB-A 入口，无 mesh）、
> `src/knowledge/service.ts`（`applyUpdate` 校验 + 落库；`seedFromTemplate`；`decay`；`summary`；
> `organizeLearningQueue` Q1/Q3/Q4；`learningQueue` 读取）。接线：`ReflectionService.applyResult`
> 第 ④ 步逐条走 `KnowledgeService.applyUpdate`（含 `EVIDENCE_NOT_FOUND/NOT_OWNED` 区分 + T4
> 查库门槛）+ `assembleInput.knowledgeSummary`；`runtime.ts` 装配 `KnowledgeService`（共享 DB-A）；
> `agents.create()` 在落库事务内把 `knowledgeSeed` 种入 `knowledge_items`（幂等，`template_seed`）。
> 测试 `tests/knowledge.test.ts`（14 用例）覆盖全迁移集 + 证据 + 衰减 + 误区 + 学习队列。

> **残留（如实记录，非阻塞）**：
> ① `taught` 证据的跨 owner 双条件校验（听者侧产生 `to∈{understood,applied}` 且 `taught_by=讲者`）
> 及 `pending_taught` 延迟成立未实现（§17.2 尾段「需在实现期确认」）；当前 `taught` 从 applied→mastered
> 直通（不查跨 owner，符合 K3——不泄露对方分区）。
> ② 学习队列 Q2（连续 3 虚拟日未触及 ⇒ 降档）依赖场景「触及时刻」虚拟时钟，属 §15.5 日终任务（P2
> 场景收尾尚未搭建）；`learningQueue(owner)` 已可读，但把它射进 §14.1 的 150-token 瞬时上下文、从而
> 让 Agent 主动 `mesh_send` 提问的那一段注入，属 P3 记忆上下文钩子，未接（5.3 的「Agent 主动」是
> 模型读到队列后的涌现行为，库侧只保证「存 + 整理 + 可读」）。
> ③ `academic.yaml` 薄弱项现以 `KnowledgeItem={topic,claim}` 编译，尚无 `is_misconception`/`wrong_belief`
> 字段，故模板种入一律落 `heard`，模板侧的「授权期标误区」暂无法表达（运行期 `corrected`/`failed`
> 置误区已完整）。

## P6 · 观测、测试、层间回归

- [x] 6.1 `observe/`：timeline / profile-history / cost / replay（replay 留类型桩，完整引擎延后至 mesh observer API 就绪）
- [x] 6.2 本环 A1–A11（含 A2'）12 条 SQL 分区不变量 + mesh 16 条合一进 CI
- [x] 6.3 层间回归清单逐条自动化（invariants 16 测试 + observe 11 测试 + contract 3 测试 + regression T1/T4/T5 最高 ROI 子集 14 测试）
- [x] 6.4 契约测试只 import `index.ts`
- [x] 6.5 残留（T6 + mesh 计数器接线已落地；T7/replay 保持 blocked-by-mesh）

> **P6.3 回归测试（`tests/regression/`）新增 3 文件 14 用例**：`t4-storage`（T4.2 database_list 无 ATTACH / T4.3 已删三表 / T4.13 virtual_hours 投影一致性 + 漂移可检出）、`t5-isolation`（T5.4 reflect_result 只挂自省流 + 10 件领域工具封闭分划 + reflect 流无 mesh_send + T5.10 策略槽 ext 纯度静态扫描）、`t1-context`（I23 经 `exts.unshift` 前置注册 + 角色钩子路径稳定 + create/open 工具面等价守卫①③）。T5.10 与 R5 门禁互补（源码扫描不触真模型）。

> **P6.5 T6 + 计数器接线已落地（`tests/regression/t6-observability.test.ts` 10 用例）**：覆盖 T6.1（计数器能力边界：全 src 无 `mesh_counters` 直读、唯一入口 `observer.counters` + 9 名白名单）/ T6.2（E1 全程不碰计数器）/ T6.3（E2 排除只认 `agents.mesh_reflect_account_id`，不解析 `:reflect` 后缀）/ T6.5（段序 §20.2.5：mesh 侧分组先于本环映射）/ T6.11（E5 三条必需口径边界：下界·闲忙·保留期）/ T6.12（E6 只读连接 + 全 src 无 mesh_ 写）。接线三处：`mesh/counters-lookup.ts`（`readMeshCounterSnapshot` 经 `observer.counters` 读 9 计数器）、`observe/cost-view.ts`（`deriveMeshCounters` 纯函数 + `buildCostView` 接 `opts.meshCounters` 与 `health.{policyDegradedEvents,invariantViolatedEvents}`）、`runtime.ts` costView 先读快照再注入。**另修一处真实反向**：cost.ts 原先把段二（agents 映射）读在段一（mesh 分组）之前，违反 §20.2.5 方向安全（反序会漏排除两段之间新注册 Agent 的自省流量），已改为 mesh 先取、映射后取。

> **残留（如实记录，blocked-by-mesh:P2）**：① replay 完整引擎与 T7 回放回归——mesh `observer.replay()` / `forkAt()` 抛 `MeshUnsupportedError`（§23.2 P2 拆迁），role 侧无实现基础，只能待 mesh 补齐后再接；② `meshCounters` 段受计数器「无标签 + 按小时分桶」（§20.1.2）限制，与 cost 排除按 account 过滤的口径不同源，宿主应并读 `roleOnly` 段取排除后的真实口径。

## PA · 蓝本生成 Agent（只依赖 P1，可并行）

- [x] A.1 `BlueprintSchema`×2（identity/facility）
- [x] A.2 `authoring/` 五步驱动 + staging 白名单 + 三件工具
- [x] A.3 `promote` 原子 rename + `provenance.yaml`
- [x] A.4 依赖门禁：`authoring/` 无 mesh/db/memory/scene/agent

> **PA 已落地**：`src/authoring/{types,schema,tools,driver}.ts`。`schema.ts` 出
> `identitySchema`/`facilitySchema`（identity 的 validate 复调 `compileIdentity`——与
> `agents.create()` 同一份 loader，§24.1.1；facility 走结构校验 + §4.1 mesh 禁令扫描 +
> manifest.files 一一对应）。`tools.ts` 出 `blueprint_write/read/validate` 三件工具（staging
> 路径白名单，只 .yaml/.md，越界拒绝）。`driver.ts` 出 `createBlueprintAuthor`：五步流水线
> （normalize → scaffold → seed → expand → validate≤2 重试）+ `promote` 原子 `rename` +
> `provenance.yaml` + 登记 `manifest.files`；neverInfer 字段只留空、不推断。门面接线：
> `BlueprintsApi = { generate, promote }`（`runtime/blueprints.ts`→`runtime.ts`）。依赖门禁
> 增 R6（`scripts/check-imports.mjs`）：`src/authoring/**` 不得 import mesh/db/memory/scene/agent。
> 测试 `tests/authoring.test.ts`（5 用例）覆盖四条验收：教师描述→过 loader、allocation/
> unallocated/neverInfer、注入防护、依赖门禁。全绿：typecheck/build/check:imports/139 测试。

## P7 · 可选增强（blocked-by-mesh:P5）

- [ ] 7.1 `exportAsBlueprint` / `director` / 向量检索 / `scenes.pause/inject`
- [ ] 7.2 多进程部署（`SqliteOutboxTransport`）—— 需 mesh P5