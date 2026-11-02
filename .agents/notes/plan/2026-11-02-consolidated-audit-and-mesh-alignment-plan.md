---
title: pi-agent-role 统一审计、mesh 适配与 0.1.0 核心闭环计划
date: 2026-11-02
status: active
owner: 待指定
tags: [plan, audit, mesh-compatibility, migration, release, role-agent]
related:
  - ../archive/2026-09-14-pi-agent-role-rollout.md
  - ../archive/2026-09-14-pi-agent-role-tasks.md
  - ../archive/2026-10-09-implementation-gap-closure-plan.md
  - ../archive/2026-10-09-v0-1-0-release-implementation-plan.md
  - ../tech/ROLE-AGENT-DESIGN.md
  - ../tech/2026-09-14-mesh-strategy-slot-signatures.md
---

## 结论与本轮边界

本文件接管四份历史 plan。未完成项、内部缺陷、mesh 变更影响及执行决策只在此处追踪。

**四份旧计划均未达到完整完成标准。** 原 R01–R39 中，7 项未见目标实现，32 项部分实现；目前没有可按完整关闭标准关闭的 R 项。已有算法、DDL、门面和测试可以复用，不代表从零开始。

本轮登记 38 个内部失败反例，其中 37 个来自静态审查，1 个正文 SQL 错误另有内存实验。多数加深旧 R 项，不是新增 38 个功能。M01–M05 是 role 的适配事项；M00 的旧库问题在新决策下不再阻断发布。

本轮核对代码、测试和上游实现，整理文档。不修改业务代码、schema、依赖或锁文件。不安装依赖，不调用真实模型，不修改 mesh，不提交、推送或发布。

用户已确认全部推荐方案，本文件转为 `active`。回放粒度与 abort 语义已定稿，当前没有剩余产品决策。验收标准描述后续要求，不表示业务代码已修复或本轮测试通过；实施工作包尚未启动。

### 2026-11-02 用户确认的执行边界

| 决策 | 当前执行边界 |
| --- | --- |
| H01 | mesh 是固定依赖，以本轮提交的公开契约为准。只修改 role 来适配，不安排 mesh 修复、schema 改动或新增接口，也不等待上游变化 |
| H02 | 项目尚未发布，允许重新设计 role 初始 schema，并用新库重建开发/验收环境。不要求保留或迁移未发布旧数据。mesh 数据库只由固定版本 mesh 按其现有 schema 创建 |
| H03 | 核心回放范围为历史记录/领域决策回放，加固定条件的隔离场景重执行与 compare。不要求从底层原会话任意历史点原位分叉，不等待 mesh forkAt。记录来源、fidelity 和缺失信息，不冒称重建未记录的历史最终 prompt |
| H04 | abort 只停止新 cue，不默认取消正在生成的模型。让在途模型/submission 收敛，记录真实用量，持久化可恢复进度。超时明确返回未完成，不能伪造 consumed 或提前当作整轮完成 |

H01/H02 覆盖旧计划中相冲突的上游修复和旧数据保留要求。H03/H04 定稿 C02/C03，覆盖旧原会话分叉与队列强清理假设。新版本的事务、重启、崩溃恢复、分库及 owner 隔离仍须验收。重建是获准的方案，不表示本轮已删除数据库；实际操作需先列明目标和影响范围，不自动清库。模型费用、发布及撤回仍须分别授权。

## 核对基线与证据等级

| 项目 | 本轮基线 |
| --- | --- |
| role HEAD | `c62706654664a9b963bb82922201bf7154bcce76` |
| role 主体实现 | `201b6c8`。从该提交到 HEAD，`src/`、`tests/`、迁移及包配置没有变化 |
| mesh HEAD | `f0079c5e67e917a036ff00094fbc27293a1bce83` |
| Node.js / npm | 初次检查为 `v20.18.0` / `10.8.2`；恢复会话后为 `/opt/cloudcli/node/bin/node` 的 `v22.16.0` / `10.9.2`。nvm 仅有 `v20.18.0`。两次环境都不满足新 mesh 的 Node.js 24+ |
| 依赖 | 两仓均无 `node_modules` |
| 初始工作区 | 两仓均干净 |
| 本轮已执行 | role 源码门禁：73 文件通过。上游审查在 Python sqlite3 3.45.1 内存 DB 核验 SQL/旧迁移逻辑，未打开用户运行库。归档正文、编号覆盖、链接及 diff 另作文档检查 |
| 尚未执行 | 类型检查、Vitest、构建、打包、包外消费、跨平台及真实模型验收。缺依赖且默认 Node.js 不满足新 mesh 基线 |

证据分三级：

1. **源码确认**：能追踪生产调用链或具体失败路径。
2. **测试存在**：仓库有对应断言，但本轮没有运行。
3. **本轮执行**：记录命令、环境与输出。只有这一类可写为本轮验证通过。

静态门禁通过不证明公开契约、自省、恢复或真实会话可用。fake 后端测试也不能替代真实 SDK 适配验收。

## 历史计划去向

归档不等于完成。只有功能实现和适用验收都满足，任务才可关闭。

| 历史文件 | 本轮处理 | 接管范围 |
| --- | --- | --- |
| `2026-09-14-pi-agent-role-rollout.md` | 按新计划替代归档，不宣称 P0–P6 全部通过 | 阶段目标、公共契约、分层、恢复及角色差异性 |
| `2026-09-14-pi-agent-role-tasks.md` | 按新计划替代归档，保留原勾选和历史说明 | 实现库存与残留项；纠正“勾选即完成” |
| `2026-10-09-implementation-gap-closure-plan.md` | 按新计划替代归档，不把 R/O/D 的 todo 改成 done | R01–R39、补充关闭标准、O01–O07、D01–D02、U01–U03 及 Q01–Q10 |
| `2026-10-09-v0-1-0-release-implementation-plan.md` | 按新计划替代归档，不宣称已发布 | B01–B07、E01–E11、S01–S07、WP00–WP15、DIF01–DIF08 及发布关卡 |

历史源码中的算法、DAO、门面和测试可以复用。是否完成须按下面的工作单元判断，不计算粒度不一致的全项目完成率。

### 完成度裁定与当前证据

R01–R39 按原目标而不是文件数量裁定：**可关闭 0 项；未见目标实现 7 项；部分实现 32 项。** “未见目标实现”允许附近有类型、工具名或基础算法；“部分实现”不表示相关反例已修复。类型、Vitest 和构建本轮未运行，因此没有整项验收通过结论。

| 未见目标实现 | 本轮裁定依据 |
| --- | --- |
| R08 | `src/mesh/tools.ts` 有 identity_read/protocol_query/note_self 工具注册骨架，不等于白名单读取、self 情节写入及宿主只读 memory 门面可用 |
| R09 | 有实例物化，没有 DB→实例文件 Projector、manual 审计导入和重投影闭环 |
| R10 | 有 Agent 管理入口，没有 spec 漂移防护、非 mesh respec 和恢复型退役闭环 |
| R23 | 有 L1 卡片和队列注入，没有本人 L2 画像/知识、发送者印象及完整实时状态注入 |
| R29 | 没有通用教学进度用途、跨班/课检索、独立预算及最近知识求交检测 |
| R33 | `mesh_instance_tag` 列存在，但无稳定实例标识的生产与配对校验；NULL caveat 不能关闭任务 |
| R38 | 没有公开 compare 入口与固定探针/结构化比较执行链 |

其余 32 项均为部分实现。下表记录可复用证据及不能关闭的原因；详细修复标准仍以 R 表和 A 反例为准。

| R 项 | 当前可复用证据 | 剩余阻断 |
| --- | --- | --- |
| R01 | `src/index.ts`、`src/runtime/runtime.ts` 的工厂与公开类型。 | 实际对象仍含内部句柄，导入副作用与包外 JS 边界待修。 |
| R02/R07/R12 | `src/compile/identity-loader.ts`、`src/compile/materialize.ts`、`src/authoring/{schema,tools,driver}.ts` 的 loader、生成/校验/晋升驱动。 | 路径与失败恢复、完整共享 schema、敏感事实来源及落盘 allocation 证据不足。 |
| R03/R30 | `src/db/db.ts`、`migrations/001_init.sql`、`src/inspect/invariant-sql.ts` 的领域库与分区检查。 | 同文件/别名拒绝、部分失败释放、Scoped/Admin 与生产关场接线不足。 |
| R04/R05/R06 | `src/runtime/agents.ts`、`src/runtime/pi-bindings.ts`、`src/compile/model-resolver.ts`、`src/mesh/session-factory.ts` 的注册/绑定/模型解析骨架。 | registering 无法闭环恢复，自省绑定不可达。公开覆盖/换模型/真实成本及 durable 工厂待接。 |
| R11/R31 | `src/runtime/facilities.ts`、`src/mesh/facility.ts`、`src/mesh/events.ts` 的设施与事件骨架。 | 生成到执行/恢复、四工具与拒绝审计、无 onEvent 的内部停写未闭环。 |
| R13/R14/R15/R16 | `src/scene/orchestrator.ts`、`src/scene/{cue,clock,floor-state}.ts`、`src/runtime/virtual-clock.ts` 的场景/点名/时钟入口。 | 未按真实消费推进，token 零记账。分钟格式、关闭竞态和旧中止协议待修，日终/解散不足。 |
| R17/R18/R19/R20 | `src/reflect/{service,dao}.ts` 的输入快照、结果应用、触发与抢救入口。 | 实际 cue 缺证据，批次关联/事务/成功游标与等待/来源去重不足。 |
| R21/R22 | `src/memory/{service,dao,tools,turn}.ts` 的观察、记忆工具与投递回调。 | 同轮多 delivery、P3、P2 quote、原情绪字段和重复主体证据仍有反例。 |
| R24/R25 | `src/memory/{retrieve,render,subject}.ts` 的召回、投影及预算/日志基础。 | 在场 key、retention 展示、整句召回、部分扣账和单次总额错误。最终 durable 上下文待验。 |
| R26/R27/R28 | `src/knowledge/{types,dao,service}.ts` 的状态机、种入、误区和学习队列。`src/memory/service.ts` 已有队列注入。 | taught 双证据与 pending、fading 恢复、衰减幂等、模板误区和跨批队列/时间仍不足。 |
| R32/R34/R35/R36 | `src/inspect/{dangling-scan,cost}.ts`、`src/observe/{cost-view,timeline}.ts` 和 mesh 只读查询。 | 完整来源扫描、生产自省归因、统一 scope/窗口/unknown 与角色可见性不足。正文 SQL 本身有错。 |
| R37 | `src/memory/retrieve.ts` 的卡片快照/hash 是本地回放准备。 | **公开 replay 类型、入口和执行器均不存在**，不是“已有 replay 类型桩”。mesh replay 不等于历史最终上下文，forkAt 仍不支持。 |
| R39 | `tests/` 与 `scripts/check-imports.mjs` 有合同、回归和六条源码门禁。 | 部分测试只做源码扫描或 fake/正常重启，且有与新决策冲突的断言。未取得完整 SDK/故障/平台验收。 |

### 旧阶段和任务编号去向

旧 tasks 共 53 个复合条目，其中 51 个勾选。勾选表示历史记录，不是本轮 51/53 完成。包骨架、错误类、14 表 DDL、codec、部分纯函数及六条静态门禁已有源码；不为这些库存另建待实现任务。原复合条目的未闭环要求按下表归并，旧正文保留用于追溯。

| 旧阶段/任务范围 | 统一追踪 |
| --- | --- |
| P0：0.1–0.15 | 环境/M01–M05、R01/R03–R08/R13/R14/R31/R39；包骨架/事件/codec/门禁不重写 |
| P1：1.1–1.7 | R02–R07/R10/R24/R32/R33/R39；kill/resume 不由正常 close/open 代替 |
| P2：2.1–2.6 | R11/R13–R16/R21/R31/R39；点名、预算、时间和设施按真实闭环验收 |
| P3：3.1–3.5 | R21–R25/R39、DIF01–DIF03；评分等纯函数复用，补生产字段与最终上下文 |
| P4：4.1–4.6 | R05/R09/R16–R20/R34–R36/R39；Projector 不因旧 4.5 勾选而判作存在 |
| P5：5.1–5.3 | R26–R29/R39；已有队列注入不重复列缺失，taught/误区/时间仍待补 |
| P6：6.1–6.5 | R30–R39、T1–T7/G；纠正 replay/stub 与计数器能力口径 |
| PA：A.1–A.4 | R02/R07/R11/R12/R39；保留 AuthorModel 契约，补晋升恢复与字段分配证据 |
| P7：7.1–7.2 | O01–O07；sameHost/outbox 已有上游实现，但 role 未接通，仍后置 |

## 保留的业务决策与发布边界

下列规则来自历史计划记录；B04–B06 已按 H01/H02 修订。其他规则保留，不重新解释为立即实施或发布授权。归档文档中的旧要求仅供追溯，以本计划的最新决策为准。

### Q01–Q10：业务决策

| 编号 | 必须满足的规则 |
| --- | --- |
| Q01 | 一场景一群。关闭先停止新发言、收敛在途，再解散。角色流承接跨场景记忆 |
| Q02 | 角色进入模板 `asleep` 段时日终；无声明时按跨虚拟日兜底。同角色同虚拟日去重。跨多日不伪造经历 |
| Q03 | 误区优先于掌握度出队。仍有误区的 `applied/mastered` 项保持 high。解除误区且达标才出队；motivation 不泄露错误答案 |
| Q04 | 普通角色仅获 `chat/task/event` 发起权。`system/tombstone` 走宿主控制路径。收紧模板时同步解决合法 cue 的发送身份 |
| Q05 | `taught` 核对讲者双主体情节和听者迁移。证据不齐则 pending，日终回补。角色只获成立与否，不读取听者分区 |
| Q06 | 兼容扩展现有模板。生成、promote、create、overlay 共用校验。不机械恢复旧示例文件名 |
| Q07 | 保留宿主注入 `AuthorModel` 的正式契约。不要求蓝本生成器内置一次性 pi 会话 |
| Q08 | mesh 身份字段创建后不可变。`respec` 只改非 mesh 部分。身份变化拒绝并要求新建角色，不自动搬迁历史 |
| Q09 | 基础上下文最多 2750 token。教学进度另占最多 200 token、3 条；启用时总额最多 2950。独立记账，不占 L1 的 900 |
| Q10 | `clamped` 只表示发生裁剪。实际用量可低于上限；不填充内容、不虚报 token |

### B01–B07：发布边界

| 编号 | 必须保留的边界 |
| --- | --- |
| B01 | 目标仍是尚未发布的 `@pi/agent-role@0.1.0`，不是 1.0.0。正式发布前核验版本占用，不覆盖同版本 |
| B02 | 单进程完整核心版。R01–R39 全部闭环，回放和比较仍属核心；O01–O07 后置。不新增 CLI、HTTP 或全局运行时 |
| B03 | 内部私有 npm。registry、scope 权限及发布者在执行阶段登记；不向公开 registry 试发 |
| B04 | mesh 固定，适配全部落在 role。保留 `@pi/agent-mesh: file:../pi-agent-mesh` 原字符串，源码和制品都不改写。不用 override、vendor 或内嵌绕过，不修改或等待上游 |
| B05 | 尚未发布，允许重设计 role 初始 schema，配套环境采用新建双库。取消未发布旧数据迁移/无损保留的发布门槛；新版本内的恢复与数据一致性仍是门槛 |
| B06 | 新建角色必须通过权限和 schema 校验，不再要求迁移旧越权角色。运行中的不可变 mesh 身份规则仍保留；不通过放宽权限或静默改身份来适配 |
| B07 | macOS ARM64 与 Linux x64 都是发布必过平台。Linux 首期限定 glibc；精确 Node/npm/系统版本须冻结，不承诺 Windows |

## mesh 当前能力与适配清单

以当前源码和包配置为准，不沿用旧 `stub` 标签，也不把 changelog 的迁移承诺视为执行证据。

当前 mesh 为 `0.2.0`，Node.js 要求 `>=24.0.0`。直接 SDK 为 pi-durable、pi-ai、chord `1.4.0`，SQLite 依赖为 `better-sqlite3 ^13.0.3`。证据：`../pi-agent-mesh/package.json:3–11,45–49`。升级说明中的 `1.3.0` 及根 AGENTS.md 的旧 SDK/Node 基线已经过期。

### M00：旧库不兼容事实保留，采用新建库，不再阻断

**当前 mesh 不能按 changelog 的承诺无损升级旧库。** 该审计事实不变；根据 H01/H02，不修 mesh、不要求旧库升级，使用固定版本创建新的 mesh 数据库，并与重设计的 role 库重新配对。

1. `git ls-tree -r --name-only HEAD migrations` 只列 `migrations/000_init.sql`。承诺的 `005_runtime_ref.sql` 不存在，历史 001–004 也不在当前构建中。
2. `../pi-agent-mesh/src/core/store.ts:283–290` 据迁移文件计算 `maxKnownSeq`，当前为 0。`store.ts:331–336` 遇旧库的 001–004 迁移戳会判作“newer library”并拒绝启动。
3. 只有旧 000 戳的数据库会在 `store.ts:340` 跳过同名脚本。重写 000 不会给已盖戳旧库补 `runtime_ref`、`submission_id` 等新字段。
4. `../pi-agent-mesh/.agents/notes/changelog/2026-11-01-v0.2.0.md:25,34,68–76` 却描述 005 迁移及 SQLite 历史保留。这与当前文件库存和启动逻辑矛盾。

**当前方案**：适配环境使用新的 role DB、mesh DB 和 durable 会话目录，不把旧 coding-agent JSONL 当 durable storage。不删迁移戳，不由 role 修补 mesh schema。识别旧格式后明确拒绝并给出重建指引，不在普通启动路径静默删除文件。

退出标准：固定 mesh 能创建并重开新库，role 新 schema 能初始化、配对和重启；失败初始化可重试，旧/不兼容格式不被误当新库。无需证明旧 000/001–004 库或 JSONL 可迁移。方案已确认，实际新环境验收尚未运行，不能将 M00 写成代码修复完成。

### M01–M05：role 必须适配的接口和语义

以下是当前版本差异，不重复列旧 R 项的同根因问题。M 项是 WP00/WP03/WP05/WP06/WP14 的适配验收，不是另加五个产品功能。

| 编号 | 当前证据与失败方式 | 修改方向和验收 |
| --- | --- | --- |
| M01 执行体与会话引用 | role `src/mesh/session-factory.ts:23–35,78–85,126–137`、`src/mesh/pi-backend.ts:26–41,104–125,203–225` 仍创建 coding-agent、使用 `piSessionId`。mesh `src/core/types.ts:566–578` 要求 `{session,runtimeRef}`；`src/pi/durable-port.ts:183–204,287–329` 要求 durable 的 root/registry/ctx。旧 session 即使换字段名仍会 `NO_SESSION`，端点 unavailable、投递 parked；open 也缺旧 ID | 整体迁移 Backend、Context、create/open/fake，使用公开工厂或兼容 durable 的自定义工厂。不同账号首次 warm、evict/open、重启及工具面等价须由 durable+faux provider 验证。不把旧 JSONL 路径当 durable storage |
| M02 身份、模型和注入 | role `src/runtime/pi-bindings.ts:42–51,59–74`、`src/mesh/pi-backend.ts:104–123,153–188` 依赖逐账号提示/模型、DefaultResourceLoader 和私有 extensionRunner。mesh `src/pi/session-factory.ts:108–171,212–255` 无同名角色 hooks 槽；`src/pi/durable-port.ts:450–475` 的条目为 kind/data，`605–629` 用 beforeRequest 注入。直接替换工厂会丢身份/模型；旧条目筛选提炼零条 | 保留 account→binding，用 durable 官方 registry/hooks 接入，不导入 mesh 私有路径。捕获实际 provider 输入，检验未读+记忆+意图的内容、次序、非持久性及 open 重配置。beforeCompact 的官方范围/完成/等待对等能力须另验；没有公开同名槽不等于角色抢救可以悄悄删掉。并入 R05/R06/R20/R25 |
| M03 fake 的 submission 协议 | role `src/mesh/fake-stream-port.ts:64–89,130–133` 只返 entryId、用 hasEntries。mesh `src/core/types.ts:749–798`、`src/core/mailbox.ts:659–674,1226–1263` 要求 submissionId/status 和精确 submissionStatus。旧 onEntry 发生在新 ID 入库之前，不能证明 delivered/consumed，可能 queued/parked | fake 改为 queued/placed/done/unanswered 的确定性状态机，接 deliveryId/attempt，区分 input/write。覆盖 busy 排队、entry 先后、精准对账、重投与重启。不再以 entry 存在性替代 submission 权威 |
| M04 abort 与 close | role `src/scene/orchestrator.ts:389–401` 调已删除 beforeClearQueue，TypeError 又被 catch 吞掉。mesh `src/core/types.ts:887–930` 无该 API；`src/index.ts:1773–1789` 的 close 等 port.inFlight 再 dispose，不等全部 delivered。role `src/mesh/drain.ts:30–39` 泛化 markConsumed 不能减少真实 inFlight，还会伪造消费 | 退役旧队列清理协议。按 H04 停止新 cue，不默认取消正在生成的模型；等待真实在途状态收敛，恢复交 submission 对账。删除或严格限定旧 drain，禁止伪造 consumed 加速 close。覆盖 P1 活跃 close、P2/P3 残余、abort 后迟交/真实用量、收敛超时与 resume。不把模型强取消作为本次默认能力或关闭门槛。并入 R14/R21 |
| M05 包、Node 和锁 | role `package.json:10–12,31–50` 声明 Node≥20、旧 coding-agent；`package-lock.json:36–62` 仍快照 mesh0.1。mesh `package.json:10–24,45–49` 为 Node24、durable/pi-ai/chord1.4。旧 lock 不能作为新配套环境安装证据 | 实施时统一 Node24、SDK/mesh 源码与产物指纹，明确 role 直接依赖与 peers，重建锁。保留 B04 的 file 字符串。干净环境 npm ci、类型/构建、两平台 ESM/CJS/DTS 和配套消费均须验证；不靠装旧 SDK 绕过 M01 |

以上 `mesh src/...` 均相对 `../pi-agent-mesh/`，`role src/...` 相对本仓库。行号对应本轮提交，实施后重新定位。

### U01–U03：已核实的上游能力

| 关卡 | 当前已有实现 | 仍不支持或需后续验收 |
| --- | --- | --- |
| U01 历史/恢复/上下文 | mesh `src/core/observer.ts:603–641` 已有 replay；durable open/reconfigure 和 P2 beforeRequest 已有实现，`tests/pi/durable-contract.test.ts:199–252` 有静态测试证据 | replay 拼镜像条目和**当前 inbox**，不重建历史最终 prompt。`observer.ts:644–645` 的 forkAt 仍显式 unsupported。role 无 replay 入口；beforeCompact 范围/等待/最终注入次序未验证。旧 JSONL 不导入新环境。R37 按 H03 在 role 实现记录回放和隔离场景重执行，原会话任意历史点原位分叉不在本次范围。不等待 mesh 新增 forkAt，也不把当前 inbox 拼接冒充历史最终 prompt。验收口径见 C02/T7 |
| U02 展示/计数/保留期 | Observer messages/search/trace/counters 已有，工具 history 已落实 R4 定向过滤 | `src/core/observer.ts:172–203` 的 messages 是宿主全量读，没有 as/account 权限参数，不能直接当角色可见性 API。counters `650–672` 只有 since 小时桶、没有 until/标签；缺独立保留期/完整度证明出口。R35/R36 必须明确权限和不可得量 |
| U03 注册/身份/部署 | request/ack、sameHost/outbox、单写者及 dead endpoint reclaim 已有。`src/index.ts:1442–1573` 的 request-await 支持快 ack 补查和跨进程轮询 | `src/core/registry.ts:296–315` 注册账号是 INSERT，重复 ID 冲突；`516–543` 注册端点每次新 ULID，不是幂等恢复 API。无通用身份更新面、无持久 mesh-instance UUID 的公开 API；writerId 每次启动随机。role `src/mesh/bootstrap.ts:28–56,132–138` 未接 sameHost/recoverDeadEndpoints。R04/R33 与 O07 不能据上游已有功能宣称接好 |

公共出口另有限制：decodeRuntimeRef/encodeRuntimeRef 目前仅为 mesh `src/pi/session-factory.ts:43–59` 私有函数。根出口 `src/index.ts:2118–2130` 未导出，也无 `./pi` 子路径。changelog 的公开 helper 声明不符。role 使用公开工厂，或在自定义工厂内管理自己的版本化 runtimeRef；不依赖私有 helper，也不要求 mesh 补出口。

R33 的角色侧方案不需要 mesh 新增全局 UUID。mesh 的公开 `registerAccount` 和 `lookup` 已声明于 `src/core/types.ts:863–869`，账号 id/ext 的持久化见 `src/core/registry.ts:296–323`。拟由 role 生成配对标识，持久化于领域库，并通过公开 API 建立/查询对应账号锚点，优先复用宿主控制账号。查询后核对完整 id/标记，不把模糊 lookup 命中当配对成立。该方案证明约定的双库配对，不声称取得 mesh 原生实例 UUID。锚点注册/查询适配限定在 `src/mesh/**`，领域服务只接收受控配对结果；具体实现及失败/错库回归仍待完成。

### 不因上游变更重复立项的内容

- 现有十五类事件、public-types 和九策略槽基本兼容，未发现要批量重写的类型变化。角色 activation 按 mentions/to 唤醒是既有策略，不是上游回归。
- request/ack、Observer.replay、sameHost/outbox、定向 history、routed 恢复及终态/CAS 保护已有实现。它们从旧“待上游实现”移为“role 尚未接通或未验收”。
- role 的 cost、dangling、delivery 查询在当前 schema 可准备，不因 runtimeRef 改名重写所有 SQL。权限、窗口和归因仍按 R 项修。
- `src/mesh/timeline-lookup.ts:60–62` 查不存在的 text 列是**旧内部缺陷**。旧 schema 也没有 text，归 R36，不冒称 v0.2 新回归。

### 本轮 SQL 实验证据

上游审查使用 Python sqlite3 `3.45.1`、两份内存数据库，未打开或修改用户运行库：

1. 装入当前唯一 000，timeline 正文查询报 `no such column: text`。
2. delivery、cost 两组、dangling 和 drain 查询可准备；这只验证 SQL schema，不证明领域语义。
3. 从历史提交 `615c1f0` 装入 000–004，复现当前迁移算法拒绝旧迁移戳；旧表也确实没有 runtime_ref/submission_id。

这不是 TypeScript、Vitest、durable 或真实模型运行验收。

## 原必需任务：R01–R39

以下先接管旧计划的全部要求。主体实现未改变，不用新增文档把缺口视为已修复。上游适配及本轮新增反例并入原根因；不重复计算为新工作单元。

优先级：S0 为基础正确性、数据和隔离边界；S1 为核心生产链；S2 为观测、回放与验收。它们不是原来的 P0–P7 阶段编号。

| 编号 | 优先级 | 剩余目标与关闭标准 |
| --- | --- | --- |
| R01 | S0 | 分离真正公开对象与内部测试句柄。JavaScript 宿主不能取得 mesh/registry/registerAgent。库导入不修改进程环境；clipboard 规避由测试或宿主显式处理 |
| R02 | S0 | 限定 materialize、overlay 和 promote 的 ID/路径/别名边界。在写入前拒绝穿越。创建、生成或晋升失败可重试，旧蓝本与已有文件不受损；恢复不靠永久删除用户数据 |
| R03 | S0 | 副作用前拒绝 roleDb/meshDb 同路径、别名和同文件。工厂部分失败释放已打开连接。新 schema 初始化失败可重试；不静默复用或清除旧/不兼容库 |
| R04 | S0 | 注册前保存意图，分步恢复主账号、自省账号和回写。补注册回填绑定；registering 角色不能提前入场。增加 `createBatch`，逐项串行注册并报告成功/待恢复，不承诺跨库整批原子回滚 |
| R05 | S0 | 建立主流/自省流权威账号映射，独立模型、提示、目录和工具。新建与恢复经生产工厂取得正确绑定，不靠 fake 跳过解析 |
| R06 | S1 | 五层模型覆盖从公开入口可达。补温度、生命周期预算、真实用量和 onCost。增加独立 `setModelConfig`，安全 evict/warm，主/自省独立。情节、自省、检索写实际配置 hash 和无凭据快照；旧来源不伪造 |
| R07 | S0 | 生成、promote、create、overlay 共用完整 schema。补字段范围、必需文件、人格/知识/设施兼容字段和禁令。普通角色不得获得控制消息权限，宿主 cue 仍须合法 |
| R08 | S1 | 实装 `identity_read`、`protocol_query`、`note_self`。本人白名单可读，越界拒绝；note_self 写 self 情节及 P3 账，不额外注入全文。补 `Runtime.memory` 宿主只读检索/统计，区分 owner 与管理视图，不隐式强化或修复 |
| R09 | S1 | 增加 DB→实例文件 Projector，损坏可重建。manual 导入先审计再重投影。蓝本不变，投影不作为运行时记忆权威 |
| R10 | S1 | spec 版本/hash 漂移不得静默改变身份。补非 mesh `respec`、一致性报告及可恢复退役/删除。保留 mesh 历史；身份字段变化拒绝，不自动迁移 |
| R11 | S1 | 设施生成→promote→创建→执行→恢复贯通。持久化模板、模型、身份和状态，实装四工具。合法应答可用；非法主动发起拒绝并审计。与 R31 共用一套 owner/拒绝设计 |
| R12 | S1 | 保留 AuthorModel 注入。明确给出的 neverInfer 事实可按来源抄录，未知敏感字段不推断。allocation 的每条分配须有落盘字段证据；缺口报告准确。人格差异进入编译策略 |
| R13 | S0 | 真实消费完成后才推进场景轮次。floor 覆盖整轮，实际发言才记账；partial/延迟不提前推进。接 reactive/presence/真实状态和软硬预算；沉默不等于故障。场景总限与本次 run 上限分开 |
| R14 | S0 | 稳定 cue 幂等键、持久调度进度、成员变化、多个在途端点和中轮恢复不丢不重。abort 按 H04 停新 cue，不默认取消模型。在途收敛后按真实完成记轮次/用量；超时保留可恢复状态，不与并发 close 竞发新 cue。close/abort 不把未处理 delivery 伪造成 consumed，不在角色层复制 mesh 执行锁 |
| R15 | S0 | 权威时钟与发送装饰贯通。普通 mesh_send 补真实账号、scene/turn/virtualTs，并覆盖模型伪造字段。设施事件及场景归属可验证。分钟累计、跨日、倒退规则一致；来源时刻与整理时刻分开 |
| R16 | S1 | 接 scene_end、settled、唤醒度和 Q02 日终。顺序为记忆衰减→自省/知识迁移→知识衰减→队列整理。Q01 收敛后解散，有界超时及降级留痕。light/full 分档可查；恢复不重复日终 |
| R17 | S1 | 实际自省 cue 包含预算内画像、知识、队列、旧问题及可引用证据 ID。不只保存完整 input_json 而向模型发送摘要。连续自省不丢未解决问题与意图 |
| R18 | S0 | 校验结果结构、画像与知识证据 owner。区分非法条目拒绝与存储失败整次回滚。画像、知识、自我见解及审计同批一致；负 valence、自我关系和 delta 限幅正确。观测能读证据/scene/self 轨迹 |
| R19 | S0 | 发送前持久化自省批次与关联。快速返回、连续触发、迟交、重复、无输出、发送失败及重启都正确终结。成功游标不跳过未完成输入；领域幂等复用 mesh 调度，不加第二套串行锁 |
| R20 | S1 | 压缩只抢救 `rangeToSummarize`。输出留来源，重复去重，使用整理时刻。有界等待结果或明确超时降级，不吞错。不能把 cue 含原文等同完成提炼；须按新 SDK 能力重定接入点 |
| R21 | S0 | 同轮多 delivery、partial 后恢复、P3 静默零记忆、发送方补记和 written 结清均可溯源。不在 delivered 时误记未消费观察；reflect 流不计角色对话记忆 |
| R22 | S1 | 模板→工具参数→情节→衰减保留情绪、valence/arousal、感官、tau/growth 差异。senderRole 不用 agentType 代替。共享 quote/detail 范围；P2 不保存未见原文 |
| R23 | S1 | 接 L2 本人画像/知识、发送者印象与实时状态。无 L1 命中也可注入。L2 500 与瞬时 150 额度、owner 权限分别控制 |
| R24 | S1 | 统一在场主体 key，确保影响排序。retention 跨 0.70/0.45 边界时呈现不同 detail/quote，不改 DB 原文。Projector 复用保留规则 |
| R25 | S1 | 联合验 L3≤1200、L2≤500、L1≤900、瞬时≤150 及 recall 预留。可靠计量中文 token，丢卡不虚扣。空结果和显式 recall 留痕；最终上下文含未读+记忆+意图且次序正确。Q09/Q10 进入预算、成本和回放 |
| R26 | S0 | fading 的 mentioned 只能恢复衰减前状态，不能跳 mastered。持久化原状态。taught 符合 Q05，pending 日终幂等回补；跨 owner 核验只在受控服务返回布尔 |
| R27 | S1 | 模板误区/wrongBelief 兼容种入且幂等。运行期错误认知与纠正历史可追；纠正生成有归因的高显著情节，进入上下文。队列不泄露答案 |
| R28 | S1 | 队列跨自省保留。记录入队、触及、降档时刻和 revision；三虚拟日未触及降档，触及重置，同优先淘汰最旧。误区遵 Q03。已有队列注入不重复立项 |
| R29 | S1 | 用通用 purpose/schema 写教学进度，不加教师特例。多班/多课隔离，consolidated 仍可按用途检索，retention 有 0.7 地板。至多 3 条/200 token 独立记账。与最近 5 条 knowledge 主体求交，记录并呈现重复次数，不承诺模型绝不重复 |
| R30 | S0 | 完善 Scoped/Admin DAO 与无 owner 语句保护，保留已有工具闭包。管理统计不误套单 owner。devMode 关场校验；与 R16 统一挂载，正常和越界都测 |
| R31 | S0 | 无宿主 onEvent 也执行内部健康保护。policy_degraded/invariant 异常定位并只停止相关记忆写入。设施拒绝无 delivery、恰一条审计；未知 reason 保留并告警。不依赖可选转发回调 |
| R32 | S2 | 悬挂扫描覆盖情节、知识、检索和自省锚点。分类缺失/裁剪/不可见/换库；错库不误罚记忆。明确其审计与降置信副作用，先审计后改 confidence，不修改 status |
| R33 | S0 | role 生成并持久化双库配对标识，通过 mesh 公开账号 API 建立和校验锚点。约定配对成立才可读，错库/缺锚点拒绝出数。恢复、成本和悬挂扫描共用判据；不写 mesh schema，不用路径 hash/sidecar 假冒证明，也不要求上游新增 UUID。新环境不迁移旧 NULL |
| R34 | S1 | 走生产自省 cue 核对消息/投递归因。纯自省不入对话账，角色账+自省账可还原全账。不解析 `:reflect` 后缀，不用反向 cue 夹具代替实际路径 |
| R35 | S2 | agent/scene/since/until、小时边界和裁剪窗过滤一致。不把场景累计值按创建时间筛成窗口值。接真实模型用量；未知量标不可得，不以 0 占位。不要求无标签计数器回答细分问题 |
| R36 | S0 | 时间线展示按 Observer 可见性查原文。覆盖本人发/收、定向不可见、裁剪及错库。无 delivery 不直接等于无权，也不直接返回 L0。管理审计与角色展示分开 |
| R37 | S2 | 补公开 replay，按 H03 支持历史记录/领域决策回放与固定条件的隔离场景重执行。role 保存逐轮/空轮的领域决策快照、hash、参数、预算及 spec/model 指纹。来源、owner、fidelity 和缺失信息明确，不用当前配置伪造历史。重执行使用独立新环境，不污染原场景；模型输出不承诺逐字重现。不要求原会话任意历史点原位分叉，不等待 forkAt，不复制 mesh 会话/投递权威状态。原 F1–F5/RP1–RP4/T7 的关闭口径见下文；不以空类型关闭，Q10 不要求填满预算 |
| R38 | S2 | 补公开 compare。固定蓝本、探针、虚拟时间、预算，结构化比较记忆/知识/工具/成本。真实质量抽样与确定性机制分开，不把非确定性评分设为 CI 必过值 |
| R39 | S2 | 公共契约只经 index 建 Agent→场景→记忆→自省→观测。逐项补故障、崩溃、隔离、预算和真实上下文回归，再接 CI、类型和构建。静态扫描/fake/SDK/真实模型证据分栏 |

## 本轮内部缺陷与去重规则

本轮记录以下 38 个具体失败反例。A01–A37 来自静态控制流审查，**未运行对应 TypeScript 测试**；A38 另有本轮内存 SQL 失败证据。它们包括权限/数据边界缺陷、生产链中断和功能效果缺口，不全部称为安全漏洞。

A 编号只用于定位反例，不增加 38 个独立工作包，也不与 R/M 重复计数。归属列直接扩充相应 R 项的验收；M04 中的旧 drain 问题在此为 A10，不是两次发现。行号相对 role 本轮提交。

| 反例 | 源码位置 | 具体触发与错误结果 | 归属及验收补充 |
| --- | --- | --- | --- |
| A01 | `src/compile/materialize.ts:79,90,95–102`；`src/runtime/agents.ts:204` | `agentId='../../outside'` 或 overlay 父路径键未受包含检查，可在 root 外/其他实例写文件；失败清理还可能递归删除越界路径 | R02。ID/overlay 白名单、解析后包含与别名检查先于任何写入；清理只处理本次拥有的临时目录，不动现有用户文件 |
| A02 | `src/authoring/driver.ts:341,349–351,380` | stagingId/targetId 直接 join；例如 `targetId='../../../outside'` 可把 staging rename 到模板 root 外 | R02。源和目标都先校验，拒绝路径穿越/符号链接逃逸；失败无外部写入和损坏 |
| A03 | `src/runtime/pi-bindings.ts:88–99`；`src/mesh/pi-backend.ts:193–197` | 绑定只缓存主 agentId；resolve(A:reflect) 无 binding。真实后端拒绝创建自省会话，独立 reflectModel 不生效 | R05/R06。主/自省账号均走权威映射，以生产 create/open 捕获正确模型、提示和工具 |
| A04 | `src/reflect/service.ts:545–550`；`src/scene/orchestrator.ts:88–90,278`；`src/scene/cue.ts:38` | 默认角色 initiate 只有 chat，却由普通主/host 角色发送 system。权限检查拒绝合法场景或自省 cue | R07/R13/R19、Q04。换合法宿主控制发送者，不通过给普通角色开放 system 修复；正向 cue 与越权拒绝都测 |
| A05 | `src/runtime/agents.ts:158–162,226–240,281` | registering 行 projection 为 NULL；注册失败后 reconcile 要求非空，create 重试又撞 ID，active 恢复不处理该行且不补绑定 | R04。注册前保存完整意图；每个失败点重启后能补齐或明确停止，不靠删角色行重建 |
| A06 | `src/scene/orchestrator.ts:361–383` | 只等待 sendCue 返回就记 lastSpoke、清 floor、推进轮次，真实回复/consumed/turn_end 尚未发生 | R13/R14。发送成功不等于一轮完成；partial、迟回复、沉默、重启不提前计发言 |
| A07 | `src/scene/orchestrator.ts:307,378` | 每轮 dao.advance 的 token 增量为 0；实际模型生成费用永不累计，预算熔断无法生效 | R06/R13。真实 usage/回调贯通，累计总限与本次 run 限分开，超额如实留痕 |
| A08 | `src/scene/orchestrator.ts:263–267,295–384,412–415` | run 只在开头检查 active；并发 close 标 ended 后，drive 仍可发 cue 和写推进 | R14/R16。单场景生命周期阻止关闭后新调度；状态更新有条件守卫，已有 submission 收敛。不复制 mesh 执行锁 |
| A09 | `src/runtime/virtual-clock.ts:21,76–81`；`src/scene/orchestrator.ts:280,377–378` | 30 分钟轮长生成 `W1D1T8.5`，下一次整数小时 parser 拒绝，坏时间落库后 resume 失败 | R15/E01。整数分钟与兼容新字面量；保持旧原点，跨日及失败恢复无浮点格式 |
| A10 | `src/mesh/drain.ts:32,39`；`src/runtime/runtime.ts:284` | drain 把所有 delivered 标 consumed。活跃 P1 在真实 turn_end 前结清，破坏恢复和游标，且不减少真实 inFlight | R14/R21/M04。由 submission 权威对账；P1/P2/P3 分开测试，不伪造消费加速关闭 |
| A11 | `src/memory/service.ts:339–349` | 同账号 D2 覆盖 turns 中 D1；D1 consumed 取到 D2 的 turn 又删除，来源、预算和工具配额错位 | R21。同轮多 delivery 有稳定关联；乱序消费/重投不串来源，不双记账 |
| A12 | `src/reflect/service.ts:154–171,266` | await send 后才登记关联；快 reflect_result 得 TOOL_DISABLED；重叠请求共用账号单键，结果可能归错批次 | R19。发送前保存批次关联，快返回/重叠/迟交/重启均只结算正确批次 |
| A13 | `src/reflect/service.ts:291–441,454–482` | 合法 profileUpdates 已提交，后遇 `selfInsights.detail={}` 的 slice 抛错；批次 failed 却残留画像变更 | R18。嵌套结构先验，非法条目拒绝与存储失败回滚分开；整批失败不残留已提交 delta/知识/审计 |
| A14 | `src/knowledge/types.ts:176–179`；`src/knowledge/service.ts:85` | fading 的 mentioned 可以指定 mastered；仅 solved 分支的晋级门槛未覆盖这条路径 | R26。mentioned 只恢复衰减前状态；无充分证据不能跨级晋升 |
| A15 | `src/compile/materialize.ts:90–102`；`src/runtime/agents.ts:118,202–204` | cp 后 overlay 失败发生在 create 清理 try 外，遗留 identityDir；正常同 ID 重试永久失败 | R02。先临时物化/校验再提交；失败可重试，清理不触碰别人的目录 |
| A16 | `src/authoring/driver.ts:344,378–380` | mkdir/rename 前删 META_FILE；文件系统失败后 staging 丢 provenance 元信息，不能再 promote | R02。保留可恢复元数据直至提交，模拟 rename/mkdir 失败后重试和 provenance 完整性 |
| A17 | `src/scene/scenes-dao.ts:151–155` | listActive 的 SQL 缺 SELECT，调用即 prepare 失败。尚未确认它的公开生产调用，不据此声称全部 resume 必失败 | R14/R39。修 helper SQL 并测列表；若恢复依赖此入口，另补生产调用验收 |
| A18 | `src/scene/orchestrator.ts:227–254,278` | create 忽略公开 hostAccountId/conversationId，始终新建群且不存 host。run/resume resolveHost 收到 undefined | R13/R15、Q01。尊重并校验选项，或明确拒绝与一场景一群冲突的输入；不静默丢参数 |
| A19 | `src/mesh/session-factory.ts:97`；`src/mesh/bootstrap.ts:116–120` | bootstrap 未传 extProvider，工厂还用空账号调用 provider；普通 mesh_send 无权威场景/时间，记忆回默认起点 | R15。真实账号→场景/轮次/分钟装饰贯通，新建和恢复覆盖伪造 ext，非场景事件有明确来源 |
| A20 | `src/memory/service.ts:320–325` | P3 设施事件先 observeFacility 写 observation 再 return，违反静默零情节 | R21。先按消费档判断写入资格；P3 设施也零对话情节，实际 written 单独结清 |
| A21 | `src/reflect/dao.ts:88,119`；`src/reflect/service.ts:119–120` | latestReflection 不过滤 done；failed/running.started_at 推进 since，把未成功处理的旧 episodes 排除 | R19。成功游标独立于最新尝试时间，失败/无输出后下一批仍包含未完成证据 |
| A22 | `src/reflect/service.ts:519–531,575–587` | DB input 含 IDs/画像/知识，但实际 cue 只有前 8 条 gist；模型看不到合法 episodeIDs，无法提交有锚巩固 | R17。捕获真实模型输入，预算内给完整可引用证据与队列/问题；不能用 input_json 存在背书 |
| A23 | `src/reflect/service.ts:219–230,379,581–583` | harvest 只等发送、不等结果；cue 丢 msgId，selfInsight sourceMsgId 为 NULL，重复 compact 不能按来源去重 | R20。范围/来源/整理时刻保留，等待完成或明确超时；重复压缩不重复落情节 |
| A24 | `src/reflect/service.ts:319` | valence=-0.8 被 clamp01 改为 0，负面变中性 | R18。valence 限 [-1,1]，trust/closeness 限 [0,1]；边界与合法负值回归 |
| A25 | `src/memory/retrieve.ts:130–133,160–168` | 剩余 100 token 时，150-token 卡先占部分 100 再整卡丢弃且不返还。后续 50-token 卡没有可用额度；空注入却账满 | R25/Q10。不可投放卡不扣账；最终卡片/用量/裁剪标记一致，允许未满 |
| A26 | `src/memory/retrieve.ts:155–156,170–172`；`src/memory/tools.ts:192` | 检索器把 600 perCall 当作 perCard。两张 350 卡在共享 900 内合计 700，超过单次 recall 的 600 | R25。单次总额与共享总额分别硬限，多次 recall 与自动注入联合验收 |
| A27 | `src/memory/retrieve.ts:50`；`src/memory/service.ts:230` | present 保存 person:B/facility:B，匹配却查裸 B，在场主体加权失效且类型空间混淆 | R24。统一 (type,id) key；同 ID 不同主体类型隔离，指定在场项影响排序 |
| A28 | `src/memory/render.ts:35–38,108–113` | projectEpisode 保留 detail/quote，render 却只给 gist；高 retention 时仍看不到细节/原话 | R24。测试实际最终卡片跨 0.70/0.45 的展示差异，DB 原文保持不变 |
| A29 | `src/memory/dao.ts:311`；`src/memory/service.ts:373–374` | 自动 FTS 把整条自然语言入站当精确短语；仅主题/人物相同而措辞不同的旧 gist 无候选，后续主体排序无法补救 | R24。作为召回效果缺口验收，冻结主题/主体候选 fixture；不声称所有输入均无召回，不擅自改用向量检索 |
| A30 | `src/memory/tools.ts:112–133`；`src/observe/timeline.ts:138` | P2 摘要 remember 仍可写精确 quote，只降 confidence。时间线因有 quote 给 L1，形成未见原文的引文证据 | R22/R36。P2 拒绝未见原话/精确 quote，证据等级依来源而不是是否填了 quote |
| A31 | `src/memory/dao.ts:119–122,151–159,181–189`；`src/memory/subject.ts:74–76` | duplicate subjectRefs 只插一条 relation，但多次增加 profile count/证据，画像重复计入同一情节 | R22/R18。按 (type,id) 去重或只在关系插入成功后 bump；画像计数可由唯一关系还原 |
| A32 | `src/knowledge/dao.ts:360–380` | τ 用当前 mastery；同 now 先 mastered→fading 后，第二次扫描换小 factor，可再变 forgotten，遗忘取决扫描次数 | R26/S03。保存稳定衰减基准/前状态；同虚拟时刻重复 decay 幂等，新版本内不靠重建绕过状态错误 |
| A33 | `src/knowledge/service.ts:185,189–190,205–207` | 误区先 high 入队，却又因 applied/mastered 无条件删除 | R28/Q03。误区优先，解除且达标才出队；motivation 不泄露错误答案 |
| A34 | `src/knowledge/service.ts:187–203`；`src/reflect/service.ts:435` | 新自省省略 learningQueue 变空数组，不合并旧队列，未完成 A 消失 | R28/E07。每批完成 output 保存完整保留后的队列，省略不等于清空；跨批/重启保留时间与 revision |
| A35 | `src/knowledge/dao.ts:427–435` | 最新 failed 的非空 error output 遮蔽旧 done 合法队列，读取返回空 | R28/R19/E07。只取最新完成且有效的完整快照；agent_state 不变成第二个队列权威 |
| A36 | `src/observe/cost-view.ts:75–97,121–143` | scope 声明 agentIds=A，retrieval 只按 scene 把 B 计入，roleOnly 又只按时间；同 scope 包装不同数据段 | R35。支持一致过滤，或准确声明每段 scope/不可得量；agent/scene/窗口交集可核对 |
| A37 | `src/runtime/runtime.ts:279–286` | closed=true 先设置；drain/mesh.close 失败后 roleDb 未关闭，第二次 close 直接返回，资源无法重试释放 | R03/R14。关闭阶段/promise 保证失败可重试和连接最终释放；并发 close、各阶段异常有回归 |
| A38 | `src/mesh/timeline-lookup.ts:60–62` | 非空 msgIds 进入正文查询，SELECT text 报 `no such column: text`；旧/新 schema 都只有 payload | R36/WP12。正确解码 payload/Envelope 后仍做可见性/裁剪/实例检查，不借修 SQL 开放 L0 |

优先复核和修复四类问题：

- 文件边界：A01/A02/A15/A16。
- 注册/自省关联与事务：A03–A05/A12/A13/A21。
- 真实轮次/关闭/投递：A06–A11/A19/A20/A37。
- 知识晋级与队列：A14/A32–A35。

检索、成本和展示缺陷在其原工作包关闭，不因标为 S1/S2 免除发布验收。

## 工程默认方案与初始 schema 设计

E01–E11 接管旧工程方案，并按 H01/H02 去掉旧数据迁移前提。代码尚未调整；schema 与 API 设计在 role 侧完成，不要求 mesh 改动。

| 编号 | 当前方案和边界 |
| --- | --- |
| E01 | 用整数虚拟分钟计算。接受 `W3D1T14` 与 `W3D1T14:30`，保留周/日原点。小时输入乘 60；新库直接存分钟，不生成浮点小时字面量，不要求迁移旧小时字段 |
| E02 | 场景持久总轮数；`run.maxTurns` 仅限本次完成数，返回本次/累计。真实生成用量到软限后停止新 cue，在途收敛。超额如实记账，不承诺事后截断已发生用量 |
| E03 | 停止发送/收敛/结束自省/解散/检查分阶段。收敛与压缩等待默认可配置 30 秒真实时间，支持注入时钟。abort 按 H04 停新 cue，不默认取消模型；等待超时返回未完成/降级，迟交仍按实际状态处理并记真实用量，resume/重启可续。不在收敛前宣称关闭成功，不伪造 consumed 或复制会话历史 |
| E04 | 无输入自动 skip；少量低唤醒 light；阈值来自 MemoryPolicy，固定 fixture 为 3 条/0.6。scene_end 有输入 full，pre_compaction 有范围 full，手动可 full。light 不改 L2。批次按触发优先级合并，mesh 串行，role 关联幂等 |
| E05 | quote 默认最多 80 Unicode 码点，detail 最多 400。超限给结构化错误要求重试，不静默截断。P2 不保存未见引文，展示仍受预算；不设旧超长数据保留的发布门槛 |
| E06 | owner 的版本化 agent_state 键保存有界 pending_taught 索引。留讲者情节、听者、topic、原时刻与状态。完成/拒绝留 state_writes 和不可变知识归因，不因超时自动 mastered |
| E07 | 最近完成自省的完整 output 快照是队列读取依据。每批保留旧项/时间/revision。无 LLM 日终用完成的 light 快照；agent_state 只存阶段/幂等，不造第二个当前队列权威 |
| E08 | role 新建时生成并持久化配对标识，以 mesh 公开账号 API 的持久锚点核验对应库，缺失/不匹配则拒绝相关读写。启动不得自动为已有 role 库重绑另一 mesh。无需 mesh 全局 UUID，不写上游 schema，不用路径 hash/sidecar 冒充证明 |
| E09 | 正规化实际配置，去凭据后写 hash 与版本化快照。setModelConfig 独立于 respec。新产生的记录必须留实际配置；不可得信息标 unknown，不用当前配置回填伪历史 |
| E10 | 新建和恢复都校验 schema、配对、owner、model、time 与身份。旧/不兼容开发库明确拒绝并提示重建，不默认激活、不静默清库。取消旧角色兼容/历史保留报告，保留新版本内的完整性报告 |
| E11 | 候选仍为 0.1.0，用制品编号/提交 hash 区分。目标版本占用则停止，不覆盖、不擅改版本。最终发布包须与受验包校验和一致 |

### S01–S07：一次冻结初始 schema

取消必须按 schema 1→2 编写 `002_release_closure.sql` 的旧方案。尚未发布，可以重新定稿 role 初始建库脚本、schema 版本与结构指纹；具体编号在 WP01 冻结。旧库即使有同名版本戳，也不能因此当作新结构。npm 版本仍为 0.1.0，mesh 脚本与版本不变。

| 编号 | 设计范围 |
| --- | --- |
| S01 | role 配对元数据、agents 注册意图/阶段；agent_specs 在新版本内的不可变 revision 与文件指纹 |
| S02 | scenes 分钟时钟、轮次/关闭阶段、稳定 cue 引用和调度进度。只存领域意图与 mesh 引用，不复制 delivery |
| S03 | episodes、knowledge_items/events 分钟时刻、稳定衰减基准/前状态、taught 归因、来源与用途；保留本版本内模型 hash 历史 |
| S04 | reflections 深度、批次幂等、完成游标及可恢复状态；input/output 是不可变批次快照，先关联后发送 |
| S05 | agent_state/state_writes 的版本化 pending、日终、设施与无凭据模型快照。每个键指定唯一写入服务 |
| S06 | retrieval_log 教学进度/分层预算/版本/来源/调用 ID。区分 auto 与 explicit recall；多次显式回忆可共存，自动幂等，空结果留痕 |
| S07 | boundary_events、memory_decisions、subject_profiles 的归因/幂等/健康类型/消费阶段/画像证据。上游 reject 与本地健康码分开 |

14 张表是当前库存，不是新设计的硬限制。可以增改领域表以承载配对等现有目标，但保持双库分离，不增加 mesh 表、ATTACH 或角色会话镜像。WP02 统一实现已冻结的字段、索引和 JSON schema；其他工作包不临时补列。

新建与重建按以下步骤验收：

1. 列明目标 role DB、mesh DB 和 durable 会话目录，确认使用新路径或明确的开发数据重建范围。若替换现有文件，先停止写者、关闭连接，识别 WAL/SHM；不在普通启动路径自动删除。
2. 固定 mesh 自行创建自己的新库；role 创建新领域 schema，通过公开 API 建立配对锚点。不要只重建一侧却沿用另一侧的失配角色/会话引用。
3. 验证空库初始化、主键/owner/引用/FTS、版本/结构识别、配对失败及初始化失败重试。无需原版程序或旧库迁移对照。
4. 在新版本内做正常重启与真实崩溃恢复，核对注册、自省、投递、队列和会话引用不丢不重。重建许可不能代替这些恢复要求。
5. 将开发重建与首次发布后的升级分开。首次发布后，后续 schema 变更必须另设前向迁移和数据保留策略；本次许可不是永久清库许可。

## 可选增强：O01–O07

| 编号 | 项目 | 前置与边界 |
| --- | --- | --- |
| O01 | exportAsBlueprint | R09/R10/R12 后，从可信成长状态导出谱系与隐私受控的新蓝本，不覆盖原蓝本 |
| O02 | 完整 director 剧本 | 已有基础轮转不是完整剧本。R13/R14 后补顺序、条件、恢复位置与失败边界 |
| O03 | 可替换向量检索 | R24/R25 后同输入/预算比较，保持 owner 隔离和回放元数据 |
| O04 | scenes.pause | R14/R15 后区分 pause、abort、close，暂停持久化且重启可恢复 |
| O05 | scenes.inject | R13/R15/R31 后补授权、归属、审计与恢复，不暗中加入核心发布 |
| O06 | 跨学期长期巩固 | R09/R16/R27 后验证长跨度和批次幂等，不用真实时间替代虚拟时间 |
| O07 | 多进程部署 | 先核验当前 outbox/transport/租约。不复制通信运行时。上游缺能力不阻塞单进程核心 |

## 文档工作：D01–D02

| 编号 | 本轮与后续边界 |
| --- | --- |
| D01 | 本轮归档旧 plan、更新入口及历史标记说明。后续按真实验收同步任务/测试数量、fake/SDK 范围及能力支持；本轮文档整理不等于关闭全部 D01 |
| D02 | 后续把 H01–H04、Q01–Q10 和新 mesh 事实落入权威设计/策略契约；相冲突的旧分叉/取消要求由本计划明确覆盖。保留原约束、例外、来源和兼容影响。本轮不重新定稿万行设计 |

## 工作包与执行顺序

本轮只整理计划。以下实施工作包均未启动，不据历史人天估算承诺新工期。每包启动前指定负责人及复核人；交接含文件、关闭项、反例、实际检查和剩余限制。

| 工作包 | 主关闭项 | 前置 | 退出标准 |
| --- | --- | --- | --- |
| WP00 | U01–U03、固定 mesh 的 role 适配与发布前提 | — | 冻结当前 mesh 提交、SDK/Node/npm/产物指纹及 role 适配方案。确认 file 配套安装、新库环境、两平台与真实模型预算。不等待 mesh 修复，未知/unsupported 不冒充可用 |
| WP01 | R07、API/初始 schema/fixture 冻结 | WP00 | 共享模板、权限、预算、错误和 S01–S07 新库契约可实现；冻结脚本/版本/指纹和配对锚点，再写代码 |
| WP02 | R03/R30/R33 | WP01 | 新 schema 初始化、同文件检测、失败释放、DAO 边界与 role 配对锚点。空库/重开/错库/失败重试通过，不要求旧库迁移 |
| WP03 | R01/R04/R05/R06 | WP02/WP04 | 公开对象、注册恢复、双流绑定、模型覆盖/更新、真实用量与历史 hash 贯通，含 SDK 适配 |
| WP04 | R02/R12 | WP01 | 文件边界、恢复型 promote、明确事实和真实分配报告；可与 WP02 并行 |
| WP05 | R13/R14/R15 | WP03 | 权威分钟时间、实际消费推进、稳定 cue、总/本次预算贯通。按 H04 验收 abort 停新 cue、在途/迟交的真实用量、有界收敛和恢复，不默认取消模型，不伪造消费 |
| WP06 | R08/R21–R25 | WP03/WP05 | 多投递记忆、三件工具、宿主只读门面、L2/状态、硬预算/快照与最终上下文 |
| WP07 | R17/R18/R19 | WP03/WP06 | 完整证据输入、持久自省批次、事务和画像观测、迟交/失败游标 |
| WP08 | R26–R29 | WP06/WP07 | taught/T9、误区、队列时间、通用进度与重复检测；先以显式虚拟时点测算法 |
| WP09 | R09/R10 | WP07/WP08 | Projector、manual reconcile、spec 守卫、respec、退役与历史保留 |
| WP10 | R11/R31 | WP03/WP05 | 设施 owner/四工具/恢复与拒绝、内部健康停写一并闭环 |
| WP11 | R16/R20 | WP05/WP07/WP08/WP10 | 场景分阶段关闭、睡眠日终、压缩范围/等待/降级和中断恢复 |
| WP12 | R32/R34/R35/R36 | WP06/WP07/WP08/WP10/WP11 | 可见性展示、实例/裁剪分类、自省对账、窗口和未知量 |
| WP13 | R37/R38 | WP09/WP11/WP12 | 按 H03/C02 实现历史记录/领域决策回放、隔离场景重执行与结构化 compare。核验快照/hash、固定条件、owner/来源/fidelity、原环境不变和新旧成本分账；原会话任意历史点原位分叉不在范围。不等待 mesh 新能力，不用空实现放行 |
| WP14 | R39、DIF/T/包外验收 | WP04/WP09/WP10/WP11/WP13 | 两平台、新建/崩溃、公共契约、差异机制、SDK/真实模型与长跑分栏通过 |
| WP15 | D01/D02、受控发布 | WP14 | 文档、评审、清单/许可证/校验和及受控消费齐备；发布仍需独立显式批准 |

L2 先用持久化 fixture 验收，再由真实自省生产者做端到端验证。日终调度不反向阻塞知识算法。设施与拒绝审计归同一工作包，避免依赖环。

## 验收账本

### T1–T7 与公共契约

| 验收族 | 必须补足的行为证据 |
| --- | --- |
| T1 上下文 | 捕获最终模型输入；未读/记忆/意图次序，中文硬预算、recall 预留、空结果、新建/恢复等价。不只扫描 hooks 字符串 |
| T2 策略失效 | 逐槽异常/超时、降级审计、受影响会话停写；正常路径健康事件为 0。不只注入计数值 |
| T3 并发与恢复 | 真实子进程中断、同轮多 delivery、迟交/重复、自省无输出、注册逐失败点与单写者边界。abort 停新 cue 后，在途正常完成、超时迟交、真实用量及 resume 都正确；并发 close 不继续调度。不以正常 close/open 代替崩溃，不要求默认取消正在生成的模型 |
| T4 存储 | 双库同址/别名、role 配对锚点错配、全部来源锚点、FTS、新库初始化失败/重试、版本与结构识别。不要求旧库升级一致性 |
| T5 隔离 | owner recall/写入、Scoped/Admin、控制消息禁权及合法宿主 cue、self 关系边界、工具身份闭包 |
| T6 观测 | 生产自省 cue 排除、agent/scene/since/until、小时/裁剪窗、不可得量、拒绝/健康审计及实例判据 |
| T7 回放 | 按 H03/C02 核验记录回放与固定条件隔离重执行。逐轮/空轮快照、hash/spec/model、预算/owner、来源/fidelity 和缺失信息准确。重执行不写原环境，compare 固定条件且新旧成本分账。确定性机制可重现，真实模型输出不要求逐字相同。原会话任意历史点原位分叉明确不支持，不等待上游新增 API |
| 公共契约 | 从 index 或候选包运行建角色→场景→记忆→自省→观测，不借内部 mesh/registry 完成主流程 |
| PA/设施 | 非法路径、晋升失败恢复、真实字段分配、共享 schema、生成设施→执行→重启恢复 |

### 回放关闭口径：接管旧 F1–F5/RP1–RP4

H03 替代旧 F1–F5/RP1–RP4 及 T7 中的原会话任意历史点原位分叉要求。这些分叉条款不再是本次发布门槛。核心 replay/compare 并未删除，统一按以下行为关闭：

1. **记录回放**：只读当时保存的逐轮/空轮领域决策和检索快照，核对 hash、参数、预算、spec/model 指纹与来源。缺失或裁剪信息明确标记。当前 inbox、当前模型配置和重新计算结果不冒充历史记录，也不冒称得到未记录的完整最终 prompt。
2. **隔离重执行**：冻结蓝本、初始领域状态、探针、虚拟时间、预算及模型/SDK 配置。在独立的新 role DB、mesh DB 和 durable 目录中执行新场景。初始状态来自明确记录的 fixture 或领域快照，不复制 mesh 会话/投递权威状态。验收原环境未变，新执行有独立身份和来源。
3. **compare**：输出结构化的记忆、知识、工具和成本差异，保留输入及指纹。原运行用量不因重执行而改写，新生成的实际用量另记。确定性机制按冻结 fixture 比较；真实模型质量另行抽样，不要求输出逐字相同。
4. **权限与支持边界**：记录与重执行均受 owner、来源可见性和双库配对约束。原会话任意历史点原位分叉明确不支持。不能绕过固定公共契约调用私有接口、返回空成功或开放宿主全量历史来补足。公开入口与候选包必须实际运行上述支持的流程。

### 已有测试不能背书当前契约的三处反例

- `tests/memory.test.ts:615–660` 名为“150-token 预算硬截断”，实际断言只要求 `tokens_transient <= 200`。该断言不能证明 R25 的 150 硬上限。
- `tests/recovery.test.ts:49–80` 在同一进程使用 fake，正常 close 后再次 createRuntime。注释中的“进程一/二”不能证明 R04/R14/R19 的崩溃恢复。
- `tests/scene-acceptance.test.ts:150–176` 要求 close 后群仍 active，与 Q01 的收敛后解散冲突。修 R16 时须改契约和测试，不能以该旧断言继续证明符合现行决策。

这三处已核对源码，但本轮未运行这些测试。它们归入 R25/R39、R04/R14/R19/R39、R16/R39，不新增功能编号。

### DIF01–DIF08：角色差异性

统一模型/配置、消息、顺序、初始关系和虚拟时刻，只改变待测模板字段。fixture 在实施前冻结，不看候选输出后调整。留 spec/model hash、六路分量、选中 ID、retention、画像 delta、知识事件、队列 revision 与预算；不保存认证材料。

| 编号 | 必须证明 |
| --- | --- |
| DIF01 | 至少三模板改变尽责性、新奇偏好、负面敏感度。用 0.2/0.8 固定参数验证编译；交换名字后差异跟随模板，缺值中性、非法值拒绝 |
| DIF02 | 同经历下预先指定的阈值内/外/等于阈值事件产生预期 write 差异。独立参考值，不用被测函数生成 expected；同模板重放相同 |
| DIF03 | 中性/负面情节在 0/24/72 虚拟小时和 0.70/0.45 边界展示差异。情绪经工具落库；仅对指定非饱和 fixture 要求单调，原文不改 |
| DIF04 | 相同证据、不同 growth/trust 的合法 delta 仍受硬限幅；缺 owner 证据不变更，同自省重复不重复生效，观测可解释 |
| DIF05 | 同 topic 的已掌握/薄弱/误区初态经过讲者、听者、睡眠日终。pending 双证据后才成立，误区 high、三日降档及真实意图输入可见 |
| DIF06 | 两班两课、最近 5 条和 consolidated 的通用进度过滤准确。重复集合可检出，至多 3 条/200，基础/额外分账且总额≤2950 |
| DIF07 | 不改源码加入未知第四角色，跑创建/场景/记忆/自省/恢复。无角色名称特例；权限、owner、工具和预算一致，不只做关键词零命中 |
| DIF08 | 从候选包与配套 mesh，只经公开入口走真实 SDK 闭环，含重启和换模型。历史 hash 不变，不借内部句柄救场 |

DIF01–DIF07 的确定性断言是硬门槛：跨 owner 泄露、无证据升级、重复副作用均为 0。真实输出不要求逐字相同或每轮提问。模板差异在饱和边界可以得到相同结果，不以差异越大越好评分。

真实模型抽样另行批准模型、费用上限和评估者。保留旧样本下限：3 场景×3 模板×3 次运行，DIF08 和第四角色冒烟另登记。先验权限/预算/硬链路，再按角色约束、可解释差异和知识连续性评审。未授权则未执行，并阻断最终发布，不挑成功样本或事后改阈值。

### G0–G5：发布关卡

| 关卡 | 放行条件 |
| --- | --- |
| G0 | 固定 mesh 的 role 适配证据、受控 file 安装、registry/scope、两平台、新库环境及模型预算就绪。无旧库迁移或 mesh 修复门槛 |
| G1 | API/初始 schema/fixture 冻结，新库初始化/配对/失败重试及结构识别通过；不要求旧库兼容报告 |
| G2 | R01–R31 的相应核心生产链与 DIF01–DIF07 通过；候选不等于已发布 |
| G3 | 观测与 H03/C02 定稿的记录回放、隔离重执行及 compare 有公开运行证据。来源/fidelity、owner、原环境不变、新旧成本分账和 Q09/Q10 通过。原会话任意历史点原位分叉明确不支持，不以该范围外能力阻断。不伪造支持或以待上游修改放行 |
| G4 | 两平台 T1–T7、公共契约、新建/崩溃、DIF08/抽样通过。另跑 5 角色×20 轮、30 角色×100 轮及 24 小时受控非真实模型长跑；记录资源趋势，不编造统一性能指标 |
| G5 | R 关闭证据、D 文档、物料/许可证、制品 sha、受控消费与发布/撤回清单齐备。版本占用检查通过且获得独立发布批准 |

### 保留 file 依赖的发布验收

1. 用冻结 npm 验证 registry/tgz 的 file 路径解析，再验证取制品、校验、解包到同级目录的受控方案。只支持实测通过的路径，不承诺任意目录一次普通 npm install 可用。
2. 显式提供批准版本的 mesh 目录和产物，记录 commit/包版本/构建指纹与布局。缺失则预检失败，不自动换 registry 包。
3. 打包前后核对 file 原字符串。检查 ESM/CJS/DTS、初始建库脚本定位、README、许可证和 files 白名单；排除凭据、用户库、会话及私有配置，审查 sourcemap。
4. 在空受控环境做两平台 JS ESM、CJS、类型、native SQLite、初建/失败重试/关闭/恢复。只放候选和批准配套依赖，不借 src、开发缓存或隐式认证。
5. 不向目标 registry 提前写入 0.1.0 试验包。候选用编号/sha 保存；正式发布另行确认，失败先查远端状态，不盲重试或覆盖。
6. 制品撤回/标签与数据回退分开授权。先停推广并保留新写入，不把 registry 回退当 DB 降级。

## 已确认边界与执行登记

用户已确认全部推荐方案，C01–C03 均已定稿，目前没有剩余产品决策。不再询问 mesh 修复、旧数据迁移、回放粒度或 abort 默认语义。接口编码、schema 编号和 SDK 接线由工程核验，不转交用户选择。方案确认不等于业务代码已完成，也不代替模型费用、发布与撤回的独立授权。

| 决策项 | 状态 | 已定稿的影响与边界 |
| --- | --- | --- |
| C01 固定 mesh 与新建库 | 已确认，见 H01/H02 | 所有适配在 role，环境用新库；不改 mesh、不等新接口、不迁移旧开发数据。配对以 role 锚点实现，不再要求上游全局 UUID |
| C02 回放的产品粒度 | 已确认，见 H03 | 历史记录/领域决策回放，加固定条件的隔离场景重执行与 compare。原会话任意历史点原位分叉不在本次范围；不等待 mesh forkAt。R37、旧 F1–F5/RP1–RP4、WP13、T7 与 G3 按上述回放关闭口径验收，核心回放保留 |
| C03 abort 的取消语义 | 已确认，见 H04 | 只停止新 cue，在途模型/submission 收敛，记录真实用量并保留 resume 状态；不默认取消正在生成的模型。收敛超时、迟交和重启有回归，禁止伪造 consumed。更强模型取消不属于本次默认能力或关闭门槛 |

### 执行前登记与外部操作授权

- 环境按当前 mesh 要求对齐 Node.js 24+，冻结精确 Node/npm/原生 SQLite/SDK 与源码产物指纹，再调整 role 依赖和锁；保留 file 原字符串。本轮不安装，Node.js 版本要求不是任意可选项。
- 准备新的 role DB、mesh DB 和 durable 目录，以及初始化/重启/崩溃 fixture。无需旧数据迁移样本；真实重建前列明目标，不读取或记录凭据。
- macOS ARM64 与 Linux x64 glibc 测试环境、私有 registry/scope/发布者仍需执行阶段登记。发布、撤回、模型/费用上限/评估者分别显式批准，不由历史计划字样代替授权。
默认实施顺序：

1. WP00：固定契约与适配前提核验。
2. WP01：共享契约冻结。
3. 文件/存储/注册/自省事务等 S0。
4. durable 适配与场景/记忆。
5. 其余核心与验收。

按已确认的 H01–H04 推进 role 工作包，不再等待上游修复、旧数据迁移或 C02/C03 的产品裁定。新版本内的恢复和核心验收仍须通过；O 项后置。

## 关闭与进度

每个工作单元只有同时满足以下条件才关闭：

1. 公开或生产调用链可达，不只是 helper/类型/测试夹具。
2. 正常、失败、恢复、隔离与对应 Q 决策有证据。
3. 实际执行适用检查，记录环境/依赖指纹、结果和未测限制。
4. 使用固定 mesh/SDK 的公开契约并取得行为证据；不依赖私有出口、过时 stub 标签或空实现，也不以待上游修改作为完成依据。
5. 更新本计划、技术差异和评审。候选完成、可发布、远端发布成功分别记录。

2026-11-02：完成计划完成度、内部缺陷和上游兼容三项审查，并统一文档。四份旧 plan 替代归档，原正文逐字保留；新计划初稿提交后，经下述用户确认转为 active。实施和发布均未启动。

- 完成度：R01–R39 可关闭 0 项，7 项未见目标实现，32 项部分实现。旧 53 个复合条目按阶段归并，不用 51 个勾选计算完成率。
- 反例：A01–A38 已登记源码位置、触发、错误结果、R 归属与验收；M00–M05/U01–U03 和 C01–C03 已登记。静态审查不冒充运行通过。
- 已执行：role 源码门禁多次检查，73 文件通过；内存 SQL/迁移算法实验见专节。四份归档正文保留、44 个本地 Markdown/related 目标、全部继承编号与新增反例覆盖、唯一当前 plan 检查通过。文档无尾空格/冲突标记，git diff 空白检查通过。
- 写作复核：已拆主要长句，统一工具名为 protocol_query。中文 linter 已运行，仍有术语和长表格提示；人工复核后保留必要表达，不宣称零提示。
- 改动范围：只有 role 文档。role 的源码/测试/迁移/包配置/锁/脚本无改动，mesh 工作区无改动；无暂存、提交、推送或发布。
- 未执行：npm ci、类型、Vitest、构建、打包、包外消费、真实 SDK/模型、跨平台及崩溃/旧用户数据迁移验收。两仓缺依赖，当前 Node.js 低于 mesh 的 Node.js 24+。

2026-11-02（用户反馈后）：H01/H02 已确认。mesh 固定，由 role 适配；未发布数据库可重设计和重建。已修订 B04–B06、M00、R03/R33/R37、E/S、WP/T/G 与剩余讨论，取消旧数据迁移和上游修复门槛。R33 改为 role 公开账号锚点方案；schema 编号/结构在 WP01 定稿。本次仍只改文档，未实际清库或修改 mesh。

2026-11-02（用户确认全部推荐）：H03/H04 与 C02/C03 已定稿，计划转为 active。回放采用历史记录/领域决策回放及固定条件隔离重执行/compare，不要求原会话任意历史点原位分叉；abort 停新 cue，让在途收敛，不默认取消模型。已同步 R14/R37、M04/U01、E03、WP05/WP13、T3/T7、旧 F/RP 关闭口径、G3 及根 AGENTS.md。R 项未因此关闭，本次仍只更新文档。

当前没有剩余产品决策。环境版本、schema 编号、引用编解码及 SDK hooks 接线由工程核验；真实模型费用、私有发布和撤回等外部操作仍需各自授权。后续按 H01–H04 准备 role 工作包，归档文档中的旧记录不覆盖这些用户决策。
