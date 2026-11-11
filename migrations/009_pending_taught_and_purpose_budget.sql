-- ═══════════════════════════════════════════════════════════════════════════
-- 009 · pending_taught + retrieval_log.tokens_purpose
--
-- ① pending_taught —— §17.2 Q05「taught 延迟成立」的中转台账。讲者自省发现「我教了某人
--    topic」时，双证据只齐了①（讲者自己的双主体情节），②（听者侧已迁移到 ≥understood 且
--   taught_by=讲者）尚未落地就记 open；听者迁移后由日终任务回补为 mastered 成立。
--   这是 C4 记忆隔离的唯一例外：跨分区读只在 KnowledgeService 服务层做，Agent 只拿到
--   「成立/不成立」布尔，永远看不到听者分区。status 三值：open/resolved/rejected。
--
-- ② retrieval_log.tokens_purpose —— §17.6 / Q09：教学进度（teaching_progress）注入的
--   独立 token 分账（基础 ≤2750 之外的固定配额 ≤200 token / 3 条）。列名独立于
--   tokens_l2/l1/transient，语义上不占 L1 的 900 池。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pending_taught (
  pending_id    TEXT PRIMARY KEY,
  owner_agent   TEXT NOT NULL,           -- 讲者（要升 mastered 的一方）
  kn_id         TEXT NOT NULL,
  topic         TEXT NOT NULL,
  listener_ref  TEXT NOT NULL,           -- 听者 SubjectRef 序列化 "person:<agent_id>"
  evidence      TEXT,                    -- 自然语言证据（截断后）
  episode_id    TEXT,                    -- 讲者的教学情节（双主体 person + knowledge）
  virtual_ts    TEXT NOT NULL,
  virtual_hours INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | resolved | rejected
  resolved_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_taught_owner ON pending_taught(owner_agent, status);

ALTER TABLE retrieval_log ADD COLUMN tokens_purpose INTEGER;