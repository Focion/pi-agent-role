-- ═══════════════════════════════════════════════════════════════════════════
-- pi-agent-role — 迁移 006：Agent 可恢复退役（§4.6.2 / R10）
--
-- 退役是可逆软删除：status='retired' + retired_at 记录退役时刻，role 侧全部行保留，
-- mesh 侧账号/端点/历史一律不动（mesh 无删账号 API）。restore 清 retired_at 恢复 active；
-- deleteAgent 才永久删除 role 侧行，mesh 历史仍保留。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE agents ADD COLUMN retired_at TEXT;