# Skill Tools

原生 Pi 1.1.0 extension，透過 `resources_discover` 的 `skillPaths` 提供隨模組封裝的 skills。無新工具、命令、設定、模型呼叫、背景工作或全域檔案寫入。

## 載入與使用

根 package manifest 已包含 `modules/skill-tools/src/index.ts`，既有本機掛載在 `/reload` 或重啟後載入。也可獨立試用：

```powershell
pi -e ./modules/skill-tools/src/index.ts
```

提供 `skills/create-plan/SKILL.md`、`skills/draft-plan/SKILL.md`（將想法或修改目標以最小呈現草稿——wireframe、具體輸入輸出、轉換表——讓使用者判斷差異，設計開始即建立設計文件並即時記錄每項決策，原生新增）、`skills/execute-plan/SKILL.md`（通用的計畫執行流程，不綁定特定計畫產生者；受 git 管理時於開始前 commit 起始狀態、計畫有 checkpoint 時逐一 commit 作為回滾點，原生新增）與 `skills/write-prompt/SKILL.md`（撰寫提示詞／skill 的通用最佳實踐，原生新增，整理自 OpenAI 與 Anthropic 官方提示指南），以及 `skills/expert-lens/SKILL.md`（使用者要專家級、更深入而非更長的回答時，先以四個問題——專家主動多做的事、第一手素材、具體方法與工具、獨立於雙方的正確性證據——重寫題目再執行，原生新增），以及 `skills/verify-findings/SKILL.md`（複審 scan bug／reliability 問題：每項由乾淨子代理獨立審查，僅有固定且穩定重現的才成立並列入報告，原生新增），以及 `skills/review-diff/SKILL.md`（指定範圍的 diff 審查：主代理確認範圍並解析 merge-base 等唯讀基準，派 `reviewer` 子代理依 `references/rubric.md` 判斷與排序 findings，只回報 verdict 與 note report 路徑，不改檔、不產生 patch，原生新增，2026-10-24；report 內容覆寫 reviewer 預設段落、不修改 reviewer agent 定義），使用 `/skill:create-plan <需求>`、`/skill:expert-lens <問題>`、`/skill:verify-findings <掃描報告>`、`/skill:review-diff <範圍>`、`/skill:draft-plan <想法>`、`/skill:execute-plan <計畫>`、`/skill:write-prompt <需求>` 或讓模型依 description 選用。完整指示按需讀取，不會整份預先注入 system prompt。

`skills/clean-code-refactor/SKILL.md`（原生新增，2026-10-23）：依 clean code 原則做行為不變的整理——消除重複的知識、拆分做太多事的函式、命名魔術數字、修正誤導名稱、刪除可證明的死碼；流程含界定範圍與第三方排除、修改前基準、`edit`／`write` 修改、等價性審查清單、缺陷以 red→green 回歸測試另行處理、中繼資料同步與最終全量重跑，以及以 `subagent` 平行整理多模組時的任務說明與協調者審查。`references/` 收錄原則、審查清單與交付格式，只連結技能目錄內資源。使用 `/skill:clean-code-refactor <範圍>`。只需刪除多餘程式或降低複雜度時亦可用 `software-refactory`。

停用時，在 package 的 `extensions` filters 排除 `modules/skill-tools/src/index.ts`；不會刪除 skill 檔案。這是 extension 動態提供的資源，不是根 manifest 的 `pi.skills`：package `skills: []`／Pi `--no-skills` 只停用一般 skill discovery，不能停用已啟用 extension 的 `resources_discover`。需要完全停用本模組 skills，請停用這個 extension。既有 project trust 規則由 Pi 管理，不自動授權。

## pi-tools-config：模組指令與設定索引

`skills/pi-tools-config/SKILL.md` 使用英文 description，依使用者要求放寬原本的 50 字元限制，直接列出需要 config 的功能／工具：資料庫連線、PTY named targets、搜尋 provider／credentials、自訂 agents、排程預設、模型速度、壓縮／記憶及 Shell／File 設定；不依賴套件名稱作為觸發詞。建立／修改／排查 config、資料庫連線的必要設定缺失／未知，以及 Chromium／PTY native 元件安裝與 setup CLI 診斷時適用，排除已配置工具的日常操作與應用程式功能開發。Web／PTY references 內建發布後 CLI、安裝實例定位、HTTP fallback 與權限／cache 說明，不依賴使用者目前 cwd、repository scripts 或技能所在的 package 位置。使用 `/skill:pi-tools-config <設定問題>`，或由模型依 description 選用。

入口只保留共通設定原則與索引；`references/` 的 17 份文件一一對應本專案所有本地模組，各自說明工具／slash commands、config 路徑與作用範圍、最小範例、套用方式及安全限制。沒有專屬 config 的模組明確註記，不捏造設定鍵。技能文件只連結 `pi-tools-config/` 內部資源，不連結其他模組 README、repository 文件或外部範例；必要設定資訊直接收錄於 references。整個技能目錄可獨立搬移，不依賴 package 目錄布局、原來源專案或 home 副本。

本技能不新增 runtime 工具／設定，也不自行讀寫真實 credentials 或全域設定。依賴既有遞迴 resource discovery 與整個 skills 目錄的封裝規則，新增後 `/reload` 即可。

## 維護

新增 skill 時，在 `skills/<name>/SKILL.md` 提供有效 frontmatter 的 `name`／`description`；Pi 遞迴探索該目錄。支援檔案放在相同 skill 目錄、用相對路徑引用。不另建 plugin manager，不複製到使用者 home，不依賴來源的絕對路徑。

`create-plan` 由使用者授權從 `~/.agents/skills/create-plan/` 原樣搬入；原有指示與 frontmatter 不變。不要保留另一份同名全域 skill，否則 Pi 可能產生名稱衝突、使用先探索到的版本。搬移只在本次明確要求下執行，extension 安裝／載入／reload 不執行遷移。回退可停用 extension，將該 skill 目錄移回原處。

## 驗證

```powershell
npm run test:module -- skill-tools
```

包含 strict typecheck、單元 hook 契約，以及隔離 home／agentDir 的真實 Pi startup／reload／停用與 skill command expansion 驗證；不呼叫真實 provider。根 cross／production smoke 另驗證所有入口共存及 tarball 包含 skill 資源；技能目錄內的 `scripts/`（例如 `agents-md-creator/scripts/estimate_tokens.py`）是 SKILL.md 會呼叫的 runtime 資源，隨套件發布且列為必要檔案，其他位置的 `scripts/` 仍視為開發內容而拒絕。
