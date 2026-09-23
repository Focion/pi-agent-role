# notes/review — CR 文档

## 收录什么

- 代码评审记录：审了哪些改动、发现哪些问题、如何处理
- 评审结论：合入 / 需修改 / 打回，以及依据
- 复盘性质的质量问题清单（含遗留项与责任人）

## 不收录什么

- 设计方案本身 → `notes/tech/`
- 对外变更说明 → `notes/changelog/`
- 逐行行内评论（留在 MR/PR 平台上；这里只留结论与需要长期记住的点）

## 命名

`YYYY-MM-DD-<kebab-slug>.md`，slug 建议带 MR/PR 编号，如 `2026-09-14-mr-1234-auth-refactor.md`

## 模板

```markdown
---
title: <评审对象>
date: <YYYY-MM-DD>
status: done
owner: <评审人>
tags: [review]
related: []
---

## 评审对象

- 变更：<MR/PR 链接或 commit 范围>
- 范围：<涉及模块 / 文件>
- 作者：<提交人>

## 结论

<通过 / 需修改后通过 / 打回，一句话理由。>

## 问题清单

| # | 位置 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- | --- |
| 1 | `path/to/file.ts:42` | blocker / major / minor / nit | <描述> | 已修 / 待修 / 不修（理由） |

## 值得留存的经验

<本次评审暴露出的通用问题，供后续避免。>

## 遗留项

- [ ] <未在本次解决、需要跟进的事项>
```
