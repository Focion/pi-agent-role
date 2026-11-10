-- ═══════════════════════════════════════════════════════════════════════════
-- 002：知识衰减稳定基线（R26 / A14 / A32 / A33 / A34 / A35）
--
-- 新增两列，落在 §18.4.2 的 knowledge_items 上：
--   · decay_from         —— fading 由哪个掌握度降来（understood|applied|mastered|NULL）。
--                          A14：自省把 fading 恢复回去时，晋级上限 = 衰减前状态（§17.1.2 T9），
--                          不能借一句 mentioned 直接跳 mastered（除非衰减前就是 mastered）。
--   · last_decay_vhours  —— 上一轮衰减节拍的虚拟小时（幂等基线）。
--                          A32：同一虚拟小时重复扫描不再用「当前(fading)」的较小 factor 重算，
--                          避免 mastered→fading→forgotten 在一小时内被扫进彻底遗忘。
--
-- 两者都可空：新种入的 heard 尚未衰减过（decay_from 与 last_decay_vhours 均为 NULL），
-- 走 NOT NULL 默认值只会把「从未衰减」误解成「在 0 小时衰减过」。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE knowledge_items ADD COLUMN decay_from TEXT;
ALTER TABLE knowledge_items ADD COLUMN last_decay_vhours INTEGER;