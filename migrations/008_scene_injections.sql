-- ═══════════════════════════════════════════════════════════════════════════
-- 008 · scene_injections —— scenes.inject 的审计 + 幂等恢复台账（O05）
--
-- 分层纪律（§22.4 / §18.7 P10）：本表属 DB-A 领域表，不含 mesh_* 对象、不引用 mesh 表
-- 物理列（conversation_id / message_id 是跨库裸引用，与 scenes.conversation_id 同类）。
-- 用途：把宿主注入的场景旁白（kind:"system" + msgClass:"narration"）留痕，并以 inject_id
-- 为幂等键——同一次注入重试/崩溃恢复不重复发消息（R04 单写者 / R19 重启恢复同源要求）。
--
--   授权 / 归属：from_account 记录实际发话账号（必须是场景 host / deps.host / @system 之一）；
--   审计：inject_id → message_id 回链 mesh 消息，text / virtual_ts 留快照；
--   恢复：inject_id 是客户端幂等键，已存在则直接回读，不重发。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scene_injections (
  inject_id       TEXT PRIMARY KEY,       -- 客户端幂等键（重试 / 崩溃恢复按它去重）
  scene_id        TEXT NOT NULL,          -- 领域内引用 → scenes.scene_id
  conversation_id TEXT NOT NULL,          -- 跨库裸引用 → mesh_conversations.id
  message_id      TEXT NOT NULL,          -- 跨库裸引用 → mesh 消息 envelope.id（审计回链）
  from_account    TEXT NOT NULL,          -- 归属：实际发话账号（host/@system）
  msg_class       TEXT NOT NULL DEFAULT 'narration',
  text            TEXT NOT NULL,
  virtual_ts      TEXT,                   -- 注入时刻场景虚拟时间快照
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scene_inj_scene ON scene_injections(scene_id, created_at);