---
title: 剩余发布与验收计划（0.1.0 受控发布前）
date: 2026-11-11
status: active
owner: 待指定
tags: [plan, release, acceptance, role-agent]
related:
  - ../archive/2026-11-02-consolidated-audit-and-mesh-alignment-plan.md
  - ../tech/ROLE-AGENT-DESIGN.md
  - ../tech/2026-09-14-mesh-strategy-slot-signatures.md
  - ../review/2026-11-10-r39-evidence-ledger.md
---

# 剩余发布与验收计划

## 结论

`@pi/agent-role` 的核心闭环已全部完成并归档：R01–R39、A01–A38、M01–M05、O01–O07、D01–D02、DIF01–DIF08 全关闭；`npm test` **326 passed | 3 skipped**，`check:imports`/`typecheck`/`build`/CI 均绿。

当前唯一未完成的是对外发布所需的四类验收，均需独立授权后执行：

1. 两平台验收
2. 真实模型质量抽样
3. 非真实模型长跑
4. 受控发布

放行条件口径继承自已归档的 [统一审计与闭环计划](../archive/2026-11-02-consolidated-audit-and-mesh-alignment-plan.md) 的 G0/G4/G5、B01/B03/B05/B07 与 WP14/WP15。完整审计、H01–H04/Q01–Q10 与逐项 R/A/M/O/D/DIF 证据见该归档计划、[R39 评审台账](../review/2026-11-10-r39-evidence-ledger.md)及各 memory 记录。

## 剩余项

### 1. 两平台验收（G0/G4 + B07）

- 两平台均为发布必过：macOS ARM64 与 Linux x64（Linux 首期限定 glibc），不承诺 Windows。
- 冻结精确 Node/npm/系统版本与 mesh/SDK/产物指纹；干净环境 `npm ci` 后两平台验证 ESM/CJS/DTS、native SQLite（`better-sqlite3`）、新库初建/失败重试/关闭/恢复、公共契约、新建/崩溃与 T1–T7 分栏。
- 私有 registry/scope、受控 file 安装与发布者在执行阶段登记。

### 2. 真实模型质量抽样（G4）

- 样本下限 3 场景 × 3 模板 × 3 次运行；DIF08 与第四角色冒烟另登记。
- 需独立批准模型、费用上限与评估者；未授权视为未执行，不挑成功样本、不改阈值，阻断最终发布。

### 3. 非真实模型长跑（G4）

- 5 角色 × 20 轮、30 角色 × 100 轮、24 小时受控长跑；记录资源趋势，不编造统一性能指标。

### 4. 受控发布（G5 + B01/B03/B05/E11）

- 版本占用核验（目标仍为未发布的 `@pi/agent-role@0.1.0`）、制品编号/sha、物料/许可证、受控消费与发布/撤回清单齐备。
- 内部私有 npm，不向公开 registry 试发；最终发布包须与受验包校验和一致，发布需独立显式批准。

## 边界

- 以上四项仅是本计划登记在案的剩余执行清单，不影响核心闭环已关闭的结论。
- 首次发布后的 schema 升级与数据保留需另设前向迁移策略，不在本次「新建双库 / 重定稿初始 schema」许可范围内自动延续。