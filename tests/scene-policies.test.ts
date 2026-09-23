// ═══════════════════════════════════════════════════════════════════════════
// P2 · FloorPolicy 单元测试（§7.2 / §3.7 ③）——「这条消息的发送者现在能不能说话」
//
// 不经 runtime/DB，直接驱动 makeFloorPolicy(controller)。controller 由 makeFloorStateController
// 提供；每条用例造一份 SceneFloorState 快照，再以 mesh 注入的 FloorContext 形状调 grantFloor。
// 断言落点：director / round_robin / reactive / free_for_all 四种分派 + host 恒放行 +
// 沉默者剔除 + observer（read-only 成员）天然出列。
//
// 打分口径（P2 中性，arousal/engagement 恒 0.5）：
//   score = turnsSinceLastSpoke + (wasAddressed ? 2 : 0) + arousal + engagement
// 与 orchestrator 的 topScoreAccount 同源（§7.2 反查器），本文件只验证 floor 侧。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";

import { makeFloorPolicy } from "../src/mesh/policies/floor.js";
import type { Envelope } from "../src/mesh/public-types.js";
import { makeFloorStateController } from "../src/scene/floor-state.js";
import type { RoleStateLookup, RoleTurnState, SceneFloorState } from "../src/scene/types.js";

const HOST = "@system";
const TEACHER = "teacher";
const STU1 = "stu1";
const STU2 = "stu2";
const OBSERVER = "observer";

/** 造一份极简 RoleStateLookup：只喂 turnsSinceLastSpoke / wasAddressed，其余 P2 中性。 */
function lookup(turns: Record<string, number>, addressed: readonly string[] = []): RoleStateLookup {
  const by = new Map<string, RoleTurnState>();
  for (const [acct, t] of Object.entries(turns)) {
    by.set(acct, {
      agentId: acct,
      sceneId: "s1",
      arousal: 0.5,
      engagement: 0.5,
      turnsSinceLastSpoke: t,
      wasAddressed: addressed.includes(acct),
      silencedUntilTurn: null,
    });
  }
  return {
    byAccount: (id) => by.get(id),
    byAccounts: (ids) => {
      const m = new Map<string, RoleTurnState>();
      for (const id of ids) {
        const s = by.get(id);
        if (s) m.set(id, s);
      }
      return m;
    },
    sceneOfConversation: () => ({ sceneId: "s1", sceneTurn: 1 }),
  };
}

/** 组装一份 SceneFloorState，缺省覆盖为「标准 3 人 + 观察者」课堂。 */
function state(partial: Partial<SceneFloorState>): SceneFloorState {
  return {
    conversationId: "conv-1",
    floorMode: "director",
    addressee: null,
    host: HOST,
    candidates: [TEACHER, STU1, STU2], // 编曲器 speakerCandidates（有 speak 权的座次，无 observer）
    lastSpeakers: [],
    lookup: lookup({ [TEACHER]: 5, [STU1]: 1, [STU2]: 3 }),
    silenced: new Set(),
    ...partial,
  };
}

interface MinimalCtx {
  conversationId: string;
  candidates: string[];
  lastSpeakers?: string[];
}

describe("P2 FloorPolicy (§7.2 / §3.7 ③)", () => {
  const controller = makeFloorStateController();
  const floor = makeFloorPolicy(controller);

  function grant(ctx: MinimalCtx): string[] {
    return floor.grantFloor({
      conversationId: ctx.conversationId,
      candidates: ctx.candidates,
      lastSpeakers: ctx.lastSpeakers ?? [],
      envelope: {} as Envelope,
    });
  }

  it("无场景快照 / 会话不匹配 → 退回 free_for_all（§13.4 降级口径）", () => {
    // 不 set 任何快照
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, OBSERVER] })).toEqual([
      TEACHER,
      STU1,
      OBSERVER,
    ]);

    // 快照存在但会话不同
    controller.set(state({ conversationId: "conv-2" }));
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1] })).toEqual([TEACHER, STU1]);
  });

  it("director：只放行被点名者 + host；未点名则仅 host 可发言", () => {
    controller.set(state({ floorMode: "director", addressee: STU1 }));
    // ctx.candidates 含观察者，但 st.candidates 不含它 → observer 不该拿到发言权
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, STU2, OBSERVER] })).toEqual([
      STU1,
      HOST,
    ]);

    controller.set(state({ floorMode: "director", addressee: null }));
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, STU2] })).toEqual([HOST]);
  });

  it("director：被点名者不在候选集（不存在/被移出）→ 只退 host", () => {
    controller.set(state({ floorMode: "director", addressee: "ghost" }));
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, STU2] })).toEqual([HOST]);
  });

  it("round_robin：从 lastSpeakers[0] 之后顺延，到尾回绕", () => {
    controller.set(state({ floorMode: "round_robin", lastSpeakers: [] }));
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, STU2, OBSERVER] })).toEqual([
      TEACHER, // 首轮：座次第一个有 speak 权者
      HOST,
    ]);

    controller.set(state({ floorMode: "round_robin", lastSpeakers: [TEACHER] }));
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, STU2] })).toEqual([STU1, HOST]);

    controller.set(state({ floorMode: "round_robin", lastSpeakers: [STU2] }));
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, STU2] })).toEqual([
      TEACHER, // 回绕
      HOST,
    ]);
  });

  it("round_robin：沉默者出列，顺移到下一个未沉默者", () => {
    controller.set(
      state({ floorMode: "round_robin", lastSpeakers: [TEACHER], silenced: new Set([STU1]) }),
    );
    // 轮到 STU1 但被沉默 → STU2
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, STU2] })).toEqual([STU2, HOST]);
  });

  it("reactive：取 turn 分最高者（被点名 +2，距上次发言越久分越高）", () => {
    // TEACHER turnsSinceLastSpoke=5、STU1=1 且被点名、STU2=3：分数 5+1 < 3+1 < 且 STU1 1+2+1=4
    controller.set(
      state({
        floorMode: "reactive",
        addressee: STU1,
        lookup: lookup({ [TEACHER]: 5, [STU1]: 1, [STU2]: 3 }, [STU1]),
      }),
    );
    // TEACHER: 5+0+0.5+0.5=6  → 最高
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, STU2] })).toEqual([TEACHER, HOST]);
  });

  it("free_for_all / 未知模式：全员放行（观测者也在 ctx.candidates 但 speak 由 caps 闸挡住）", () => {
    controller.set(state({ floorMode: "free_for_all" }));
    expect(grant({ conversationId: "conv-1", candidates: [TEACHER, STU1, STU2, OBSERVER] })).toEqual([
      TEACHER,
      STU1,
      STU2,
      OBSERVER,
    ]);
  });

  it("host 恒在放行集内，即使不是候选（cue 才能发得出）", () => {
    // host 不在 candidates 里（极端：只有被点名者与观察者在场），仍须被放行
    controller.set(state({ floorMode: "director", addressee: STU1, candidates: [STU1] }));
    expect(grant({ conversationId: "conv-1", candidates: [STU1] })).toEqual([STU1, HOST]);
  });
});