---
title: pi-agent-role 落地计划（P0–P6 + PA）
date: 2026-09-14
status: active
owner: 待定
tags: [plan, role-agent, mesh]
related:
  - notes/tech/ROLE-AGENT-DESIGN.md
  - notes/tech/2026-09-14-mesh-strategy-slot-signatures.md
---

## 目标

把 `ROLE-AGENT-DESIGN.md`（v2）落地为 `@pi/agent-role` —— 一个**不可独立运行的 npm 库**（无 CLI、无端口），唯一导出 `createRuntime(options): Promise<Runtime>`，向下依赖 `@pi/agent-mesh`，再向下到 pi SDK。本环只做「角色域」：身份编译、三层模板、记忆/知识/自省、设施模型、场景编排、虚拟时钟。

完成标准（可验证）：

- P0–P6 全部验收项通过（每阶段见「步骤」），且 `policy_degraded` 与 `invariant_violated` 全程为 0。
- 契约测试只 `import "index.ts"` 跑通「建 Agent → 跑场景 → 自省 → 查观测」，用例里出现任何 `src/` 内部路径 import 即失败。
- 五条 import 门禁（见 tech 设计 §22.4 与九槽签名文档）进 CI。

## 范围

- 包含：`src/`（包内容，11 个子目录）、`role-agent.db` 14 张表 + `episodes_fts`、`mesh.db`（mesh 自持，本环只经 API 读写）、`templates/`（蓝本层，读-only）、测试工程（本环第一个宿主）。
- 不包含：L4 宿主（HTTP/CLI/评测框架——本环不 listen、不读 argv、不写 console）；L1 pi session 的 JSONL 落点规划（归 mesh 的 `SessionFactory`/`mesh_streams`）；多进程部署（P7，blocked-by-mesh:P5）。

## 步骤

关键路径 `P0→P1→P2→P3→(P4∥P5)→P6` = 9–15 天（单人）。PA 只依赖 P1，可并行。P7 可选、不计入。

| # | 事项 | 依赖 | 交付物 / 验收要点 | 状态 |
| --- | --- | --- | --- | --- |
| P0 | 接上 mesh，跑通一轮对话 | Node ≥22.19 | 包骨架 + `createRuntime` 空壳 + `errors.ts`；`role-agent.db` 14 张 DDL；`mesh/bootstrap.ts`（`createMesh({dbPath: mesh.db, devMode:true, policies, limits})`）；**`SessionFactory`**（`create`/`open` 装配一致 + 绑 `session_before_compact`/`agent_settled`/`turn_end` + context 链尾守卫 I23）；`accounts.ts`（1 角色 Agent → 2 Account）；`tools.ts` 四条规则骨架；三条守卫（`beforeClearQueue` 前置 / `context` 链尾 / `create-open` 一致）；事件接线（`policy_degraded`/`invariant_violated`/`message_consumed`）。验收：2 Agent direct 互发 10 条到 `consumed`；`checkInvariants()` 全绿；I23 回归过；裸 `clearQueue(` 扫描 = 0；双 `rt` 隔离；import 门禁生效 | todo |
| P1 | 单 Agent 可恢复 + 双库规约 | P0 | `identity-loader→AgentSpec`、`materialize`（C5）、`model-resolver` 五层链（C6）；`agents.create()`（落库 + 注册 `topology:"unified"` Account/Endpoint）；会话侧只存 spec 指纹；FTS5 trigram 中文验证；**双库跨引用规约**（裸 `msg_id` + 悬挂扫描，K4）；恢复走 `SessionFactory.open`。验收：跨进程 kill → `resume()` 记得前 5 轮；`replay` 里同一 `messageId` 只出现一次；悬挂扫描能报出指向已删消息的记忆行 | todo |
| P2 | 多 Agent + 场景（群语义） | P1 | 正式 `/generate-identity` ×3；`scenes.create()`（group Conversation + 入会 + `scenes` 行）；`FloorPolicy.grantFloor`；点名 cue（`kind:"system"`+`expect:"reply"`+`to:[x]`）；虚拟时钟 `scene/clock.ts` + `ext.role.virtualTs`；`createBatch(roster)`；`scenes.run()` `signal` abort（走 `beforeClearQueue`）；设施 Account `initiate:[]`。验收：20 轮三角色符合模板；每消息唤醒 idle≤1.2 / busy=0；点名必醒、旁听不醒；`grantFloor` 空集时 `floorSkipMs` 后顺移不锁死；伪造 `from` 无效；设施发起被 `reject(CANNOT_INITIATE)`；abort→`resume` 无损且 `queue_cleared_detected=0` | todo |
| P3 | 对话记忆 ★ 核心 | P2 | `scoreMemorability` 纯函数 + `policy-mapper`（模板→`MemoryPolicy`，C1 核心），触发源 `message_consumed`；`remember`/`recall` + `episodes`/`episode_subjects`；`ext.role.rememberHint` 打折；记忆卡片走 P2 `context` 钩子；发送方自记 + 设施 `observation`。验收：二次上课能提上次；三角色对同一 `msg_id` 的 `episodes` 明显不同（C4 可见成果）；注入 ≤2750 token 且原文份数 ≤3；记忆卡片与未读摘要互不覆盖；`episodes.msg_id` 无悬挂 | todo |
| P4 | 自省与巩固 | P3 | reflect Account 会话；`AccessControl.canSend` 只放行本人；`reflect_result` 只挂 reflect 会话；触发器（`agent_settled`/`episodes_since_reflection`/asleep/`scene_end`）+ 三档深度；`session_before_compact` 提炼；巩固 L1→L2；Projector 回写 + `reconcile` + delta 限幅（K3）；自省成本两段拼接排除——⚠️ 自省触发不用 `request/ack`（mesh P3 未做），改用 cue（`expect:"reply"`）或同步驱动，见风险 G1 | todo |
| P5 | 知识记忆 | P3（与 P4 并行） | 掌握度七态状态机 + 证据门槛 + `taught_by`；误区（`academic.yaml` 薄弱项）；`learningQueue`→Agent 自己调 `mesh_send`。验收：`heard→applied` 证据链完整、无证据升级被驳回；主动提问的 `from` 是 Agent 自己 | todo |
| P6 | 观测、测试、层间回归 | P4, P5 | `inspect.timeline/profileHistory/cost/compare/replay`（结构化）；本环 4 条不变量 + mesh 16 条合一进 CI；层间回归清单（I23 链尾 / `beforeClearQueue` / `create-open` 一致 / `ext` 未被读 / 未知 reason 码即告警）；契约测试只 import `index.ts` | todo |
| PA | 蓝本生成 Agent | P1（可与 P3–P6 并行） | `BlueprintSchema`×2；五步驱动 + staging 白名单 + 三件工具；`promote` 原子 rename + `provenance.yaml`。验收：200 字教师描述→产物过同一 loader；注入用例「忽略以上规则」→ 仍有 constraints；`authoring/` 依赖图无 mesh/db/memory/scene/agent | todo |
| P7 | 可选增强（多进程 blocked） | P6 | `exportAsBlueprint`、`director`、向量检索、`scenes.pause/inject`；**多进程需 mesh P5**。单进程可无限期停留 | blocked |

## 里程碑

- **M0（P0+P1，2–4 天）**：单一 Agent 能跨进程恢复；双库规约 + import 门禁跑在 CI。
- **M1（P2，2–3 天）**：三角色课堂场景跑通，唤醒/原文/发言权三项达 mesh 硬门槛。
- **M2（P3，2–3 天）**：对话记忆分化可见（三角色对同一事实记得不同）。
- **M3（P4/P5，2–3 天，可并行）**：自省闭环（印象变化可追溯）+ 知识掌握度状态机。
- **M4（P6，1–2 天）**：全量回归 + 契约测试绿。

## 风险与阻塞

| 项 | 影响 | 应对 / 待谁解决 |
| --- | --- | --- |
| **G1**：mesh `request()`/`ack()` 是 stub（`MeshUnsupportedError`），`expect` 作为唤醒判据可用 | P4 自省 §13.1.4 的 `expect:"ack"` 关联生命周期不可用 | P4 改用 cue（`expect:"reply"`）+ 同步驱动触发；暂挂 `expect:"ack"` 关联，等 mesh P3 再切。issue 标 `blocked-by-mesh:P3` |
| **G2**：mesh 跨进程 outbox（`SqliteOutboxTransport`）是 stub（P5） | P7 多进程不做 | 标 `blocked-by-mesh:P5`；单进程交付不阻塞 |
| **G3**：queue / shared spaces / topic 均 stub | 无影响（设计已声明本环不用） | 无需处理 |
| **K1**：`SessionFactory` + 三条静默失败守卫失败时全静默（mesh §26.1 第 1/4/5 步） | 消息发出没反应、上下文没注入、偶发丢消息，且表看起来都一致 | 钉在 P0；`devMode:true` 贯穿集成期；三条守卫各配一个自动化用例 |
| **K2**：记忆分化（`policy-mapper` + `scoreMemorability`） | 三角色记忆趋同 ⇒ 项目意义失效 | P3 之前不交付；「第四角色测试」作为 C1 验收 |
| **K4**：双库跨引用（裸 `msg_id` 无外键） | 记忆指向被裁剪消息时**无任何约束报错** | P1 落规约 + 悬挂扫描；补进去要回洗记忆行，故不能推后 |
| **K3**：Projector 回写 + delta 限幅必须同批上线 | 自我强化回路长跑后人格失控 | P4 内联动上线 |

## 进度记录

- 2026-09-14：`notes/tech/ROLE-AGENT-DESIGN.md`（v2）定稿；本计划与 `notes/tech/2026-09-14-mesh-strategy-slot-signatures.md` 起草；对照 mesh v0.1.0 源码核对九槽接口与 stub 位点。