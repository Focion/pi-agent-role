-- ═══════════════════════════════════════════════════════════════════════════
-- 004：压缩提炼的「来源已消化」台账（R20 · A23）
--
-- §15.4 抢救提炼：一次 pre_compaction 批次把多条即将被上下文压缩覆盖的原消息
-- 交给自省流提炼。自省流常把多条原文合并成少量 selfInsights / consolidations，
-- 而 episodes.source_msg_id 是单列、承载不了「一对多」的来源范围——所以提炼后写出的
-- 情节 source_msg_id 只能 NULL，harvest 的 source_msg_id 反查去重（§15.4 H2）失效：
-- 下一次 compaction 会把已提炼过的原文再提炼一遍。
--
-- 本表记录「这条 source_msg_id 已被某次 pre_compaction 成功提炼」，与 episodes 的内容
-- 解耦：无论模型产出多少条情节，只要批次成功写入了至少一条记忆情节，就把该批次的全部
-- 来源消息记为已消化。harvest 去重改为「无 episodes.source_msg_id 反查 且 不在本台账」。
--
-- 幂等键 (owner_agent, source_msg_id)：同一条原文被重复送进 harvest 时，第二次无条件跳过。
-- reflection_id 留审计回溯（哪一批提炼的），distilled_at 是「整理时刻」（R20）。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS compact_distilled (
  owner_agent    TEXT NOT NULL,
  source_msg_id  TEXT NOT NULL,
  reflection_id  TEXT,
  distilled_at   TEXT NOT NULL,
  PRIMARY KEY (owner_agent, source_msg_id)
);