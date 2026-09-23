# notes/plan — 计划文档

## 收录什么

- 路线图：中长期方向与阶段目标
- 迭代计划：本期做什么、优先级、里程碑
- 任务拆解：把一个大目标拆成可执行步骤及依赖关系
- 进度状态：哪些已完成、哪些被阻塞及原因

## 不收录什么

- 方案本身（怎么做） → `notes/tech/`
- 需求定义 → `notes/product/`
- 计划废弃后不要留在此处 → 移入 `notes/archive/`

## 命名

`YYYY-MM-DD-<kebab-slug>.md`，如 `2026-09-14-q4-roadmap.md`、`2026-09-14-auth-migration-plan.md`

## 模板

```markdown
---
title: <计划名>
date: <YYYY-MM-DD>
status: active
owner: <负责人>
tags: [plan]
related: []
---

## 目标

<完成后达到什么状态；给出可验证的完成标准。>

## 范围

- 包含：<...>
- 不包含：<...>

## 步骤

| # | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| 1 | <可执行的事项> | - | todo / doing / done / blocked |

## 里程碑

- <日期>：<可交付物>

## 风险与阻塞

| 项 | 影响 | 应对 / 待谁解决 |
| --- | --- | --- |

## 进度记录

- <YYYY-MM-DD>：<变化，仅记录影响计划的事件>
```

计划完成后把 `status` 改为 `done` 并保留在本目录，作为决策依据可追溯；被取消的计划移入 `notes/archive/`。
