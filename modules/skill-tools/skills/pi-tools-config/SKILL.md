---
name: pi-tools-config
description: >-
  Use when users need to create, change, or troubleshoot configuration
  for database connections (SQLite, MySQL, PostgreSQL/Postgres,
  SQL Server/MSSQL), named SSH/WSL terminal targets (pty_*),
  web search providers or API credentials (web_search), custom agents
  (subagent), scheduling defaults (schedule_prompt), model speed,
  compaction or memory, or shell and file-tool settings.
  Also use for requests to connect or set up a database when the
  required connection configuration is missing or unknown.
  Also use for Chromium installation, missing browser or PTY native
  dependencies, and setup CLI diagnostics.
  Do not use for routine operations with already-configured tools
  or for implementing these features in application code.
---

# Pi Tools 設定索引

當完成需求需要建立、修改或排查 config，或安裝／診斷 Chromium、PTY 選用元件時使用；以實際功能與工具名稱判斷，不要求使用者知道套件名稱。先依需求選取下列 reference，只讀相關模組，不把所有文件一次載入。

## 使用邊界

- 明確的設定需求會觸發：資料庫連線／SQLite 固定掛載、SSH／WSL named targets、搜尋 provider／API credentials、自訂 agents、排程預設 scope、模型速度、壓縮／記憶及 Shell／File 設定。
- 「想連接 MySQL／SQLite」等請求，在必要連線設定缺失或未知時也適用；先讀取資料庫 reference，必要時以 `tool_search` 搜尋 `sqlite`／`mysql`／`pgsql`／`mssql`，確認現有能力與設定缺口，不直接改寫成自訂腳本任務。
- 已配置工具的日常操作不因工具名稱而觸發。例如查詢已連線資料庫、manual 開啟 SQLite 檔案、建立一次提醒、寫 note 或監看工作，若不需要 config 變更就直接使用對應工具。
- 使用者要求在自己的應用程式實作連線／排程／SSH 功能，或只詢問概念時，不因關鍵字重疊就套用本技能。索引中無專屬 config 的模組只是設定邊界說明，不擴大觸發範圍。

| 請求 | 本技能是否適用 |
| --- | --- |
| 想連接 MySQL，尚未建立連線設定 | 是 |
| SQLite 要固定掛載到這個專案 | 是 |
| 新增 SSH target，或把搜尋改成 Brave | 是 |
| 修改排程的預設 scope | 是 |
| 沒有 Chromium、想安裝瀏覽器，或 PTY native binding 缺少 | 是 |
| 發布套件的安裝命令／doctor 如何使用 | 是 |
| 用已連線的 MySQL 查詢 orders | 否 |
| 開啟 SQLite 檔查資料，不需持久掛載 | 否 |
| 十分鐘後提醒我 | 否 |
| 在應用程式中實作 MySQL connection pool | 否 |

## 共通原則

- 先分清楚使用者要改的是全域、專案還是目前 session，以及目標 cwd；各模組的設定來源不同，不一律當成 Pi `settings.json`。
- 本技能說明以 pi-better-tools 的 Pi 1.3.0 整合行為為基準。選用元件使用實際安裝實例的 setup CLI，見 Web／PTY reference；不假定原始 repository、目前 cwd 或全域命令存在。不以 `npx` 下載另一份最新版作為修復。
- 安裝需求不等於授權系統變更：先用 `doctor` 唯讀診斷，瀏覽器下載／native setup 依使用者明確需求執行；修改 Linux 系統依賴前另確認。skill 複製或 extension reload 不觸發安裝。
- 一般 Pi 設定為 `<agentDir>/settings.json` 與受信任專案 `<cwd>/.pi/settings.json`；`agentDir` 預設 `~/.pi/agent`。只有明說支援的模組才跟隨 `PI_CODING_AGENT_DIR`，例外見各 reference。
- 工具選取由 Pi 的 `defaultTools`、`--tools`、`--exclude-tools`、`--no-tools`／互動工具選取控制，不把 `defaultTools` 當嚴格 allowlist。Deferred 工具先以 `tool_search` 搜尋 namespace；被排除的工具不能靠搜尋繞過。
- 提供設定範例時用佔位值或環境變數引用，不輸出真實密碼、token、連線字串或 auth 檔案。閱讀此技能不代表取得修改全域設定、開啟付費背景模型或操作資料庫的授權。
- 實際修改前讀取目標檔，保留其他鍵、現有 trust 與權限；依原請求範圍操作。回覆清楚列出設定位置、改動鍵、如何套用／驗證，以及未驗證項目。重載前提醒目前背景工作可能受影響。
- 設定說明與範例直接收錄於本技能的 references；所有文件連結只在技能目錄內解析。缺少進階鍵或與實際版本不符時，說明目前涵蓋範圍，請使用者提供該版本的有效設定資訊，不猜鍵名、推導原始專案路徑或偷偷套用上游預設。

## 模組索引

| 模組／問題 | 按需讀取 |
| --- | --- |
| Subagents：自訂 agent、模型／工具選取、委派與背景面板 | [subagents](references/subagents.md) |
| Shell：Bash／PowerShell、總逾時、自動轉背景 | [shell-tools](references/shell-tools.md) |
| File：read／edit／write／ls、除錯與 FFF 搜尋模式 | [file-tools](references/file-tools.md) |
| File Audit：近期檔案窗口／容量、手動增量檢查與停用 | [file-audit](references/file-audit.md) |
| Web：原生搜尋、Brave／Exa、Chromium 安裝與 HTTP 相容模式 | [web-tools](references/web-tools.md) |
| Note：分類筆記與自動路徑 | [note-tools](references/note-tools.md) |
| Pi Runtime：錯誤恢復、deferred discovery、共通提示 | [pi-runtime](references/pi-runtime.md) |
| Skill Tools：技能載入、指令與停用 | [skill-tools](references/skill-tools.md) |
| Monitor：監看 command／WebSocket／背景工作 | [monitor](references/monitor.md) |
| Fork：繼承對話的獨立 Pi 工作 | [fork](references/fork.md) |
| GPT Speed：normal／fast／ultrafast | [gpt-speed](references/gpt-speed.md) |
| JSON Schema：print 模式的結構化結果 | [json-schema](references/json-schema.md) |
| PTY：native setup、local／WSL／SSH 與環境過濾 | [pty-terminal](references/pty-terminal.md) |
| Schedule Prompt：排程、作用域、shell command job | [schedule-prompt](references/schedule-prompt.md) |
| Blackhole：摘要、記憶、recall 與費用控制 | [blackhole](references/blackhole.md) |
| SQLite：manual／fixed 資料庫掛載 | [sqlite-tools](references/sqlite-tools.md) |
| SQL Connector：MySQL／MSSQL／PostgreSQL | [sql-connector](references/sql-connector.md) |

這些 reference 一一對應 17 個本地模組。整個 `pi-tools-config/` 目錄可獨立搬移；保留 `SKILL.md` 與 `references/` 的相對結構即可，不需原始專案、模組 README 或外部範例檔。本文中的設定／安裝路徑描述實際產品的設定目標，並非本技能的文件依賴。
