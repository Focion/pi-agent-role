# pi-agent-role 真实场景示例（examples/）

本目录用**公开入口 `createRuntime`** 把 `@pi/agent-role` 的全部支撑场景跑成可直接执行的示例，
目标是让你在**真实模型**（或 `--fake` 无 LLM 冒烟）下亲手验证每一个命名空间。

核心演示点：**基于 MBTI 设置 8 个不同角色 → 用户可以发起对话 → 群里角色按各自人格互相聊天回复**，
同时把 `blueprints / agents / facilities / scenes / reflect / memory / inspect / replay` 七个命名空间逐一遍历。

## 前置条件

- **Node ≥ 24**（本库 `engines` 声明 `>=24.0.0`；示例用 Node 原生 type-stripping 直接跑 `.ts`，≥ 22.6 也能跑）。
- 同级仓库 [`pi-agent-mesh`](../) 已构建产物可用——示例经包自引用 `import "@pi/agent-role"` 解析到 `dist/`（`start.sh` 会自动 `npm run build`）。
- **真实模型凭据**：`examples/demo.config.json` 优先，缺省回退 `../pi-agent-mesh/examples/demo.config.json`。

```bash
# 首次：复制配置模板并按需填模型/凭据（不提交 demo.config.json）
cp examples/demo.config.example.json examples/demo.config.json
```

`demo.config.json` 形状（OpenAI 兼容端点）：

```json
{
  "llm": {
    "model": "QwenAPI:qwen3.8-27b",
    "thinkingLevel": "low",
    "providers": {
      "QwenAPI": {
        "baseUrl": "https://your-endpoint/v1",
        "api": "openai-completions",
        "apiKeyEnv": "QWEN_API_KEY"
      }
    }
  }
}
```

## 运行

```bash
bash examples/start.sh                 # 打印场景菜单
bash examples/start.sh chat            # 交互群聊（真实模型）
bash examples/start.sh chat --fake     # 无 LLM 冒烟（不烧钱，验证装配）
bash examples/start.sh agents --personas intj,enfp,istj
```

`--fake` 走 fake sessions + fake streamPort：所有 API 调用、生命周期、场景编排照常运转，
但角色**不产出真实文本**、token 用量恒 0。真实模型路径才会产出角色回复与真实用量/成本。

## 场景清单（覆盖矩阵）

| 场景 | 说明 | 覆盖的命名空间 / 能力 |
| --- | --- | --- |
| `chat` | **交互群聊**：用户发消息，MBTI 角色互相回复 | `scenes.create/run/inject`、`onEvent` 转写、真实生成 |
| `agents` | 角色 Agent 全生命周期 | `agents.create/createBatch/setModelConfig/reproject/reconcile/respec/retire/restore/deleteAgent/exportAsBlueprint`、`memory.recall/stats`、`inspect.checkMeshConsistency` |
| `scenes` | 场景编排 | 四种 `floorMode`（director+script / round_robin / reactive / free_for_all）、虚拟时钟、`inject/pause/resume/close` |
| `observe` | 自省 / 巡检 / 回放 | `reflect.run/maybe/runAll/read`、`inspect.checkInvariants/scanDangling/costMetrics/memoryTimeline/impressionEvolution/costView`、`replay.record/reexecute/compare` |
| `authoring` | 蓝本生成 + 设施 | `blueprints.generate/promote`、`facilities.create` |

跑全量无 LLM 回归：

```bash
for s in chat agents scenes observe authoring; do
  bash examples/start.sh "$s" --fake || echo "FAIL: $s"
done
```

## MBTI 角色

8 个角色全部由**模板数据**驱动（`examples/src/personas.ts`），代码无任何角色分支；同一 MBTI 的大五、共情、
依恋风格、注意力、感官通道、叙事声音、约束与目标各不相同，经库的身份/记忆策略编译器折成可观测的差异：

| id | MBTI | 别称 | 展示名 | 记忆策略倾向（示例） |
| --- | --- | --- | --- | --- |
| `intj` | INTJ | 建筑师 | 沈亦衡 | 高开放性/高尽责、低共情 → 重视新鲜、细节保留高 |
| `enfp` | ENFP | 竞选者 | 林小满 | 高开放、低尽责、注意力分散 → 一轮记忆写入少 |
| `istj` | ISTJ | 物流师 | 陈守拙 | 高尽责、细节导向 → 低写阈值、细保留 |
| `infp` | INFP | 调停者 | 苏以宁 | 高共情、焦虑依恋 → 低自涉、对权威过度敏感 |
| `entj` | ENTJ | 指挥官 | 陆呈 | 高尽责、低共情、外倾 → 目标导向 |
| `isfp` | ISFP | 探险家 | 顾之夏 | 细节导向、触觉主导 → 好感通道过滤 |
| `entp` | ENTP | 辩论家 | 叶以航 | 极高开放、注意力分散 → 高新鲜感、少写缓存 |
| `infj` | INFJ | 提倡者 | 许清越 | 高共情、洞察 → 结构暗流敏感 |

## 目录结构

```
examples/
  start.sh                 # 一键启动（构建 dist + 分发场景）
  tsconfig.json            # 独立 TS 配置（native type-strip + typecheck）
  demo.config.example.json # 凭据模板（demo.config.json 被 gitignore）
  src/
    types.ts               # 共享类型（模型配置 + PersonaSpec）
    config.ts              # 加载/标准化 demo.config.json
    personas.ts            # MBTI 画像数据 + 蓝本文写器
    harness.ts             # openRuntime + registerPersona(s)
    context.ts             # Scenario / ScenarioContext / parseFlags
    transcript.ts          # 群聊转写收集器
    chat.ts                # 交互群聊场景
    main.ts                # 统一入口 / 分发
    scenarios/
      agents.ts            # 角色生命周期场景
      scenes.ts            # 场景编排场景
      observe.ts           # 自省/巡检/回放场景
      authoring.ts         # 蓝本生成 + 设施场景
```

## 说明与边界

- 示例**只用公开入口** `@pi/agent-role` + 公开类型；不 import `@pi/agent-mesh`、不触达内部句柄（`mesh/registry`）。
- 回复的读取经 `onEvent`（`message_routed` 信封，每封消息恰 route 一次）完成——这是公开门面上唯一的消息观测路径。旁白注入只触发 `message_routed` 而非 `message_delivered`，故以 `message_routed` 为唯一来源。
- 真实模式下，角色回复由角色自身的 `mesh_send`（编译期叙事声音/协议驱动）在一次点名轮内发出时才经 `onEvent` 上浮；个别开放式提示下，角色生成的内容可能作为在途 submission 延迟到 `close()` 收敛（H04），此时 `chat` 摘要里该轮看不到正文属预期，不表示生成失败（token 用量仍计入）。
- 每轮 `scenes.run()` 返回后，`chat` 会做一次有界 settle-drain（静默 300ms 视为落定、总等待上限 2500ms）：把晚于 run 返回才经 `message_routed` 上浮的回复一并收进本轮转写再打印。`--fake` 无晚到回复，静默窗口在首个空轮即满足，立刻退出、绝不挂起。
- 运行期数据（`examples/.playground/`、双库、物化模板、pi session JSONL）全部 gitignore，不污染仓库。
- 真实模型会**消耗费用**：每个场景的可调轮数见各场景的 `--turns` 等 flag；验证请先 `--fake` 冒烟再切真机。