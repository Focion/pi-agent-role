-- ═══════════════════════════════════════════════════════════════════════════
-- 003：场景宿主与 cue 发送身份定稿（R13/R15 · A04/A18）
--
-- 新增一列，落在 §18.3 的 scenes 上：
--   · host_account_id —— 场景建档者声明的 cue 发送账号（@system / 宿主自有账号）。
--
-- 修复两个缺陷：
--   · A04：cue 的 from 曾可退化为 role:'host' 参与者（角色 initiate 只有 chat/task/event，
--     无 system），mesh gate ② 会以 CANNOT_INITIATE 拒绝。现在 cue 的权威 from = 本列，
--     再退 deps.hostAccountId，最后 @system——普通角色永不充当 system 发送者。
--   · A18：SceneSpec.hostAccountId 此前只活在 create() 的临时参数里，未落库；resume 时
--     resolveHost 拿到 undefined，只能退回 @system，建档者声明的发送身份被静默丢弃。
--
-- 可空：缺省 NULL 表示「未显式声明，退 deps / @system」。不设 NOT NULL 默认，避免把
-- 「从未声明」误解成「声明为 @system」（与 002 的可空策略一致）。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE scenes ADD COLUMN host_account_id TEXT;