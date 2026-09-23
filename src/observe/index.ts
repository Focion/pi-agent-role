// ═══════════════════════════════════════════════════════════════════════════
// 观测视图聚合导出（§20.3）
// ═══════════════════════════════════════════════════════════════════════════

export { buildMemoryTimeline } from "./timeline.js";
export { buildImpressionEvolution } from "./profile-history.js";
export { buildCostView } from "./cost-view.js";
export type {
  MemoryTimeline,
  TimelineScene,
  TimelineItem,
  TimelineEvidence,
  EvidenceLevel,
  ImpressionEvolution,
  ImpressionPoint,
  ImpressionJump,
  CostView,
  ObserveWindow,
} from "./types.js";