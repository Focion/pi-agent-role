-- R33（§18.2 mesh_instance_tag 生产 + 双库配对锚点）
--
-- role 生成并持久化「双库配对标识」：单行表。mesh 侧不新增任何 schema，而是用公开
-- registerAccount 注册一个锚点账号，把同一标识写进该账号的 profile_ref（mesh 只存不解释）。
-- 读取路径（恢复 / 成本重算 / 悬挂扫描）回读锚点并核对完整 id + 标记，成立才出数；
-- 缺锚点 / 标记不符 / mesh 被替换时整体拒绝（E3 / F5 / T4.7 / T6.10）。
--
-- 约束：表名不以 mesh_ 开头（§18.7 P10：角色库不得出现 mesh_ 对象）；不跨库 ATTACH；
-- 不迁移旧 NULL——本库未发布，采用新建双库，旧开发数据的 NULL tag 不补写。
CREATE TABLE IF NOT EXISTS pairing_anchor (
  id             INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行哨兵：id 恒为 1
  pairing_id     TEXT NOT NULL,                       -- role 生成的配对标识（UUID）
  anchor_account TEXT NOT NULL,                       -- mesh 侧承载该标识的锚点账号 id
  created_at     TEXT NOT NULL
);