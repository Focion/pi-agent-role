// ═══════════════════════════════════════════════════════════════════════════
// FakeStreamPort（§23.5）：无 LLM 测试的可测性关键，镜像 mesh tests/helpers 同名件。
//
// 三处必须这样写，否则测试在真环境静默失效：
// ① deliver 第五参是 opts:{triggerTurn}，不是 wake:boolean（§7.1 正交）
// ② status() 不报 queueDepth（F3：pi 队列深度对库消息失明）
// ③ deliver 返回 SubmissionHandle（submissionId/status/entryId），submissionStatus
//    可按 id 精确对账（§8.4）；fake 同步落 entry，返回 status="done"（M03 最小投影）
//
// 位于 `src/mesh/`：`createRuntime({fake:{streamPort:true}})` 要在运行期构造它，
// 且它是 `StreamPort` 边界的同层零件，故落在 mesh 层而非 tests/。
// ═══════════════════════════════════════════════════════════════════════════

import type {
  EndpointId,
  EndpointState,
  Envelope,
  Grade,
  MeshLease,
  PortEntryEvent,
  PortStatus,
  StreamPort,
  SubmissionHandle,
  SubmissionRecord,
  Unsubscribe,
} from "@pi/agent-mesh/core";

export interface FakeDeliveryRecord {
  endpointId: EndpointId;
  envelope: Envelope;
  rendered: string;
  grade: Grade;
  triggerTurn: boolean;
  entryId: string;
}

export class FakeStreamPort implements StreamPort {
  readonly delivered: FakeDeliveryRecord[] = [];
  readonly notes: Array<{ endpointId: EndpointId; customType: string; data: unknown }> = [];
  readonly nudges: Array<{ endpointId: EndpointId; cue: string; opts?: unknown }> = [];
  readonly injections: Array<{ endpointId: EndpointId; text: string }> = [];
  readonly warmed: EndpointId[] = [];
  readonly evicted: EndpointId[] = [];

  /** 脚本化端点状态；未设置默认 hot */
  private states = new Map<EndpointId, EndpointState>();
  private busy = new Set<EndpointId>();
  private entryHandlers: Array<(e: PortEntryEvent) => void> = [];
  private turnEndHandlers: Array<(e: { endpointId: EndpointId }) => void> = [];
  private seqCounters = new Map<EndpointId, number>();
  private handoff = new Map<EndpointId, number>();
  /** deliver → submission 投影（M03：可对账的最小假状态机，id → SubmissionRecord）。 */
  private submissions = new Map<string, SubmissionRecord>();

  setEndpointState(id: EndpointId, state: EndpointState): void {
    this.states.set(id, state);
  }

  async warm(endpointId: string, _lease?: MeshLease): Promise<void> {
    this.warmed.push(endpointId);
    this.states.set(endpointId, "hot");
  }

  async evict(endpointId: string): Promise<void> {
    this.evicted.push(endpointId);
    this.states.delete(endpointId);
  }

  async deliver(
    endpointId: string,
    rendered: string,
    envelope: Envelope,
    grade: Grade,
    opts?: { triggerTurn?: boolean; deliveryId?: string; attempt?: number },
  ): Promise<SubmissionHandle> {
    const entryId = `fake_${this.delivered.length + 1}`;
    const submissionId = `sub_${this.delivered.length + 1}`;
    this.delivered.push({ endpointId, envelope, rendered, grade, triggerTurn: !!opts?.triggerTurn, entryId });
    const seq = (this.seqCounters.get(endpointId) ?? 0) + 1;
    this.seqCounters.set(endpointId, seq);
    this.handoff.set(endpointId, (this.handoff.get(endpointId) ?? 0) + 1);
    this.emitEntry({
      endpointId,
      entryId,
      envelopeId: envelope.id,
      entryType: "custom_message",
      seqInStream: seq,
      rawJson: JSON.stringify({ fake: true, envelopeId: envelope.id, customType: "mesh.msg" }),
    });
    this.handoff.set(endpointId, (this.handoff.get(endpointId) ?? 1) - 1);
    if (opts?.triggerTurn) {
      this.busy.add(endpointId);
      // 用 setTimeout 而非 queueMicrotask：确保 await deliver() 的 continuation（markDelivered）
      // 在 microtask 阶段跑完后，endTurn 才在下一 macrotask 触发 handleTurnEnd → consumed。
      // 否则 microtask 先于 promise continuation 执行，handleTurnEnd 查不到 delivered 行，永不消费。
      setTimeout(() => this.endTurn(endpointId), 0);
    }
    // M01/M03：fake 同步落 entry，到返回时已结进转录 → status="done"、type="write"（与 mesh
    // tests/helpers/fake-stream-port 同构）。完整确定性状态机（queued→placed→done/unanswered）、
    // 分账与 deliveryId/attempt 归因在 WP05 落。
    this.submissions.set(submissionId, { id: submissionId, status: "done", entryId, type: "write" });
    return { submissionId, status: "done", entryId };
  }

  async nudge(
    endpointId: string,
    cue: string,
    opts?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean },
  ): Promise<void> {
    this.nudges.push({ endpointId, cue, opts });
    if (opts?.triggerTurn) {
      this.busy.add(endpointId);
      setTimeout(() => this.endTurn(endpointId), 0);
    }
  }

  async note(endpointId: string, customType: string, data: unknown): Promise<void> {
    this.notes.push({ endpointId, customType, data });
    const seq = (this.seqCounters.get(endpointId) ?? 0) + 1;
    this.seqCounters.set(endpointId, seq);
    this.emitEntry({
      endpointId,
      entryId: `note_${this.notes.length}`,
      entryType: "custom",
      seqInStream: seq,
      rawJson: JSON.stringify({ fake: true, customType, data }),
    });
  }

  injectContext(endpointId: string, text: string): Unsubscribe {
    this.injections.push({ endpointId, text });
    return () => {};
  }

  status(endpointId: string): PortStatus {
    return {
      state: this.states.get(endpointId) ?? "hot",
      busy: this.busy.has(endpointId),
      inFlight: this.handoff.get(endpointId) ?? 0,
    };
  }

  async submissionStatus(_endpointId: string, submissionId: string): Promise<SubmissionRecord | null> {
    return this.submissions.get(submissionId) ?? null;
  }

  onEntry(h: (e: PortEntryEvent) => void): Unsubscribe {
    this.entryHandlers.push(h);
    return () => {
      this.entryHandlers = this.entryHandlers.filter((x) => x !== h);
    };
  }

  onTurnEnd(h: (e: { endpointId: EndpointId }) => void): Unsubscribe {
    this.turnEndHandlers.push(h);
    return () => {
      this.turnEndHandlers = this.turnEndHandlers.filter((x) => x !== h);
    };
  }

  // ── 测试驱动 API ──

  emitEntry(e: PortEntryEvent): void {
    for (const h of [...this.entryHandlers]) h(e);
  }

  endTurn(endpointId: EndpointId): void {
    this.busy.delete(endpointId);
    for (const h of [...this.turnEndHandlers]) {
      try {
        h({ endpointId });
      } catch {
        // 吞错：测试 teardown 可能已关 store/host，turn_end 派发在清理后仍可能到达。
      }
    }
  }

  /** 统计 triggerTurn===true 的投递次数（P1 验收指标的分子） */
  wakeCount(): number {
    return this.delivered.filter((d) => d.triggerTurn).length;
  }
}