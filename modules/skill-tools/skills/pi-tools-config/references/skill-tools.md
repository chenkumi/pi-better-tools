# Skill Tools：隨包技能載入與停用

## 指令與工具

本模組透過 `resources_discover` 提供 `modules/skill-tools/skills/`，不註冊新的 model tool 或獨立設定命令。技能用 `/skill:<name> <需求>` 明確選用，或由模型依 description 按需讀取。

本設定技能為 `/skill:pi-tools-config <模組或設定問題>`；其他技能名稱以目前探索目錄為準，例如 create-plan、draft-plan、execute-plan、write-prompt。`SKILL.md` 是入口，references／scripts 等為相對該技能目錄解析的資源，不是獨立技能。

## Config 與作用範圍

**沒有模組 JSON config 或專屬 settings 鍵。** 根 manifest 已包含 `modules/skill-tools/src/index.ts` 及整個 skills 資料夾；新增有效 `skills/<name>/SKILL.md` 後 `/reload` 或重啟即可探索，不需複製到使用者 home。

- Frontmatter 至少有 `name` 與英文 `description`，說明具體使用情境。`pi-tools-config` 已依使用者要求放寬原本的 50 字元限制，以 config 需求、功能／工具名稱及排除情境界定選用範圍，不把工具的日常操作全列為觸發條件。
- description 常駐於技能目錄，正文／references 按需讀取。不要把所有 reference 直接嵌入 system prompt。
- 名稱碰撞時先探索到的版本可能優先，請檢查是否有同名使用者／專案技能，不自動刪除它們。
- 若需要完全停用本模組，使用 package `extensions` filter 排除上述入口。
- `skills: []`／`--no-skills` 不能抑制已啟用 extension 的動態 `resources_discover`；這不同於一般 Pi skill discovery。
- Pi 的 `enableSkillCommands` 管理互動命令目錄，並非 Skill Tools 私有鍵；不要為了設定模組自動改它。

驗證 `/reload` 後技能目錄有 pi-tools-config、無 diagnostics，且完整正文未在使用前注入；再依使用者需求選取一份 reference。停用 extension 不會刪檔或移動技能。
