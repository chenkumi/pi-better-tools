# Skill Tools

原生 Pi 1.1.0 extension，透過 `resources_discover` 的 `skillPaths` 提供隨模組封裝的 skills。無新工具、命令、設定、模型呼叫、背景工作或全域檔案寫入。

## 載入與使用

根 package manifest 已包含 `modules/skill-tools/src/index.ts`，既有本機掛載在 `/reload` 或重啟後載入。也可獨立試用：

```powershell
pi -e ./modules/skill-tools/src/index.ts
```

提供 `skills/create-plan/SKILL.md`，使用 `/skill:create-plan <需求>` 或讓模型依 description 選用。完整指示按需讀取，不會整份預先注入 system prompt。

停用時，在 package 的 `extensions` filters 排除 `modules/skill-tools/src/index.ts`；不會刪除 skill 檔案。這是 extension 動態提供的資源，不是根 manifest 的 `pi.skills`：package `skills: []`／Pi `--no-skills` 只停用一般 skill discovery，不能停用已啟用 extension 的 `resources_discover`。需要完全停用本模組 skills，請停用這個 extension。既有 project trust 規則由 Pi 管理，不自動授權。

## 維護

新增 skill 時，在 `skills/<name>/SKILL.md` 提供有效 frontmatter 的 `name`／`description`；Pi 遞迴探索該目錄。支援檔案放在相同 skill 目錄、用相對路徑引用。不另建 plugin manager，不複製到使用者 home，不依賴來源的絕對路徑。

`create-plan` 由使用者授權從 `~/.agents/skills/create-plan/` 原樣搬入；原有指示與 frontmatter 不變。不要保留另一份同名全域 skill，否則 Pi 可能產生名稱衝突、使用先探索到的版本。搬移只在本次明確要求下執行，extension 安裝／載入／reload 不執行遷移。回退可停用 extension，將該 skill 目錄移回原處。

## 驗證

```powershell
npm run test:module -- skill-tools
```

包含 strict typecheck、單元 hook 契約，以及隔離 home／agentDir 的真實 Pi startup／reload／停用與 skill command expansion 驗證；不呼叫真實 provider。根 cross／production smoke 另驗證所有入口共存及 tarball 包含 skill 資源。
