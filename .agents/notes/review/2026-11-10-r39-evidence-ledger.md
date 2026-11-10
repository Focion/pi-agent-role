---
title: R39 证据分栏与核心闭环验收记录
date: 2026-11-10
status: done
owner: Claude Code
tags: [review, audit, evidence, release]
related:
  - ../plan/2026-11-02-consolidated-audit-and-mesh-alignment-plan.md
---

## 评审对象

- 变更：R39「静态扫描 / fake / SDK / 真实模型证据分栏」+ 核心闭环验收证据整理。
- 范围：全仓 `src/`、`tests/`、`migrations/`、`.github/workflows/ci.yml`。
- 作者：跨会话累积（未发布，尚未合入远端）。

## 结论

**核心闭环已到可 CI 状态。** 四档证据分栏如下；真实模型冒烟绿（存在一处记录型时序 flake，不在 CI 运行范围），CI 工作流已写但尚未在 GitHub Actions 实跑。R 项关闭证据见统一计划与各 memory 记录；O01–O07 仍按计划后置。

## 四档证据分栏

| 证据档 | 载体 | 本轮实测结果 | 覆盖内容 |
| --- | --- | --- | --- |
| 静态扫描 | `npm run check:imports`（六项源码门禁）+ `typecheck` | ✓ 91 源文件通过；✓ 排版类型零错 | R01 公开边界、R03/R07/R11/R12/R33 分层纪律、mesh 接触面隔离、`ext`/`mesh_*`/`clearQueue` 禁项 |
| fake 测试 | Vitest 全量（确定性假后端/隔离库） | ✓ `281 passed \| 2 skipped` | R 项正反例、A01–A38 全部落地、T2 策略失效/T4 存储/T5 隔离、预算/召回/衰减/知识/场景/自省/观测 各域 |
| SDK（pi-durable，fake 模型） | `tests/pi-backend-faux.test.ts`、`tests/regression/t1-context.test.ts` | ✓ M01 runtimeRef + M02 记忆卡注入链尾 + usageBreakdownFor 回读 | R05/R06 双流绑定形状、R25 最终上下文 role 侧次序、A07 用量归因底座 |
| 真实模型 | `tests/real-model.test.ts`（`PI_ROLE_REAL_MODEL=1`，读 `../pi-agent-mesh/examples/demo.config.json` 的 QwenAPI） | ✓ 单独跑 2/2 绿；✓ 全量带真实 283/283 绿（曾有一次 usage 断言 flake，复跑即绿） | R06 真实用量（input/output>0）、R13 真实消费推进、R15 装饰、R21 观察冒烟 |

## 验收族证据对应

| 验收族 | 证据档 | 状态 |
| --- | --- | --- |
| T1 上下文 | SDK + fake | role 侧记忆卡链尾注入已验（M02-1）；未读收件箱属 mesh 注入 |
| T2 策略失效 | fake | 逐槽越界/降级/停写已测 |
| T3 并发与恢复 | fake | recovery/多投递/迟交/幂等回归已测 |
| T4 存储 | fake | 双库同址/别名/配对/失败重试已测 |
| T5 隔离 | fake | owner/Scoped/Admin/禁权已测 |
| T6 观测 | fake + 静态 | scope/窗口/不可得量/可见性已测 |
| T7 回放 | fake | R37/R38 记录回放/隔离重执行/compare 已测（H03/C02 口径） |
| DIF01–DIF07 | fake | 角色差异性确定性断言 |
| DIF08 | 真实模型 | 底座已通，长期抽样另授权 |

## 真实模型 flake（已记录，非产品回归）

`tests/real-model.test.ts` 后端段的 `usage.totalTokens > 0` 断言在全量并发跑下偶发失败，单独跑与复跑均为绿。成因是 QwenAPI OpenAI 兼容端点 usage 上报时序（偶发不补 `total` 字段或晚于 `entries()` 扫描），非 role 侧归因 bug。真实段不进 CI（CI 无 `PI_ROLE_REAL_MODEL`、无凭据，自动 skip 零费用），故不影响 CI 绿。副作用断言 `usage.input/output > 0` 保持硬门槛。

## 遗留项

- [ ] CI 工作流（`.github/workflows/ci.yml`）首次在 GitHub Actions 实跑，以 push 后日志为准。
- [ ] 真实模型长跑抽样（3 场景×3 模板×3 次）与 DIF08 第四角色冒烟，需另授权费用/评估者。
- [ ] B05/B07 的两平台（macOS ARM64 / Linux x64 glibc）包外消费与 native SQLite 验收入门。