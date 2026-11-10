# AGENTS.md

本文件是 `.agents/` 的引导入口。**开始任何任务前先读它**，它说明本项目的上下文放在哪、新产出应该写到哪。

## 项目上下文

- 项目名：`pi-agent-role`，包名 `@pi/agent-role`。
- 远端仓库：https://github.com/Focion/pi-agent-role
- 项目简介：供宿主嵌入的通用角色 Agent 运行时。通讯、投递和会话恢复交给同级 `pi-agent-mesh`；本库管理身份、记忆、知识、自省、设施和场景，不提供 CLI 或 HTTP 服务。
- 技术栈：TypeScript、SQLite（`better-sqlite3`）、npm、Vitest、tsup；包发布 ESM、CJS 和类型声明。
- 入口与关键模块：`src/index.ts` 的 `createRuntime(options)`。源码导航及开发约束见 [根 AGENTS.md](../AGENTS.md)。
- 本地检查命令：`npm run check:imports`、`npm run typecheck`、`npm test`、`npm run build`。先核验 Node.js、原生依赖及同级 mesh 产物；fake 测试不证明 SDK 适配可用。
- 当前计划：[统一审计、mesh 适配与核心闭环](notes/plan/2026-11-02-consolidated-audit-and-mesh-alignment-plan.md)，状态为 active，H01–H04 已获用户确认。四份旧 plan 由此接管；方案确认和归档都不表示未完成项已关闭。

## 目录地图

```
.agents/
├── AGENTS.md          # 本文件
├── notes/             # 项目相关文档
│   ├── research/      # 研究：调研、技术选型、可行性分析、竞品分析
│   ├── product/       # 产品设计：PRD、需求说明、交互与流程
│   ├── tech/          # 技术设计：架构、实现方案、接口与数据模型
│   ├── review/        # CR：代码评审记录、问题清单与结论
│   ├── changelog/     # 变更：版本发布、迁移步骤、破坏性变更
│   ├── plan/          # 计划：路线图、迭代计划、任务拆解
│   └── archive/       # 归档：已作废或被替代的文档
└── skills/            # 项目技能，一个子目录一个 skill（见 skills/README.md）
```

每个 notes 子目录下的 `README.md` 写明了该类文档的收录标准和模板，写入前先读对应的那一份。

## 该往哪写

| 我要记录的东西 | 目标目录 |
| --- | --- |
| 「我查了 A/B/C 三个方案，对比结论是……」 | `notes/research/` |
| 「这个功能给用户看到的样子和规则是……」 | `notes/product/` |
| 「代码上准备怎么做、拆哪些模块、接口长什么样」 | `notes/tech/` |
| 「这次 CR 发现了哪些问题、怎么处理」 | `notes/review/` |
| 「这次改动对外的影响、升级方式」 | `notes/changelog/` |
| 「接下来分几步做、什么时候做」 | `notes/plan/` |
| 「这份文档已经不作数了」 | `notes/archive/` |
| 「这套操作流程要能被复用执行」 | `skills/` |

判断不了归哪类时，按**文档的主要用途**而不是它提到的内容归类；确实跨类就放主用途所在目录，用 `related` 链接另一篇。

## 命名与格式

- 文件名：`YYYY-MM-DD-<kebab-slug>.md`，例如 `2026-09-14-cache-layer-design.md`。日期用创建日期，之后不改。
- 每篇文档以 frontmatter 开头：

  ```markdown
  ---
  title: 缓存层设计
  date: 2026-09-14
  status: draft        # draft | active | done | archived
  owner: <负责人>
  tags: [cache, performance]
  related:
    - notes/research/2026-09-10-cache-options.md
  ---
  ```

- 正文用 `##` 起始的层级标题；结论写在最前面，推理过程放后面。
- 附件（截图、数据文件）放在同级 `assets/` 目录，正文用相对路径引用。
- 不要把代码库里已有的信息（目录结构、实现细节）抄进文档；写代码里读不出来的东西：为什么这么做、否决了什么、约束是什么。

## 文档生命周期

`plan` → `tech`/`product` → 实现 → `review` → `changelog`，研究性输入随时进 `research`。

文档失效时**移动到 `notes/archive/`**，不要删除，并更新 frontmatter：

```markdown
status: archived
archived_date: 2026-09-14
archived_from: notes/tech/2026-08-01-old-design.md
archived_reason: 被 notes/tech/2026-09-14-new-design.md 取代
```

引用了它的文档要顺手更新 `related` 指向新版本。

## 给 Agent 的操作约定

1. 动手前先扫一遍 `notes/plan/` 和相关子目录，避免与既有决策冲突；发现冲突先提出来，不要自行推翻。
2. 产出文档时复用上面的命名与 frontmatter，不要另创目录层级。
3. 只在任务确实产生了值得留存的结论时写文档；一次性的中间过程不必落盘。
4. 修改已有文档时保留原有结论，用新章节或新文档记录变化，必要时归档旧版本。
