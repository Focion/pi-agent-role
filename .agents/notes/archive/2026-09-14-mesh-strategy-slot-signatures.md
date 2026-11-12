---
title: 九策略槽实现签名（对照 mesh 真实接口）
date: 2026-09-14
status: archived
owner: 待定
tags: [mesh, policies, interface, role-agent]
related:
  - ../tech/ROLE-AGENT-DESIGN.md
  - 2026-11-02-consolidated-audit-and-mesh-alignment-plan.md
  - ../changelog/2026-11-11-mesh-v0-2-0-adapter.md
archived_date: 2026-11-11
archived_from: notes/plan/2026-09-14-mesh-strategy-slot-signatures.md
archived_reason: mesh v0.2.0 九策略槽适配已验收（typecheck / check:imports / 全量测试全绿），逐槽签名已校准并折入代码与 ROLE-AGENT-DESIGN.md §27.4；本文保留 v0.1.0 历史签名作追溯
---

> **已归档（2026-11-11）**：本文记录 mesh **v0.1.0** 的历史签名，正文已按 **v0.2.0** 校准并折入代码与 [ROLE-AGENT-DESIGN.md §27.4](../tech/ROLE-AGENT-DESIGN.md)，不再作为新版本的接口契约使用。逐槽签名以新 mesh `src/core/types.ts` 与 [变更说明](../changelog/2026-11-11-mesh-v0-2-0-adapter.md) 为准。执行边界不变：**H01** mesh 固定、只在 role 侧适配，不修 mesh、不改 schema、不新增接口；**H04** abort 只停新 cue、在途收敛、不伪造 `consumed`；多进程的 `transport:"sameHost"`/outbox/租约全在 mesh、role 只透传（O07）。与 v0.1.0 相对的三处漂移（⑤ clock 由默认改实现、⑥ accessControl 9→10 钩子、⑨ `piSessionId`→`runtimeRef`）在对应小节与「改动清单」内标注。完整差异见 [统一计划](2026-11-02-consolidated-audit-and-mesh-alignment-plan.md) 的 H01–H04、Q01–Q10。

## 方案概述

把「本环实现九个策略槽」落到 `@pi/agent-mesh` v0.1.0 的**真实类型定义**上，逐槽给出精确 TS 签名、本环行为、闭包状态、50ms 预算与降级，并校正设计文档 §3.7 / 附录 D 中与真实 mesh 签名不一致的三处。

**结论先行**（与设计附录 D 一致，本表为最终口径）：

| 立场 | 槽 | 落文件 |
|---|---|---|
| 实现（6） | `sessionFactory`★必填、`activation`、`floor`、`renderer`、`accessControl`、`clock` | `src/mesh/session-factory.ts` + `src/mesh/policies/{activation,floor,renderer,access-control}.ts` + `src/scene/clock.ts` |
| 用默认（3） | `delivery`、`retention`、`endpointSelector` | 无文件 |

## 背景与约束

- 全部接口定义取自 `@pi/agent-mesh` `src/core/types.ts` 五区 ⑤（行 428–539）。
- **import 来源**：`@pi/agent-mesh/core`（该子入口 `export * from "./types.js"`，导出了全部槽类型 `ActivationPolicy`/`FloorPolicy`/`Renderer`/`AccessControl`/`RetentionPolicy`/`EndpointSelector`/`DeliveryPolicy`/`ToolDefinition`…）。包根 `./` 只导出子集（`Policies`/`SessionFactory`/`Envelope`/`Account`/`Endpoint`/`Conversation`/`Limits`/`MeshOptions`…）。故 `src/mesh/**` 内需要具体槽类型时 `import type { ActivationPolicy } from "@pi/agent-mesh/core"`。
- 三条契约（mesh §12.3；设计 §3.7 开头已归纳）：① 除 `accessControl` 外**同步优先**（本环全部写成同步返回）② 槽内**不得**调用 `MeshHost` 写 API / 直连 SQLite 写 `mesh_*` ③ **纯函数式**——时间/随机不得出现在槽里，一切变化走闭包持有的状态对象。同一份状态快照 + 同一条信封 ⇒ 同一个结果。
- `withPolicyTimeout` / `withPolicyGuard` 由 mesh 在装配层包好，**本环无需自包装**。本环只保证：不抛错、不在 50ms 内做 I/O。

## 设计

### 九槽总表

| # | 槽 | 本环 | 降级 `DegradeTarget`（mesh F.1） | 50ms |
|---|---|---|---|---|
| 1 | `delivery` | 用默认 `DefaultDeliveryPolicy` | `silent_no_wake` | 不覆盖 |
| 2 | `activation` | 实现 | `silent_no_wake`（降为不唤醒） | 不覆盖 |
| 3 | `floor` | 实现 | `free_for_all` | 不覆盖 |
| 4 | `renderer` | 实现（只换内层文本） | `builtin_renderer` | 不覆盖 |
| 5 | `clock` | 实现（虚拟时钟 `compare`/`format`，`src/scene/clock.ts`） | `wallclock` | 不覆盖 |
| 6 | `accessControl` | 实现（唯一 fail-closed） | `deny` | 不覆盖（**不**放宽到 200–500ms） |
| 7 | `retention` | 用默认 `DefaultRetentionPolicy` | `cursor_only` | 不覆盖 |
| 8 | `endpointSelector` | 用默认 `TopologyEndpointSelector` | `parked` | 不覆盖 |
| 9 | `sessionFactory` | **必填**（唯一无默认） | `unrecoverable`（转 `parked(NO_SESSION)` 且必告警） | **不受** 50ms 约束，建议 5s |

### 逐槽精确签名

#### ① `delivery`（用默认）

```ts
interface DeliveryPolicy {
  grade(ctx: {
    envelope: Envelope;
    recipient: Account;
    membership?: Membership;
    conversation: Conversation;
    memberCount: number;
    inbox: InboxState;
    verbatim: boolean;
  }): Grade; // "steer" | "followUp" | "silent"
}
```

**本环不实现**。mesh `DefaultDeliveryPolicy` 的档位映射矩阵（`kind` × 会话规模 × 是否被点名 × 在途量）已覆盖角色场景，`groupTiers` 默认 `[3,8,30]` 与「一个班十几人」吻合。若某条消息要「急」，本环设意图层 `priority`，不要自实现槽。

#### ② `activation`（实现）

```ts
interface ActivationPolicy {
  shouldWake(ctx: {
    envelope: Envelope;
    recipient: Account;
    grade: Grade;
    expect: ExpectKind;              // "ack" | "reply" | "none"
    awaitingCorrelations: string[];
    inbox: InboxState;
    presence: PresenceState;         // "available"|"busy"|"dnd"|"away"|"offline"
  }): boolean;
}
```

**本环行为**（承载 v1 `reactive` 的「唤醒谁」半边，设计 §7.2）：

- 判据只能 `recipient.id`（=`accountId`）反查本环 `agent_state` 表，**不得读 `ctx.envelope.ext`**（附录 C）。
- 实现的加分项是 `arousal`/`engagement`（从闭包内存态读），但它**只能收紧**默认判据；强唤醒判据（`expect ∈ {ack,reply}` 必醒 / `to` 精确指向 / `mentions` 含本人）由 mesh 内建规则兜底，本环不重复实现、也不应该否定它们（violate 会与 A1–A3 打架）。

**闭包依赖**：`state: Map<AccountId, {arousal; engagement; …}>`（内存缓存，`agent_state` 同步 SQL 在 50ms 内不安全）。**降级**：抛错/超时 → mesh 记 `policy_degraded` 并降为「不唤醒」，未读机制兜住下一轮 P2 摘要。

#### ③ `floor`（实现）

```ts
interface FloorPolicy {
  grantFloor(ctx: {
    conversationId: ConversationId;
    candidates: AccountId[];
    lastSpeakers: AccountId[];
    envelope: Envelope;
  }): AccountId[];
}
```

**⚠️ 与设计 §3.7③ 的签名差异（一）**：设计写的是 `{ conversationId; conversationType: "group"|"queue"; candidates; speaker; lastSpeakers; envelope: Omit<Envelope,"seq"|"seal"|"idempotencyKey"> }`。**真实 mesh 是** `{ conversationId; candidates; lastSpeakers; envelope }`——**没有 `conversationType`、没有 `speaker`**，且 `envelope` 是**完整 `Envelope`**（含 `seq`/`seal`/`idempotencyKey`）。场景的 `turn_policy` 只能靠 `conversationId` 反查 `scenes` 拿到。

**本环行为**（按场景 `turn_policy` 分派，设计 §7.2 / §3.7③）：

| `turn_policy` | `grantFloor` 返回 |
|---|---|
| `director` | 只返回该轮 `to` 指向的人，其余空；无点名则**空集**（沉默权） |
| `round_robin` | 按 `participants_json` 的 `seat` 顺序轮转，老师永远在候选集内 |
| `reactive` | 按 `arousal`/`engagement`/`turnsSinceLastSpoke` 打分取前 k |

**闭包依赖**：`scenesByConversation: Map<ConversationId, {turnPolicy; participants}>` + `agent_state` 缓存。**不读 `ctx.envelope.ext`**。**降级**：`free_for_all`（宁可吵不要全场哑掉）。Floor 状态**一律不落盘**；崩溃后用重新点名恢复，不得自建令牌表。

#### ④ `renderer`（实现）

```ts
interface Renderer {
  renderMessage(env: Envelope, ctx: { recipient: Account; senderName: string }): string;
  renderInbox(view: InboxView, recent: Envelope[]): string; // P2 注入体
  renderSystem(env: Envelope): string;
}
```

**本环行为**（只换**内层文本**，包裹与转义交 mesh `M4`）：

- `renderMessage`：`env.from` 反查 `agents` 拿 `displayName`/`title`，渲染成 `李老师（班主任）说：「…」`。**注意 `ctx.senderName` 是 mesh 已解出的 `displayName`**，本环用 `env.from` 另查更全的称谓。
- `renderSystem`：旁白渲染成场景描写、控制消息渲染成「（现在是第三周星期一下午）」；虚拟时间必须取 `env.logicalTs`，**不得读 `env.ext.role.virtualTs`**（ext 禁令，C10）。
- `renderInbox`：`<<<INBOX>>>`/`<<<CATCHUP>>>` 内部条目形态。**记忆卡片不走这里**——走 `StreamPort.injectContext`（P2 路径）。

**闭包依赖**：`specs: Map<AccountId, {displayName; title}>`。**降级**：`builtin_renderer`（退回裸 id，也要保住 M4 包裹）。

#### ⑤ `clock`（实现，虚拟时钟）

```ts
interface LogicalClock {
  compare(a: string | undefined, b: string | undefined): number;
  format?(ts: string): string;
}
```

**⚠️ v0.2.0 校准（三）**：本槽由「用默认」改为「实现」——`bootstrap.ts` 现传 `clock: makeLogicalClock()`，以 `W<周>D<日>T<时段>` 为唯一虚拟时间字面量（`compare`=整型投影相减、`format`=人类可读渲染），供 mesh 排序信封逻辑时间戳与回放。实现落在 `src/scene/clock.ts`（纯助手，只比较/格式化、永不推进；推进由编曲器每轮结束显式 `advanceVirtualTs`）。据此 `mesh/policies/` 下仍**不存在 `clock.ts`**（分层归属不同）；虚拟时间推进与 `seq` 语义不变（C11）。

#### ⑥ `accessControl`（实现，唯一 fail-closed）

```ts
interface AccessControl {
  canSend?(ctx: {
    envelope: Envelope;
    from: Account;
    conversation: Conversation;
    membership?: Membership;
  }): boolean | Promise<boolean>;
  canInitiateDirect?(from: Account, to: Account): boolean | Promise<boolean>;
  // canRead / canWrite / canAdmin / canPublish / canMentionAll / canJoin / canSubscribe / resolveCustomTag —— 本环不实现（缺省放行 / 库内建判定）
}
```

**⚠️ 与设计 §3.7⑥ 的签名差异（二，即 L9 已解决）**：真实 mesh 是**多钩子版**（v0.1.0 为 9 个可选钩子；v0.2.0 新增 `canSubscribe` 后为 10 个），不是单方法 `can(ctx)`。本环只需实现其中两个：

```ts
// 自省隔离（D-A）：只有 X 本人能写 X:reflect 的会话
canSend(ctx) {
  const owner = registry.reflectOwnerOf(ctx.conversation.id); // 该会话是否是 reflect 会话，是则返回所属 agentId
  if (owner === undefined) return true;                        // 非 reflect 会话放行
  return ctx.from.accountId === owner;                          // fail-closed：其余 dropped(ACL_DENIED)
}
// 设施应答边界（纵深防御；主动发起的硬闸已由 initiate:[] 在 mesh 闸② 拦下）
canInitiateDirect(from, _to) {
  return !registry.isFacilityAccount(from.id) && !registry.isReflectAccount(from.id);
}
```

**闭包依赖**：`registry`（`accounts.ts` 的 `agent_id ↔ accountId` 映射 + reflect 会话清单）。**必须是纯内存字符串比较**，不查库、不查网络。**降级**：`deny`（大面积 `dropped(ACL_DENIED)`，是九槽里唯一「功能中断」级，告警单列）。必须配「所有正常路径都放行」的正向测试，不能只测拒绝路径。

#### ⑦ `retention`（用默认）

```ts
interface RetentionPolicy {
  verbatimBudget(ctx: { accountId: AccountId; conversations: RetentionCandidate[] }): VerbatimBudget;
  evictionOrder?: "lru" | ((a: InboxState, b: InboxState) => number);
}
```

**本环不实现**。默认口径 `verbatimGapK=20` / `maxVerbatimConversations=3` / `lru` 对「一个班级群 + 少量单聊」合适。若场景编排要 pin 当前场景会话，用 `Membership.verbatimPinned`（本环不暴露给宿主，编排层自行 pin），**不要**替换这个槽。

#### ⑧ `endpointSelector`（用默认）

```ts
interface EndpointSelector {
  select(ctx: {
    accountId: AccountId;
    conversationId: ConversationId;
    envelope: Envelope;
    topology: StreamTopology;        // {kind:"unified"} 为本环全部账号形态
  }): EndpointId | EndpointId[] | null; // null = parked(ENDPOINT_GONE)
}
```

**本环不实现**。所有账号（角色 / 设施 / reflect）都是 `topology:"unified"` 单端点，默认 `TopologyEndpointSelector` 恒返回该 accountId 的唯一端点。reflect 是**独立 Account**（不是同 Account 第二端点），正是为了避开默认选端逻辑挑到它接收他人消息。结构上把「`registerAccount` + `registerEndpoint`」做成一步消除 `ENDPOINT_GONE`。

#### ⑨ `sessionFactory`（必填，唯一无默认）

```ts
interface SessionFactory {           // mesh 侧 session 为 unknown（mesh-core 零 pi 依赖）
  create(ctx: { endpoint: Endpoint; account: Account; tools: ToolDefinition[] }):
    Promise<{ session: unknown; runtimeRef: string }>;
  open(ctx: { endpoint: Endpoint; account: Account; runtimeRef: string; tools: ToolDefinition[] }):
    Promise<{ session: unknown }>;
  dispose?(ctx: { endpoint: Endpoint; session: unknown }): Promise<void>;
}

// 本环在 src/mesh/session-factory.ts 把 unknown 收窄为 pi-durable 会话：
interface AppSessionFactory {
  create(ctx): Promise<{ session: unknown; runtimeRef: string }>; // runtimeRef = encodeRuntimeRef({storagePath, conversationId})（mesh MD7 不透明编码）
  open(ctx):   Promise<{ session: unknown }>;
  dispose?(ctx): Promise<void>;
}
```

**⚠️ v0.2.0 校准（一）**：字段由 `piSessionId` 更名为 `runtimeRef`（create 返回与 open 入参同步）；本环后端改为 pi-durable 1.5 自建工厂（`createPiBackend` + `Harness.open`/root，M01–M02），不再走 mesh 的 session 工厂。

**承载四件事**（设计 §3.7①）：模型绑定（C6）、System Prompt 注入（C1）、工具面分叉（§3.8）、`ext` 注入装饰（C10）。**三条铁律**：

1. `create` 与 `open` 必须产出**等价会话**（System Prompt + 工具名集合逐字节相同）——否则恢复后是「两个不同角色」且无报错。
2. `dispose` 必须实现（哪怕可选）：`idleEvictMs` 到期驱逐时要刷出未落库的领域状态。
3. 这是本环**绑 pi 钩子的唯一时机**：`session_before_compact` / `agent_settled` / `turn_end` 都在这里注册；注册 `context` 钩子时必须让 **mesh 的钩子留在链尾（I23）**。

### 与设计文档的三处签名差异（重要）

这三处是「逐一定死」的产出——设计 §3.7 的草稿签名与 mesh 真实实现不一致，实现期按**本表**为准：

| # | 设计 §3.7 写的 | mesh v0.1.0 真实 | 后果 |
|---|---|---|---|
| 1 | `FloorPolicy.grantFloor` 含 `conversationType` 与 `speaker`，且 `envelope` 是 `Omit<Envelope,"seq"\|"seal"\|"idempotencyKey">` | 只有 `{conversationId, candidates, lastSpeakers, envelope}`；`envelope` 为完整 `Envelope` | 场景类型/当前说话人只能 `conversationId` 反查 `scenes`；槽内仍**不得读 `env.ext`** |
| 2 | `AccessControl` 两版悬案（§12.3 八钩子 vs §21.3 单 `can(ctx)`） | **多钩子版**（9 个可选钩子） | 已解决（L9）：自省隔离 = `canSend`，设施边界 = `canInitiateDirect` |
| 3 | `Renderer.renderMessage` 由渲染器自行反查称谓 | 入参带 `ctx.senderName`（mesh 已解出 `displayName`） | 本环仍用 `env.from` 另查更全 `title`，`senderName` 用作兜底 |

## 改动清单

| 位置 | 改动内容 |
| --- | --- |
| `src/mesh/bootstrap.ts` | `createMesh({ dbPath: mesh.db, devMode: true, policies: { sessionFactory, activation, floor, renderer, accessControl, clock }, limits, transport/transportOptions/recoverDeadEndpoints/busyTimeoutMs })`；传 5 个自实现槽 + `sessionFactory` + `clock`，multiprocess 字段透传（O07），其余 3 槽不传走默认 |
| `src/mesh/session-factory.ts` | 实现 `AppSessionFactory`（窄化 `unknown`）+ 三钩子 + I23 链尾；v0.2.0 起字段为 `runtimeRef`（非 `piSessionId`） |
| `src/mesh/policies/activation.ts` | 实现 `ActivationPolicy`（读内存态，不读 ext） |
| `src/mesh/policies/floor.ts` | 实现 `FloorPolicy`（按 `turn_policy` 分派，空集=沉默） |
| `src/mesh/policies/renderer.ts` | 实现 `Renderer`（内层文本） |
| `src/mesh/policies/access-control.ts` | 实现 `AccessControl` 的 `canSend` + `canInitiateDirect`（同步纯函数；v0.2.0 钩子 9→10，新增 `canSubscribe`） |
| `src/scene/clock.ts` | 实现 `LogicalClock`（虚拟时钟 `compare`/`format`；v0.2.0 起本槽由默认改为实现） |
| （无） | `delivery`/`retention`/`endpointSelector` 不建文件，用 mesh 默认 |

## 备选方案与取舍

- **槽类型来源**：直接 `import type {X} from "@pi/agent-mesh/core"`（本表选它），备选是 `type X = Policies["activation"]`（只用包根类型推导）。选了前者——`./core` 是 mesh 公开子入口，类型名直接可读；后者避免依赖子入口但签名可读性差。二者都满足「`@pi/agent-mesh` 只出现在 `src/mesh/**`」门禁。
- **`accessControl` 是否放宽 50ms**：mesh 允许放宽到 200–500ms，本环**不放宽**——判定是纯字符串比较，放宽只会掩盖 bug。