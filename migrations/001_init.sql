-- ═══════════════════════════════════════════════════════════════════════════
-- pi-agent-role — role-agent.db（DB-A）领域库 DDL
--
-- 权威出处：notes/tech/ROLE-AGENT-DESIGN.md §18（存储设计）。
-- 14 张表分六组：注册组（agents/agent_specs/agent_state）、场景组（scenes）、
--   记忆组（episodes/episode_subjects/subject_profiles）、
--   知识组（knowledge_items/knowledge_events）、
--   自省组（reflections/state_writes）、
--   审计组（retrieval_log/boundary_events/memory_decisions）。
-- 另有 1 个 FTS5 索引（episodes_fts，不计入 14）+ 4 个触发器。
--
-- 跨库规约（§18.6）：凡注释标注「跨库裸引用」的列，一律 TEXT、无外键、无 ON DELETE，
--   允许悬挂（B1），只写一次（B3），取值必须是 mesh 原值（B5）。
--   唯一例外是可空的对外键：episodes.episode_id（本环内引用，非裸引用）。
-- ═══════════════════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ───────────────────────────────────────────────────────────────────────────
-- 注册组（§18.2）：agent_id ↔ (mesh_account_id, mesh_endpoint_id) 映射的唯一持有方
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
  agent_id                  TEXT PRIMARY KEY,
  agent_type                TEXT NOT NULL,          -- 'role' | 'facility' | 'system'（唯一权威；不是 'persona'）
  identity_id               TEXT,
  blueprint_dir             TEXT NOT NULL,
  blueprint_hash            TEXT NOT NULL,
  overlay_json              TEXT,
  identity_dir              TEXT,
  projected_at              TEXT,
  role                      TEXT,
  display_name              TEXT,
  model_config_json         TEXT,
  model_config_source_json  TEXT,
  model_preset              TEXT,

  -- v2 新增：mesh 侧实体映射（本环是唯一持有者）
  mesh_account_id           TEXT,                   -- 主 Account：mesh_accounts.id（跨库裸引用）
  mesh_endpoint_id          TEXT,                   -- 主 Endpoint：mesh_endpoints.id（跨库裸引用）
  mesh_reflect_account_id   TEXT,                   -- 自省流 Account（<agentId>:reflect）（跨库裸引用）
  mesh_reflect_endpoint_id  TEXT,                   -- 自省流 Endpoint（跨库裸引用）
  mesh_registered_at        TEXT,                   -- 首次在 mesh 注册成功的真实时间
  mesh_instance_tag         TEXT,                   -- 该映射所属的 mesh 库标识（§18.2）
  registered_projection     TEXT,                   -- 注册时实际提交的 AgentSpecMeshProjection JSON 原文（§4.2.2 C/D 档基准）
  spec_hash                 TEXT,                   -- 聚合 spec 指纹（§9.4 open() 校验；与 agent_specs.spec_hash 逐文件不同）

  status                    TEXT NOT NULL DEFAULT 'active',
  created_at                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_blueprint ON agents(blueprint_hash);
CREATE INDEX IF NOT EXISTS idx_agents_role      ON agents(role);

-- 反查：从 mesh 侧 id 回到本环 agent_id。§20.2 排除算法与 §18.6 悬挂检测依赖。
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_mesh_account
  ON agents(mesh_account_id) WHERE mesh_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_mesh_endpoint
  ON agents(mesh_endpoint_id) WHERE mesh_endpoint_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_reflect_account
  ON agents(mesh_reflect_account_id) WHERE mesh_reflect_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_reflect_endpoint
  ON agents(mesh_reflect_endpoint_id) WHERE mesh_reflect_endpoint_id IS NOT NULL;

-- agent_specs：逐文件一行；**不存 system_prompt 全文，也不存 prompt_version**（§18.2.1）
CREATE TABLE IF NOT EXISTS agent_specs (
  agent_id    TEXT NOT NULL,
  spec_path   TEXT NOT NULL,
  spec_hash   TEXT NOT NULL,
  spec_kind   TEXT NOT NULL,
  content     TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, spec_path)
);

CREATE TABLE IF NOT EXISTS agent_state (
  agent_id    TEXT NOT NULL,
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, key)
);

-- ───────────────────────────────────────────────────────────────────────────
-- 场景组（§18.3）：一个场景恰好一个 group Conversation
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scenes (
  scene_id          TEXT PRIMARY KEY,
  name              TEXT,
  facility_id       TEXT,
  facility_json     TEXT,

  -- v2 新增：场景 ↔ mesh 会话绑定
  conversation_id   TEXT,          -- mesh_conversations.id（跨库裸引用）；一个场景恰好一个会话
  floor_mode        TEXT,          -- 建会话时请求的发言权模式，用于回放核对
  conv_bound_at     TEXT,

  virtual_start     TEXT,
  virtual_now       TEXT,
  participants_json TEXT NOT NULL, -- [{agent_id, role, mesh_account_id}, ...]
  turn_policy       TEXT,
  turn_count        INTEGER NOT NULL DEFAULT 0,

  token_budget      INTEGER,
  token_spent       INTEGER NOT NULL DEFAULT 0,

  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL,
  ended_at          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_scenes_conversation
  ON scenes(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scenes_status ON scenes(status);

-- ───────────────────────────────────────────────────────────────────────────
-- 记忆组（§18.4.1）
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS episodes (
  episode_id        TEXT PRIMARY KEY,
  owner_agent       TEXT NOT NULL,        -- 分区键（§18.7 / §19.4）
  kind              TEXT NOT NULL,        -- 'event' | 'impression' | 'fact' | 'self'
  scene_id          TEXT,                 -- 本环内引用 scenes.scene_id（非裸引用）
  purpose_kind      TEXT,                 -- 可空；'teaching_progress' | 'misconception_corrected' | …（§17.4）

  -- 证据锚点：全部跨库裸引用，无外键
  source_msg_id     TEXT,                 -- → mesh_messages.id
  source_session_id TEXT,                 -- → pi session id
  source_entry_id   TEXT,                 -- → mesh_stream_entries.entry_id / pi JSONL 条目 id

  gist              TEXT NOT NULL,
  detail            TEXT,
  quote             TEXT,                 -- 允许留存极短原文摘录（§18.6.4）

  emotion           TEXT,
  valence           REAL,
  arousal           REAL,
  salience          REAL NOT NULL DEFAULT 0.5,
  confidence        REAL NOT NULL DEFAULT 0.5,
  accuracy          REAL,

  -- 时间：字面量与物化整数并存，同一次写入由 parseVirtualTs 算好（§15.1.3）
  virtual_ts        TEXT,                 -- 场景虚拟时钟字面量，如 'W3D1T14'
  virtual_hours     INTEGER NOT NULL DEFAULT 0,  -- 同一时刻的虚拟小时数；衰减与排序只用这一列
  real_ts           TEXT NOT NULL,

  rehearsal_count   INTEGER NOT NULL DEFAULT 0,
  last_recalled_at  TEXT,
  retention         REAL NOT NULL DEFAULT 0.5,

  status            TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'faded' | 'consolidated'（§15.2）
  model_config_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodes_owner_ts    ON episodes(owner_agent, real_ts DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_owner_scene ON episodes(owner_agent, scene_id);
CREATE INDEX IF NOT EXISTS idx_episodes_owner_kind  ON episodes(owner_agent, kind, retention DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_src_msg     ON episodes(source_msg_id) WHERE source_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ep_vhours            ON episodes(owner_agent, virtual_hours DESC);
CREATE INDEX IF NOT EXISTS idx_ep_purpose           ON episodes(owner_agent, purpose_kind, virtual_hours DESC)
  WHERE purpose_kind IS NOT NULL;

-- 主体挂载（§16.1.1）：主键 (episode_id, subject_type, subject_id) 二元组主体
CREATE TABLE IF NOT EXISTS episode_subjects (
  episode_id      TEXT NOT NULL,
  subject_type    TEXT NOT NULL,   -- §16.1 六值：person|facility|self|knowledge|curriculum|group
  subject_id      TEXT NOT NULL,   -- SubjectRef.id；person 允许 'npc:*'；不得出现 '<x>:reflect'（N1）
  role_in_episode TEXT,            -- 'actor' | 'target' | 'topic' | 'mentioned'
  weight          REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (episode_id, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_episode_subjects_subject ON episode_subjects(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS subject_profiles (
  owner_agent   TEXT NOT NULL,     -- 分区键
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  impression    TEXT,
  valence       REAL,
  closeness     REAL,              -- 亲近度；facility 复用为熟悉度（§16.3.2）
  trust         REAL,              -- 信任度；facility 与 self 一律 NULL（§16.3.2 / SE3）
  traits_json   TEXT,
  episode_count INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT,              -- [{episode_id, weight}, ...]，只放本环 id
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (owner_agent, subject_type, subject_id)
);

-- FTS5：只索引 gist 一列（§14.2.3）。trigram 是中文检索的零依赖解法。
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  gist,
  content       = 'episodes',
  content_rowid = 'rowid',
  tokenize      = 'trigram'
);

-- 三个同步触发器（content= 外部内容表模式必须手动维护，§14.2.3）
CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, gist) VALUES (new.rowid, new.gist);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, gist) VALUES('delete', old.rowid, old.gist);
END;
CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE OF gist ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, gist) VALUES('delete', old.rowid, old.gist);
  INSERT INTO episodes_fts(rowid, gist) VALUES (new.rowid, new.gist);
END;

-- ───────────────────────────────────────────────────────────────────────────
-- 知识组（§18.4.2）
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_items (
  kn_id                 TEXT PRIMARY KEY,
  owner_agent           TEXT NOT NULL,   -- 分区键
  topic                 TEXT NOT NULL,   -- 知识点标识，与 subject_id 的 'kn:*' 同源
  claim                 TEXT NOT NULL,   -- 这个 Agent 现在认为它是什么

  -- §17.1 七态状态机。'unseen' 由「没有这一行」表达（trg_kn_no_unseen）
  mastery               TEXT NOT NULL,   -- heard|understood|applied|mastered|fading|forgotten
  confidence            REAL NOT NULL DEFAULT 0.5,

  -- §17.5 知识衰减。阈值与 episodes 不同（0.35 → fading，0.10 → forgotten）
  retention             REAL NOT NULL DEFAULT 1.0,
  practice_count        INTEGER NOT NULL DEFAULT 0,
  last_practiced_at     TEXT,
  last_practiced_vhours INTEGER NOT NULL DEFAULT 0,

  -- §17.4 误区。与 mastery 正交：不是「掌握度低」，是「掌握度不低但内容错了」
  is_misconception      INTEGER NOT NULL DEFAULT 0,
  wrong_belief          TEXT,            -- 纠正后**不清空**，作为历史

  -- §17.3 归因（不是授权）：这条知识是谁教会的
  taught_by             TEXT,            -- SubjectRef 序列化形式；不得出现 '<x>:reflect'（N1）

  source_kind           TEXT,            -- 'told'|'observed'|'inferred'|'template_seed'
  source_msg_id         TEXT,            -- 跨库裸引用 → mesh_messages.id
  first_seen_at         TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  model_config_hash     TEXT,

  -- K1：「我的掌握度」与「我对别人的判断」不得抢同一行 ⇒ 后者根本不建行（§17.3）
  UNIQUE (owner_agent, topic)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_owner_topic     ON knowledge_items(owner_agent, topic);
CREATE INDEX IF NOT EXISTS idx_knowledge_src_msg         ON knowledge_items(source_msg_id) WHERE source_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_decay           ON knowledge_items(owner_agent, last_practiced_vhours)
  WHERE mastery <> 'forgotten';
CREATE INDEX IF NOT EXISTS idx_knowledge_misconception   ON knowledge_items(owner_agent, topic)
  WHERE is_misconception = 1;

-- unseen 是隐含状态：禁止写 'unseen' 行（§17.1.1）
CREATE TRIGGER IF NOT EXISTS trg_kn_no_unseen BEFORE INSERT ON knowledge_items
WHEN NEW.mastery = 'unseen'
BEGIN SELECT RAISE(ABORT, 'unseen is implicit: do not insert a row'); END;

CREATE TABLE IF NOT EXISTS knowledge_events (
  ev_id         TEXT PRIMARY KEY,
  kn_id         TEXT NOT NULL REFERENCES knowledge_items(kn_id),
  owner_agent   TEXT NOT NULL,      -- 分区键（冗余但必需，§18.4.2）
  from_mastery  TEXT,               -- 建行时为 NULL（T1：无行 → heard）
  to_mastery    TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,      -- §17.2 封闭八值
  evidence      TEXT,
  episode_id    TEXT REFERENCES episodes(episode_id),  -- 本环内**有**外键
  virtual_ts    TEXT,
  virtual_hours INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,

  CHECK (evidence_kind IN ('mentioned','explained','self_explained','solved',
                           'taught','failed','corrected','decay'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_events_kn    ON knowledge_events(kn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_events_owner ON knowledge_events(owner_agent, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 自省组（§18.4.3）
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reflections (
  reflection_id     TEXT PRIMARY KEY,
  owner_agent       TEXT NOT NULL,   -- 分区键
  trigger           TEXT NOT NULL,   -- 'scene_end' | 'periodic' | 'manual' | 'threshold'
  scene_id          TEXT,

  -- D-A：自省一次往返在 mesh 侧留下的痕迹，全部跨库裸引用
  reflect_msg_id    TEXT,            -- → mesh_messages.id（发给自省流的那条）
  result_msg_id     TEXT,            -- → mesh_messages.id（自省流回来的那条）
  reflect_session_id TEXT,           -- → pi session id（自省会话）

  input_json        TEXT,
  output_json       TEXT,
  episodes_written  INTEGER NOT NULL DEFAULT 0,
  profiles_touched  INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'done',  -- 'running' | 'done' | 'failed'
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  model_config_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_reflections_owner ON reflections(owner_agent, started_at DESC);

CREATE TABLE IF NOT EXISTS state_writes (
  write_id     TEXT PRIMARY KEY,
  owner_agent  TEXT NOT NULL,        -- 分区键
  target       TEXT NOT NULL,        -- 'episode' | 'subject_profile' | 'knowledge' | 'agent_state'
  target_id    TEXT NOT NULL,        -- 二元组主键表编码为 `subject_type || ':' || subject_id`（§16.1）
  op           TEXT NOT NULL,
  reason       TEXT,                 -- 机器可读原因码（§18.4.3 封闭取值域）；正常写入为 NULL
  before_json  TEXT,
  after_json   TEXT,
  actor        TEXT NOT NULL,        -- 'MemoryService' | 'ReflectionService' | 'Projector' | 'host'
  reflection_id TEXT,
  real_ts      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_writes_target ON state_writes(target, target_id, real_ts);
CREATE INDEX IF NOT EXISTS idx_state_writes_owner  ON state_writes(owner_agent, real_ts DESC);
CREATE INDEX IF NOT EXISTS idx_state_writes_reason ON state_writes(reason, real_ts DESC)
  WHERE reason IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 审计组（§18.4.4 + §12.1.4）
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS retrieval_log (
  retrieval_id    TEXT PRIMARY KEY,
  owner_agent     TEXT NOT NULL,
  scene_id        TEXT,
  turn            INTEGER,

  trigger_msg_id  TEXT,              -- 跨库裸引用 → mesh_messages.id

  query_json      TEXT,
  candidates      INTEGER,
  selected_json   TEXT,              -- [{episode_id, score, channel, tokens}, ...]
  tokens_l2       INTEGER,
  tokens_l1       INTEGER,
  tokens_transient INTEGER,
  tokens_total    INTEGER,
  clamped         INTEGER NOT NULL DEFAULT 0,

  -- v2 新增：记忆卡片走 P2 不持久化，回放必须靠本环自留快照（§18.4.4）
  rendered_card   TEXT,
  card_sha256     TEXT,

  real_ts         TEXT NOT NULL,
  model_config_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_retrieval_owner_ts ON retrieval_log(owner_agent, real_ts DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_scene    ON retrieval_log(scene_id, turn);

-- §14.4.3 同轮幂等键：一条触发消息在一个 owner 上只允许一次自动检索
CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_once
  ON retrieval_log(owner_agent, trigger_msg_id)
  WHERE trigger_msg_id IS NOT NULL;

-- 越界发起尝试的本环留痕（§19.2.5）。表名不带 mesh_ 前缀（mesh 保留该前缀）。
CREATE TABLE IF NOT EXISTS boundary_events (
  event_id        TEXT PRIMARY KEY,
  owner_agent     TEXT NOT NULL,     -- 分区键，服从 A1 的 owner 约束

  actor_account_id TEXT NOT NULL,     -- 跨库裸引用 → mesh_accounts.id
  actor_kind      TEXT,              -- 'facility' | 'role' | 'system'

  conversation_id TEXT,              -- 跨库裸引用 → mesh_conversations.id
  scene_id        TEXT,

  attempted_kind  TEXT,              -- envelope.kind：mesh 封闭五值之一
  reason_code     TEXT NOT NULL,     -- 取值域 = mesh 附录 D reject 十项，不自造码（§18.4.4）
  tool_call_id    TEXT,

  virtual_ts      TEXT,
  real_ts         TEXT NOT NULL,
  detail_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_boundary_owner_ts ON boundary_events(owner_agent, real_ts DESC);
CREATE INDEX IF NOT EXISTS idx_boundary_reason   ON boundary_events(reason_code, real_ts DESC);
CREATE INDEX IF NOT EXISTS idx_boundary_actor    ON boundary_events(actor_account_id, real_ts DESC);
CREATE INDEX IF NOT EXISTS idx_boundary_scene    ON boundary_events(scene_id, virtual_ts);

-- 记忆判定幂等键 + B 模式工作队列（§12.1.4）。DDL 权威出处是 §12.1.4 而非 §18。
CREATE TABLE IF NOT EXISTS memory_decisions (
  owner_agent     TEXT NOT NULL,
  source_msg_id   TEXT NOT NULL,           -- 裸 mesh_messages.id，无 REFERENCES
  path            TEXT NOT NULL CHECK (path IN ('P1','P2','P3')),
  score           REAL NOT NULL,
  write_decided   INTEGER NOT NULL,        -- 0/1，打分函数的 write
  written         INTEGER NOT NULL DEFAULT 0,  -- Agent 是否真的调了 remember
  nudged          INTEGER NOT NULL DEFAULT 0,  -- 是否已发过 B 模式兜底
  components_json TEXT NOT NULL,
  virtual_ts      TEXT NOT NULL,
  decided_at      TEXT NOT NULL,
  PRIMARY KEY (owner_agent, source_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_memdec_pending ON memory_decisions(owner_agent, written, nudged)
  WHERE write_decided = 1 AND written = 0;