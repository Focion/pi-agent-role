-- ═══════════════════════════════════════════════════════════════════════════
-- 007 · facility_records —— 设施事实流水表（§5.5 / §16.3 / §16.4 / R11）
--
-- 设施没有主观记忆（C7）：它不写 episodes，状态变更走这条「仅追加」的流水
-- （usage / incident / maintenance，三值封闭集，由 facility_record 工具写入）。
-- 设施的数字型自我认知（usage-digest 聚合 / maintenance 汇总）从这张表重算，
-- 不经 LLM、不占 token。
--
-- owner_agent 冗余存一份（分区键），服从 §18.4.2 的同一个决定：每张记忆族表
-- 自己可判定 owner，使 A1 分区不变量能覆盖它。kind 的取值域是三值封闭集
-- 'usage' | 'incident' | 'maintenance'（§16 与附录 F 第 10 号工具一致）。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE facility_records (
  record_id    TEXT PRIMARY KEY,
  owner_agent  TEXT NOT NULL,     -- 分区键 = 设施 agentId（A1 owner 约束）
  kind         TEXT NOT NULL,     -- 'usage' | 'incident' | 'maintenance'
  data_json    TEXT,              -- 结构化事实载荷（仅追加，不经 LLM 改写）
  scene_id     TEXT,              -- 关联场景（可空）
  virtual_ts   TEXT,              -- 场景虚拟时钟字面量（可空；类型与 episodes.virtual_ts 一致）
  real_ts      TEXT NOT NULL
);

CREATE INDEX idx_facility_records_owner_ts ON facility_records(owner_agent, real_ts DESC);
CREATE INDEX idx_facility_records_kind    ON facility_records(owner_agent, kind);