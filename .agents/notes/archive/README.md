# notes/archive — 归档文档

存放已**作废、被取代或取消**的文档。目的是保留历史决策的可追溯性，同时让其他目录只剩当前有效内容。

## 什么时候归档

- 方案被新方案取代
- 需求被砍掉或计划被取消
- 结论已被证伪
- 文档内容整体过期，且无人维护

**归档 ≠ 删除**：直接删除会丢掉「为什么当时那样决定」的信息，一律移动到此目录。

## 怎么归档

1. `git mv` 原文件到 `notes/archive/`（保留原文件名，含原始日期前缀）。
2. 更新 frontmatter：

   ```markdown
   status: archived
   archived_date: <YYYY-MM-DD>
   archived_from: notes/tech/2026-08-01-old-design.md
   archived_reason: 被 notes/tech/2026-09-14-new-design.md 取代
   ```

3. 在正文顶部加一行提示：

   ```markdown
   > **已归档（<YYYY-MM-DD>）**：本文档不再有效，请参见 <新文档路径>。
   ```

4. 检查还有哪些文档在 `related` 里引用它，把引用改指向新文档。

## 约定

- 归档文件不再修改内容，只加归档标记。
- 文件名冲突时在末尾加 `-2`，不要改原日期前缀。
- 读文档时若发现路径位于 `archive/`，视为历史信息，不得据此做当前决策。
