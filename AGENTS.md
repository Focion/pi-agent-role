# AGENTS.md

本文件供在本仓库工作的 Agent 使用，覆盖项目导航、开发命令与实现边界。

## 项目定位与阅读入口

- `@pi/agent-role` 是构建于 `@pi/agent-mesh` 之上的通用角色 Agent 运行时，采用 TypeScript、SQLite（`better-sqlite3`）和 npm。
- 这是供宿主嵌入的库，不是独立应用：不添加 CLI、HTTP 监听或进程级全局运行时。公开工厂为 `src/index.ts` 中的 `createRuntime(options)`，同时导出公开类型和错误。
- 角色差异由模板与数据表达，不为老师、学生等具体角色增加专用代码分支。通讯、投递和会话恢复交给 mesh，角色域负责身份、记忆、知识、自省、设施和场景。
- 动手前查看 [统一审计与闭环计划](.agents/notes/plan/2026-11-02-consolidated-audit-and-mesh-alignment-plan.md) 及相关设计章节。四份旧 plan 已由该计划接管，归档只保留历史依据；不把旧勾选或 `todo` 当成当前实现状态。
- 架构依据是 [ROLE-AGENT-DESIGN.md](.agents/notes/tech/ROLE-AGENT-DESIGN.md)；按需定位 §1（约束）、§2–3（分层与映射）、§18（存储）、§22（模块边界）、§27（决议），不要无差别通读大文档。策略适配另见 [mesh 策略槽签名](.agents/notes/tech/2026-09-14-mesh-strategy-slot-signatures.md)。
- 文档归档与命名遵循 [.agents/AGENTS.md](.agents/AGENTS.md)。当前入口、命令和模块以源码及配置为准。发现设计与实现冲突时先说明差异，不自行推翻既有决策。

## 环境与常用命令

- 使用 npm 和已提交的 `package-lock.json`。本库根包仍声明 Node.js `>=20`，旧 SDK 链要求 `>=22.19.0`；同级 mesh 已迁移到 v0.2.0，目标运行环境为 Node.js 24+。本库依赖、锁文件和后端适配尚未对齐，不能把旧 Node.js 22.19+ 说明当成当前配套环境已受支持。差异与验收见统一计划。
- `@pi/agent-mesh` 通过 `file:../pi-agent-mesh` 引用同级仓库。安装前确认该依赖及其包产物可用；不要为绕过缺失依赖擅自替换为 registry 版本或修改上游仓库。
- `better-sqlite3` 为原生依赖，安装可能需要本机编译工具链。真实模型后端还需要 pi SDK 与相应模型认证；fake 后端测试通过不代表真实模型调用可用。

在项目根目录执行：

```bash
npm ci                   # 安装锁定依赖，需先满足上述前置条件
npm run check:imports    # 六项源码静态门禁
npm run typecheck        # TypeScript 类型检查
npm test                 # Vitest 全量测试
npm run build            # 生成 dist/ 下 ESM、CJS 和类型声明
```

定向回归示例：`npm test -- tests/contract.test.ts`。当前没有 `start`、`dev` 或 `lint` 脚本，不臆造命令。`dist/` 是构建产物，修改源文件而非手工改产物。

## 代码导航

| 位置 | 职责 |
| --- | --- |
| `src/index.ts`、`src/runtime/` | 公开 API、运行时装配、生命周期、设施注册、类型与错误 |
| `src/compile/`、`src/authoring/` | 身份与模型配置编译；蓝本生成、校验与晋升 |
| `src/mesh/` | mesh 适配、会话工厂、后端、策略、设施工具与事件接线 |
| `src/db/`、`migrations/` | 角色域 SQLite 连接、迁移与 SQL schema |
| `src/memory/`、`src/knowledge/`、`src/reflect/` | 对话与主体记忆、知识掌握度、自省与巩固 |
| `src/scene/` | 场景编排与虚拟时钟 |
| `src/inspect/` | 不变量检查、悬挂引用扫描与成本统计 |
| `src/observe/` | 时间线、印象演化与成本视图 |
| `tests/`、`scripts/check-imports.mjs` | 单元／契约／回归测试；静态架构门禁 |

## 必须保持的边界

- mesh 接触面集中在 `src/mesh/**`：其他源码不得导入 `@pi/agent-mesh`、在 SQL 中引用 `mesh_*` 表或使用 `ext.`。`src/mesh/policies/**` 不得引用 `ext` 标识符；这些限制由 `scripts/check-imports.mjs` 检查。
- `src/authoring/**` 不得导入 `mesh`、`db`、`memory`、`scene`、`agent` 领域目录；蓝本生成不直接操作运行期状态。以静态门禁列出的实际规则为准，不靠关闭门禁绕过分层。
- 禁止裸调用 `clearQueue`。本库现有 `beforeClearQueue` 调用属于旧协议，同级 mesh v0.2.0 已移除该 API。适配按统一计划 M04 退役旧调用，保留 submission 幂等、中止、close 与恢复回归。不得手工标记 `consumed` 来加速关闭。
- `role-agent.db` 与 mesh 数据库分离：不得在角色库创建 `mesh_*` 对象或通过 `ATTACH` 跨库耦合。schema 位于 `migrations/`，版本由 `src/db/db.ts` 的 `SCHEMA_VERSION` 与 `PRAGMA user_version` 跟踪；schema 变更需同步建库/迁移脚本、版本、结构校验和测试，不在启动逻辑里临时补表。
- 2026-11-02 用户确认：mesh 固定，只在 role 侧适配。本库尚未发布，允许重新定稿 role 初始 schema 并采用新建双库，不要求迁移旧开发数据。mesh 的 schema/脚本不改；普通启动不自动清库。首次发布后的升级与数据保留另设迁移策略。最新边界见统一计划 H01/H02。
- 回放按已确认的 H03 实现历史记录/领域决策回放与固定条件隔离场景重执行/compare。原会话任意历史点原位分叉不在范围，不等待 mesh forkAt。来源、owner、fidelity 和缺失信息明确；重执行不污染原环境，不冒称重建未记录的历史最终 prompt。
- abort 按已确认的 H04 停止新 cue，不默认取消正在生成的模型。在途模型/submission 收敛，记录真实用量，持久化可恢复进度；超时明确未完成，迟交照常对账。不伪造 consumed，不在收敛前宣称关闭成功。
- 公开入口保持为 `createRuntime`、类型和错误；mesh、registry 等内部句柄不泄漏到公开 API。契约测试从 `src/index.ts` 使用库，内部测试可以按现有方式访问内部模块。

## 编码与验证

- 保持 TypeScript 严格模式与 `noUncheckedIndexedAccess`；项目使用 ES2022、NodeNext 和 ESM 源码，相对导入沿用 `.js` 后缀，纯类型使用 `import type`／`export type`。
- 沿用邻近文件的风格（两空格缩进、双引号），不为单项任务做全仓格式化或引入新的格式化／lint 工具。依赖及锁文件仅随必要的依赖变更修改。
- 测试放在 `tests/**/*.test.ts`。优先使用确定性输入、fake 后端和隔离数据库，结束时关闭 runtime／数据库资源，避免测试之间共享持久状态。
- 保留 `vitest.config.ts` 中的 forks 隔离、60 秒超时与 `TERMUX_VERSION=1` 设置；后者用于绕过 pi SDK 的 clipboard 原生模块问题。
- 代码变更先跑相关测试，再执行静态门禁、类型检查、全量测试与构建；纯文档变更检查事实、路径和 diff 即可。交付时说明实际执行的检查及未执行原因，不把依赖缺失、未运行或 fake 结果写成完整验证通过。

## 项目文档

- 需要留存的调研、产品、技术、评审、变更和计划分别写入 `.agents/notes/` 对应分类；动笔前阅读该目录的 `README.md`，无需为一次性中间过程另建文档。
- 新增 notes 文档使用 `YYYY-MM-DD-<kebab-slug>.md`，包含 `title`、`date`、`status`、`owner`、`tags`、`related` frontmatter。固定入口文件（如本文件）保留固定文件名。
- 文档失效时按已有规范移入 `.agents/notes/archive/`，保留归档元信息与替代文档链接；不要无关移动或重命名历史文档。
- 可复用的项目技能放在 `.agents/skills/`，遵循其中的 `README.md`；代码和大体积二进制文件不要放进 notes。
