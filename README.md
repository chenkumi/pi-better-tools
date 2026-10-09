# Pi Better Tools

單一 Pi extensions package，整合 Subagents、Shell Tools、Precise File Tools、Web Tools 、PTY Terminal 與 Schedule Prompt（第三方 pi-schedule-prompt 快照），加上 JSON Schema structured delivery，並提供本專案原生 Note Tools、GPT Speed、Pi Runtime 與 Monitor extensions。必要程式碼與資源已納入 `modules/`，不依賴來源專案的本機路徑。

> 本專案採用 [MIT License](LICENSE)。使用者已確認五個來源專案均為其所有，並授權本整合專案採 MIT；封裝測試以根目錄 `LICENSE` 為必要授權檔，不要求重複模組 LICENSE；原有模組授權聲明仍保留，來源與相依套件說明見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。`private: true` 僅用於避免誤發布 npm，不限制未來公開至 GitHub；目前未執行任何遠端發布。

## 本機安裝

需要 Node.js **`^22.22.2 || ^24.15.0 || >=26.0.0`**（與 jsdom 30 的 runtime 需求一致） 與 `@earendil-works/*` namespace 的 Pi。只支援 Pi **1.1.0**（開發基準與 production smoke 皆為 1.1.0），不代表其他 Pi 版本相容。

```powershell
cd D:\projects\pi-better-tools
npm ci --ignore-scripts
npm run pty:install       # 明確執行 node-pty native setup；無 prebuild 時需編譯工具
npm run build             # 目前沒有需要編譯的產物（no-op）；Pi extensions 直接載入 TS
npm run browser:install   # 若需要 web_fetch 的 Chromium
pi install D:/projects/pi-better-tools
```

只在目前使用中的專案安裝：`pi install -l D:/projects/pi-better-tools`。先試用、不改設定：`pi --no-extensions -e D:/projects/pi-better-tools`。十二個本地 extensions 直接載入 `modules/<name>/src/index.ts`，另兩個 npm extensions 使用其原始入口；修改本機程式碼後 `/reload` 或重新啟動 Pi 即可，不必先 build。

**若原五個 packages 或獨立 `pi-pty-terminal` 已啟用，請先停用其 extensions**，避免與整合包重複註冊相同工具。這些設定不會自動修改。完整步驟與回退見 [docs/migration.md](docs/migration.md)。

Pi-managed npm／git package 安裝會處理 runtime dependencies；本機路徑不會自動替你執行 npm install。Chromium 不在 tarball 裡，extension 載入時也不下載／啟動瀏覽器。解壓 tarball 後可在安裝目錄執行 `npm run browser:install`；勿在 runtime-only tarball 執行 repository 的 build／test scripts。

### 本地 Blackhole 與兩個 npm Pi packages（原始碼掛載）

根 `dependencies` 固定包含 `pi-open-tui@0.3.11`、`@ff-labs/pi-fff@0.11.0`。Blackhole 0.5.12 原始碼已納入 `modules/blackhole/`，Pi 改載入 `./modules/blackhole/src/index.ts`，不再依賴 npm 的 `pi-blackhole`。`npm ci --ignore-scripts` 會安裝兩個 npm packages；manifest 為十二個本地入口加兩個 npm 入口，共十四個。仍維持 `private: true`，不需要 npm 發布、bundledDependencies 或 postinstall 呼叫 pi install。

換機請下載／複製本專案原始碼及 lockfile，在新機重新執行上述安裝步驟，然後只掛載本專案目錄；不要跨 OS／CPU 複製 node_modules。**本機掛載不會自動執行 npm install**。Repository `.npmrc` 設 `legacy-peer-deps=true`，避免依賴 peers 自動安裝另一份 Pi SDK；Blackhole 快照的上游開發版本／peer 範圍只作歷史 metadata，整合基準為 Pi 1.1.0，不以此設定宣稱相容。

啟用整合入口前，請手動停用原本 `npm:pi-open-tui`、`npm:pi-blackhole`、`npm:@ff-labs/pi-fff` 的獨立 extension 資源，避免 hooks／commands／tools 重複載入。Repository 不會改寫真實 Pi settings 或卸載它們。`pi config` 的既有 extension filters 仍有效；只掛載單一 module 入口不會載入全部套件。

這不是個人設定備份：`~/.pi/agent/open-tui.json`、`~/.pi/agent/pi-blackhole/pi-blackhole-config.json`、FFF 個人偏好及模型登入仍需另外搬移／配置，不在安裝時覆寫。Blackhole 背景記憶可能產生模型費用，請沿用自己的模型／fallback 配置；測試使用 passive 模式及隔離 auth。FFF 有各平台原生 binary，必須在目標平台重新安裝與驗證；Nerd Font、Chromium、系統函式庫也不因 Pi 掛載而自動安裝。

### macOS 安裝（Apple Silicon／Intel）

請先安裝符合上述版本要求的 Node.js 與 `@earendil-works/pi-coding-agent`，並以 `command -v node npm pi` 確認命令位置。Apple Silicon 建議使用原生 ARM64 Node.js，避免混用 Rosetta／Intel 與 ARM64 安裝；可用 `node -p 'process.platform + " " + process.arch'` 確認目前 Node.js 的平台／架構。

```bash
cd ~/GitHub/pi-better-tools    # 改成實際 checkout 路徑
npm ci --ignore-scripts
npm run pty:install       # 明確執行 node-pty native setup；無 prebuild 時需編譯工具
npm run build                 # 目前沒有需要編譯的產物（no-op）
npm run browser:install       # 選用：web_fetch 需要 Playwright Chromium
pi install -l "$PWD"          # 僅安裝到目前專案的 Pi 設定
```

`browser:install` 使用本專案的 Playwright 版本執行 `playwright install chromium --no-shell`，下載配套 Chromium；不需要另外全域安裝 Playwright。macOS 通常不需像 Linux 一樣安裝系統函式庫，使用此指令即可，不必執行 Linux 用的 `browser:install-deps` 或 `setup:browser`，也不要以 sudo 執行 `npm ci` 或瀏覽器安裝。支援的 macOS 版本請依目前 [Playwright 系統需求](https://playwright.dev/docs/intro#system-requirements) 確認，不能僅以 Node.js 能執行就判定 Chromium 相容。

- **快取與使用者**：預設瀏覽器下載至 `~/Library/Caches/ms-playwright`，請以執行 Pi 的同一位使用者安裝。若自訂 `PLAYWRIGHT_BROWSERS_PATH`，安裝與啟動 Pi 時必須使用相同值；Chromium 不包含在本專案 tarball 中。
- **找不到瀏覽器**：出現 `Executable doesn't exist` 時，請在本專案／套件安裝目錄重新執行 `npm run browser:install`。更新 Playwright、清理快取或更換 Node.js 架構後，也應重新執行；安裝時可能清理舊瀏覽器版本。
- **下載或啟動失敗**：確認網路／代理設定、快取目錄權限及 macOS 版本是否受支援。請勿以停用 TLS 驗證或移除系統安全保護作為安裝步驟。僅下載成功不代表 Chromium 能啟動。

Repository 開發環境可用 `npm run test:browser` 驗證真實 Chromium 與清理行為；runtime-only tarball 不包含 repository 測試。只使用非瀏覽器功能時可省略 Chromium 安裝；Pi package 安裝與 extension 載入均不會自動下載或啟動瀏覽器。需要先試用且不修改 Pi 設定，可用 `pi --no-extensions -e "$PWD"`。macOS 支援 Bash；本專案的 PowerShell backend 僅支援原生 Windows。

### Linux／WSL2 安裝

請在 Linux 環境安裝符合上述版本要求的 Node.js，以及 `@earendil-works/pi-coding-agent`。WSL2 建議將 repository 放在 Linux 檔案系統（例如 `~/GitHub/pi-better-tools`），並以 `command -v node npm pi` 確認使用 Linux 安裝的命令，而非 `/mnt/c/` 下的 Windows 全域 npm 命令。

```bash
cd ~/GitHub/pi-better-tools    # 改成實際 checkout 路徑
npm ci --ignore-scripts
npm run pty:install       # 明確執行 node-pty native setup；無 prebuild 時需編譯工具
npm run build                 # 目前沒有需要編譯的產物（no-op）
npm run setup:browser         # 選用：web_fetch 需要 Chromium 及 Linux 系統依賴
pi install -l "$PWD"          # 僅安裝到目前專案的 Pi 設定
```

`setup:browser` 呼叫 Playwright 安裝 Chromium 與系統依賴，會下載瀏覽器，並可能要求 sudo 權限、透過系統套件管理器安裝函式庫。只在你同意修改系統套件時執行；不要把整個 `npm ci` 改用 sudo。Pi package 安裝與 extension 載入都不會自動執行此步驟；`--ignore-scripts` 不影響之後明確執行的 `npm run setup:browser`。

若只使用非瀏覽器功能，可以省略 `setup:browser`。想分開安裝，或系統依賴由管理員／container image 提供時：

```bash
npm run browser:install-deps   # 僅系統依賴；Linux 可能要求 sudo
npm run browser:install        # 僅下載 Chromium，不安裝系統函式庫
```

`browser:install` 下載成功不代表 Chromium 一定能啟動。例如缺少 `libnspr4.so`、`libnss3.so` 或 `libasound.so.2` 時，仍需補裝系統依賴。無管理員權限、離線或 Playwright 不支援的 Linux 發行版，需由管理員依環境提供依賴；這些指令不保證每個發行版都能自動安裝。瀏覽器快取由 Playwright 管理，安裝時可能清理舊版本。

Repository 開發環境可用 `npm run test:browser` 驗證實際 Chromium；runtime-only tarball 不包含 repository 測試。需要先試用且不修改 Pi 設定，可用 `pi --no-extensions -e "$PWD"`。Linux 支援 Bash；本專案的 PowerShell backend 僅支援原生 Windows。

## Session 載入時的背景工作核對

Shell 與 Subagents 會在 `startup`／`resume`／`reload` 載入 session 時，核對同 owner session／canonical cwd 的最小生命週期紀錄；有新證據時分別補一則模型可見、TUI 可收合／展開的 custom 通知（`background-runtime-recovery-shell`／`-subagent`）。預設 `triggerTurn:false`，不啟動模型、不重跑命令、不自動續接 child 或重送 control；沒有相關歷史就不通知。

通知區分已記錄終結結果、退出時要求取消、結果未知及未確認開始。強制退出通常只能報「結果未知」，任何狀態都不代表確認整棵 process tree 已停止。工作 registry 不會重建；舊 job ID 不是恢復 API。同 branch 的已保存相同證據通知會去重，新結果可另補；不保證 exactly-once 或宿主送達確認。

新背景工作在 runner／managed allocation 前寫入 Pi session journal；只存 IDs、owner/cwd/runtime、狀態及 exit/error code，不存命令、prompt、輸出或 credentials。Pi 1.0.0 的空 SDK session／`--no-session` 無法持久化此紀錄，因此背景提交會以 `BACKGROUND_JOURNAL_FAILED` 拒絕；同步模式不受影響。歷史核對有上限，超額或格式損壞會明說 incomplete；舊版 receipt 只作保守 fallback，不承諾可重建所有舊工作。詳見兩模組 README。

## 功能

| 模組 | 工具／命令 | 注意事項 |
| --- | --- | --- |
| Subagents | `subagent`、`subagent_status/cancel/message`；三個 workflow prompts | `subagent` 建立 single／parallel／chain（同步預設，支援 `background:true`）；`subagent_message` 以 session ID 發送指示，自動 control 或安全續接；query 保持唯讀 |
| PTY Terminal | `pty_spawn/write/read/resize/wait_exit/kill/list` | `target` 預設 local；named WSL／SSH targets；session 綁定 target，關閉 transport 不保證遠端背景程序停止 |
| Schedule Prompt | `schedule_prompt`；`/schedule-prompt` | 排程週期／一次性 prompt（cron、ISO、`+10s`、`5m`）；可指定 `model` 以 in-process 背景 session 執行。資料存於 `<cwd>/.pi/schedule-prompts.json`，設定於 `<cwd>/.pi/schedule-prompts-settings.json`（全域 `<agentDir>/schedule-prompts-settings.json` 為手動預設）；預設綁定建立它的 session。僅 session 存活期間觸發，不是 OS 排程或 daemon |
| Shell Tools | 覆寫 `bash`、`powershell`；`shell_job_status/cancel` | 同步預設；`background:true` 立即回 jobId／liveLogPath；`timeoutMs` 仍為輸出停滯期限；管理工具需額外選取；PowerShell 僅原生 Windows |
| File Tools | 覆寫 `read`、`write`、`edit`、`grep`、`find`、`ls` | 絕對行號、32 字元 hash、精準 literal／regex、原子寫入、diff worker；搜尋沿用宿主，grep 收合預覽 5 行 |
| Web Tools | `web_fetch`；條件式 REST `web_search`；`/web-tools status`、`/web-tools sources` | OpenAI／Codex 原生搜尋預設啟用、無實驗開關或警告，不註冊同名 function tool；Brave／Exa 要明確設定；無登入／CAPTCHA bypass／PDF |
| Monitor | `monitor_start/status/stop` | 四來源：command stdout、WS text、readonly shell_job/subagent_job；明確選取才啟用，總期限預設5分鐘；不是daemon／PTY／sandbox |
| Note Tools | `note` | `{ type, content }`；自動分類、產生純時間戳檔名（`TYPE-<UTC 時間戳>.md`，不附加標題），只新增 Markdown 檔案並回報單一相對路徑，不覆寫 |
| GPT Speed | `/fast`、`/ultrafast`、`/normal` | GPT >= 5.6 的 luna／terra／sol／astra pattern；Ultrafast 在 luna／terra 降為 Fast；TUI 顯示實際速度 |
| Pi Runtime | `/runtime-recovery status`、`on`、`off`、`/runtime-recover <澄清>` | 每個可識別使用者任務最多 2 次診斷恢復；明確輸入錯誤可自動續行，cyber／policy／未知錯誤須人工 review 與 UI 確認；不啟用工具或更換模型 |
| JSON Schema | 條件式 `json_output`；`--json-schema`、`--json-output` | CLI schema + zod 4 驗證；有 `--json-output` 寫檔、否則單一 JSON stdout；未給 `--json-schema` 時 inactive |

Subagents **只保留 managed／可續接持久化**：`subagent` 只建立新子代理，提供 agent/task 或 tasks/chain；背景建立成功受理時，各 item 已有實際 managed `subagentSessionId`，但排隊身份不代表可互動或 checkpoint ready。後續使用 `subagent_message({ subagentSessionId, message })`；系統對可互動 invocation 送 control，對安全 ready session 非同步續接。不能覆寫保存的執行配置。`subagent.resume` 與 `resumable` 已移除，舊呼叫須遷移。專案新產生的 ULID 統一使用 `ulid().toUpperCase()`；既有小寫 ULID／UUID 仍可讀取，不更名。所有新 sessions 存於 `<agentDir>/subagent-sessions/<ULID>/`；失敗／取消不會冒稱 ready，舊 ephemeral logs 不自動轉換。

Subagent 的 `model`／`provider`／`thinkingLevel` 呼叫參數**預設省略，只有使用者或 skill 明確指定才傳入**。首次派遣先確認模型，再檢查該模型支援的思考等級；未知／歧義模型與未知／不支援等級忽略，依原預設規則執行，不因選擇參數無效直接報錯。模型預設為可用 agent 模型或 parent 模型；思考等級依模型繼承或使用 child 預設。Resume 與 child startup guard 仍嚴格驗證配置，不保證遠端 API 可用。完整規則見 [Subagents README](modules/subagents/README.md)。

工具 activation 仍由 Pi 的工具選取與 extension `defaultActive` 決定。`defaultTools` 不是全域 allowlist：部分 extension tools 會在註冊時啟用；需要嚴格唯讀請使用 `--tools read`，需要全部停用請用 `--no-tools`，排除工具用 `--exclude-tools`。整合包不增加另一層權限或 OS sandbox。

Pi **1.0.0** 預設 fullscreen TUI；本專案不自動修改 UI 設定，需要舊模式可自行用 `--tui-mode regular`。新版 `/reload` 會啟用新加入 `defaultTools` 的工具，但不會因刪除 defaults 而撤權；explicit tools／no-tools／exclusions 仍優先。

### Pi 1.1.0 與搜尋工具覆寫

根四個 Pi 開發套件／lockfile 升至 1.1.0；runtime 仍使用宿主 peers，不自動更新個人 Pi 安裝或設定。`read` 新增宿主相容的 `outputSchema/structuredContent`：codemode 讀文字仍取得本專案行號／metadata 字串，讀圖片取得可交給 `image()` 的 image block。Shell 繼續沿用宿主內容 renderer，取得 recorded `durationMs` 等修正；API 中斷卡片 resolver 重建 default Box 時沿用宿主 `outputPad`。1.1.0 的 hidden tool 仍保留 `toolSnippets` metadata，由 `hiddenTools` 過濾實際宣告／rules；SDK 回歸檢查實際 system prompt 不洩漏隱藏工具。本節更新目前支援基準，其他 1.0.0 描述保留原功能導入背景，不代表仍維護舊版。

file-tools 同名註冊 `grep/find/ls`，保留宿主搜尋、schema、ignore rules、limits、取消與 hook 語意；三者 `defaultActive:false`，不因 extension 載入額外啟用。使用 `--tools` 明確選取時請列入需要的名稱。`grep` 收合從 15 改為 5 個邏輯結果行（標頭／提示／警告及窄終端折行另計），展開與模型結果不縮減；`find/ls` 沿用宿主 renderer。詳見 [File Tools](modules/file-tools/README.md)。

### 工具 TUI 顯示

載入 Shell extension 後，尚未執行、因 API 中斷而被宿主合成 error 的工具卡片改為中性 `API interrupted`／`Resuming API request…`／`API response recovered`，不在恢復後殘留紅色，也不把舊 call 當成功。真正工具失敗與 Pi 原生 assistant error 保留；不改模型結果、不重跑工具、不啟用未選工具。歷史／reload 只保守重建 interrupted，不猜 retry 成功；追蹤有界，官方 retry 次數／倒數不在此修正範圍。詳見 [Shell Tools](modules/shell-tools/README.md#api-中斷工具卡片)。

原有 15 個互動式 function tools 均有 `renderCall`／`renderResult`（含沿用宿主 renderer）：Shell 保留宿主呈現；Subagent 可用選填 `title`（50 字內）顯示工作摘要，single 使用頂層欄位，parallel／chain 各項可附獨立標題；`subagent_message` 可附顯示用 title，續接時作為新 invocation 標題，並於 call／執行中／完成後呈現；File 的 `read`／`write` 錯誤顯示錯誤碼、訊息與 recovery，不再原樣顯示錯誤 JSON，`read` 成功與圖片仍沿用宿主行為，`write` 成功顯示 bytes，展開可看路徑與版本 token；`note` 摘要分類／標題與儲存路徑，不預覽整份 Markdown；Web 顯示來源、警告與全文暫存路徑，展開看結果文字；PTY 七個工具顯示 session／target／transport、讀取文字、transport exit／逾時與釋放狀態，不把 transport 結束冒稱遠端程序樹已停止。Renderer 只改 UI，不修改模型可見 content／structuredContent；Subagent 的選填 title 另保存於 parent details 顯示 metadata，不變 child task 或執行配置。

新增五個背景管理／互動工具亦有 call／result renderer：顯示 job／task／mode 與有界結果，清除顯示控制碼，不預覽 control／query 訊息內容，取消仍明示未確認程序樹終止。Subagent 訊息拒絕（如 `SESSION_BUSY`／`finalizing`）顯示錯誤碼、觀察狀態及下一步提示，不因未配置 job／interaction ID 誤稱資料不足；預期 busy/not-running/capacity/cancelled 拒絕使用 warning 的 `Query/Message not accepted` 但保留 `isError:true` 與 `status:"rejected"`，訊息未送達；警告文字不改模型端錯誤契約，因此原生工具背景仍由 Pi 依旗標顯示紅色；安全／設定／checkpoint／未知故障維持 error。舊結果不改寫，其原生背景仍由 Pi 的已保存 isError 控制；受理與不重送安全規則不變。`json_output` 僅在 print mode 搭配有效 schema 註冊，刻意維持無 TUI renderer；GPT Speed 沒有 function tool，OpenAI 原生搜尋亦非 Pi function tool。

### Managed child 前景 Shell 與 guard

主代理保留既有 `background:true`、receipt、管理工具及背景通知；由 Subagents 的 owned new／resume／ready-query 啟動且載入 Shell Tools 的 child，改用同名 `bash`／`powershell` 專用前景 definition（僅 `command`／`timeoutMs`、宿主同步 outputSchema），不註冊 `shell_job_status/cancel` 或建立 Shell 背景 registry／指引。身份只來自既有 `PI_SUBAGENTS_GUARD` handshake 的明確 `shellMode:"foreground-v1"`，不以 RPC／JSON／cwd／prompt 推測；先載入的 Shell／guard 消耗並刪除環境，process-local copy 保留 reload 身份，不傳給無關孫行程。工具選取、ready-query `--no-tools`、遞迴 exclusions 與宿主取消仍有效。

直接 execute 的任何 own／inherited `background` 欄位（含 false／undefined／null）均在 execution/effective settings、backend／spawn 前拒絕；仍保留既有 opt-in failure diagnostics I/O，不代表零檔案 I/O。同 process guard 僅重驗同一已消耗 handshake object 的合法 lease；初次須 `wx` exclusive 寫入、成功 close 及只讀驗證，新 object 即使 payload 相同也不得接管。Reload 核對配置／trust、regular／非 symlink、bigint dev／ino／size、raw Buffer equals 及讀前後 descriptor／path mtimeNs／ctimeNs；不覆寫變造／外來 receipt、不重建 missing，拒絕直接 exit 1。這是離散檢查點，不是 atomic snapshot、filesystem lock、永久不可修改或 read-allocation hard cap；不是跨 process recovery／OS sandbox，不能阻止 shell 自建背景行程。詳見兩模組 README。

Bundled reviewer 使用唯讀 bash 與 `note`，不提供 write/edit；完整審查僅以 `note({type:"report",content})` 新增，自動命名後回一句結論與實際路徑；note 失敗須報 blocked，不改用 shell 寫報告。自訂同名 reviewer 仍按既有優先序覆蓋，這是操作契約而非 sandbox。

### 背景委派與結果回送

Shell／Subagents 每回合注入共享 system prompt 規則：通知順序不等於完成順序，log／partial 結論只是暫定結果，整個工作通過需 terminal status／退出證據。已取得足夠結論且不再需要的 owned 工作須用已選取的 cancel 工具停止並核對收尾，不放著跑只為等通知；仍必要的測試／寫入／checkpoint／cleanup 不提前中斷。取消不等於程序樹已停止，取消的驗證不算完整通過。提示去重、隨相關工具選取存在，不自動啟用管理工具，也不從任意輸出文字自動 kill。完整規則見兩模組 README。

```json
{ "command": "npm test", "background": true }
```

```json
{ "agent": "scout", "task": "查找相關模組並回報，勿修改檔案。", "background": true }
```

背景啟動受理後回傳 job receipt，主 agent 可繼續其他任務；shell 提供 `liveLogPath`。Subagent 背景建立先配置各 task 的 managed session 並回傳 `subagentSessionId`；取得 active permit、建立 log 後才提供 `.partial` 路徑（排隊／chain 未啟動者仍標 `logPending`，不預報尚不存在的 log）。用現有 `read` 查閱完成的對話紀錄，不是逐 token 串流；完成後通知提供最終 `logPath`。`read` 遇到符合 managed run 規則的缺失 `.partial`，只提示改讀同目錄 final／等待通知，不自動切換檔案或判定完成。改讀 conversation aggregate 時不可沿用 run-local 行數。

完成／失敗／取消以 model-visible custom message + `triggerTurn:true, deliverAs:"followUp"` 請求原 session 接續，輸出視為不可信資料，不提升為 system 指令。Subagent 結論摘要取當次 invocation 最後有效 terminal assistant 的首個非空行，在 aggregate 截短前有界保留；新工作／retry start 清除舊候選，成功 retry end 不清除已恢復的結論。空 terminal 明示無 final 文字，失敗／取消以權威診斷為準；完整輸出、日誌與 chain 資料不變。通知內部只保存最多128筆不含 payload 的觀測；callback 返回不等於宿主佇列／持久化／送達確認，沒有自動重送。已知 canMessage／cancelRequested 的 false 與未知值分開呈現。離開 Pi、reload 或替換 session 時取消背景工作並抑制舊通知；沒有 daemon／重啟恢復。SDK 必須 `await runtime.dispose()`，直接 `session.dispose()` 不觸發 extension shutdown。取消是 best-effort，並非整棵 process tree 已停止。

`subagent_message` 指定完整 `subagentSessionId` 與 `message`，`mode` 預設 `control`。系統依當前 registry／ownership／checkpoint 判斷：可互動 running invocation 使用 control，在 assistant／tools 邊界加入主線 user input、不打斷目前工具；安全 ready session 使用非同步 resume，保留 session ID 並產生新 jobId／taskId。queued／startup／finalizing／取消收尾或 busy 明確拒絕，不排跨 invocation 佇列；blocked／checkpoint 不符不能自動重建。回覆 `action` 表示實際路徑，accepted 只表示受理；control queued 不等於 applied，delivery_unknown 不可盲目重送或改用 resume。`mode:"query"` 支援互動中 child 與已結束的 ready session：live 使用安全 canonical prefix；ready 驗證 owner/config/trust/checkpoint 後持有獨占讀取租約，以 guarded 暫存副本執行 tool-free 一次性問答。不對原對話 prompt／steer、不改原 manifest/native/transcript/checkpoint；ready query 有獨立 jobId/taskId 供 status/cancel，結果只發 query_result，不冒充主任務重新完成。snapshot 尊重原生 compaction/context edit，可能落後長工具，另計模型用量。完成回饋透過 followUp；背景續接與 query 用量**不自動加到 Pi session totals**。

Subagents 的 `subagent_background` 通知、status／cancel／message 與背景派發 receipt 也使用摘要／展開 TUI：收合顯示工作狀態、agent 與結論，展開看 IDs、原有 log／session 與保留結果／用量。新的 log_ready 只送模型事件、不新增聊天 bubble，執行狀態更新 footer／已展開面板；歷史 log_ready 仍可顯示通知時快照，finalLogPath 是未來路徑，不宣稱目前存在；取消要求不等於程序樹停止，control accepted／queued 不等於 applied；query 顯示快照、未知用量與尚待清理，晚到用量不復活答案。同步 subagent 的既有進度與 Markdown 呈現保留。

Shell、Subagent 背景通知與 Schedule Prompt 結果使用與原生工具呼叫相同的背景色塊（不畫框線，含內距；窄終端自動縮減），總300行包含上下留白。背景沿用主題 toolSuccessBg／toolErrorBg／toolPendingBg，僅確認完成才採成功色。Subagents 管理工具與同步結果保留原生工具區塊，不重複套色塊。原生展開可查看通知內保留的詳細結果；顯示層清除 ANSI／控制碼，Shell 以狀態／exit code 判定，Schedule 區分完成、失敗、略過與僅送達。模型內容與工作 lifecycle 不變，重新 `/reload` 才會載入。

透過原生 `setStatus()` 在 footer 狀態列顯示 `▸ Subagents：3 ｜ ▸ Shell：2`，與 Fast 等其他 extension 狀態共存，由宿主按 key 排序與截短。預設不掛 widget、不顯示命令／標題。Footer 摘要本身不可點擊；使用 `/background-jobs subagents`、`/background-jobs shell`，或 `/background-jobs` 切換全部、`/background-jobs collapse` 全收合。Subagents 數量是未終結 queued／running tasks，Shell 含 running／cancelling；finalizing batch 不偽裝成 child，摘要可為0但仍可展開。展開時才在輸入框下方、footer 上方（belowEditor）掛詳細 widget，各區最多八列及省略數；全螢幕可點擊已展開 widget 的標籤各別切換，不搶 editor focus。完成逐項移除，所有工作終結時清除自有 footer 狀態與 widget；窄欄縮寫 S／Sh，極窄依欄寬截短，無法完整顯示的標籤不接點擊。事件更新、不讀 log、不輪詢、不搶輸入焦點、不替換 footer、不列前景或其他 session。不啟用未選工具、RPC／JSON／print 不掛 widget；取消要求或移除面板不表示外部行程已停止。等待現有背景工作結束後 `/reload` 載入。

使用 explicit `--tools` 時要加入需要的五個管理／互動工具；shell 管理工具預設 inactive，須額外選取，extension 不改你的 loadout／settings。完整 receipt、資源上限與互動語意見 [Subagents](modules/subagents/README.md)、[Shell Tools](modules/shell-tools/README.md) 與 [設定](docs/configuration.md#background-execution-and-interaction)。新能力以 Pi 1.0.0 離線 host 驗證；真實 provider 尚未驗證。

Subagent／Shell 工具訊息使用英文，保留 status／schema／信任邊界。Control accepted／queued 明說等待納入對話，applied 不表示要求的工作完成；query completed 不表示主工作完成。Shell cancelled 即使有非零 exit code 也不改称 failed，背景 receipt 用 `Accepted in` 區別接受耗時，截短通知不推論日誌必定不完整。`(timeout 20s)` 保留；`background:true` 不停用輸出停滯計時器。完整訊息與狀態說明見兩模組 README。

Subagent RPC 啟動失敗會保留原錯誤码，另附英文階段／checkpoint、相對耗時、stdin write／匹配回覆、guard 里程碑與 child 版本觀察；失敗當下與清理後退出分開呈現。沒有觀察到的原因維持 unknown，不猜測 extension 卡住；30秒期限、重試政策、schema／trust／ownership 不變，無新增設定。完整判讀見 [Subagents](modules/subagents/README.md#rpc-啟動失敗診斷) 與 [設定](docs/configuration.md#subagent-rpc-startup-diagnostics)。

### 跨平台 PTY

`pty_spawn` 新增選填 `target`，未提供時仍在本機執行。named targets 設於 Pi settings 的 `pi-pty-terminal.targets`，例如 Linux 使用 `transport: "wsl"`、macOS 使用 `transport: "ssh"`；完整範例見 [PTY README](modules/pty-terminal/README.md) 與 [設定](docs/configuration.md#pty-targets)。

```json
{ "target": "macos", "command": "zsh", "args": ["-l"] }
```

後續操作只需 `sessionId`。遠端 cwd/env 是目標環境的值，不沿用 Windows 路徑。SSH 使用既有 host alias／金鑰／agent 與 known_hosts，不儲存密碼、不停用 host key 驗證；GitHub 同步需明確操作，不在連線時自動 pull。local PTY 可在 Windows/macOS/Linux 使用；WSL transport 僅限 Windows。實際遠端連線需另外驗證。

#### macOS SSH 登入與密碼

**不要把 Mac 帳號密碼、SSH 私鑰或金鑰密語貼到對話、寫進 Pi settings 或提交到 repository。** 目前 SSH target 使用 `BatchMode=yes`，不支援互動輸入帳號密碼；請使用 SSH 金鑰與既有 `ssh-agent`。

1. 在 Windows 的終端機執行 `ssh-keygen -t ed25519` 建立金鑰；若已有適用金鑰可沿用，不要覆寫。建議設定金鑰密語。
2. 在 Mac 開啟「系統設定 → 一般 → 共享 → 遠端登入」，只允許需要登入的使用者。
3. 將 Windows 的**公鑰**（例如 `%USERPROFILE%\.ssh\id_ed25519.pub`）內容加入 Mac 使用者的 `~/.ssh/authorized_keys`；不是沒有 `.pub` 副檔名的私鑰。Mac 上 `~/.ssh` 權限設為 `700`，`authorized_keys` 設為 `600`。可在 Mac 本機操作；若需用帳號密碼初次 SSH 登入，請由你在自己的終端機手動輸入，不經過模型或工具。
4. 在 Windows 的 `%USERPROFILE%\.ssh\config` 設定 host alias，例如以下範例；請替換使用者與位址：

   ```sshconfig
   Host macos
       HostName 192.168.1.100
       User your-mac-user
       IdentityFile ~/.ssh/id_ed25519
       IdentitiesOnly yes
   ```

5. 在自己的終端機執行 `ssh macos`，先透過可信管道核對 Mac 的 host key 指紋，再接受並保存至 `known_hosts`；不要停用 host-key verification。若金鑰有密語，先啟用 Windows OpenSSH Authentication Agent，再自行執行 `ssh-add "$env:USERPROFILE\.ssh\id_ed25519"`（PowerShell）輸入密語。
6. 執行 `ssh -o BatchMode=yes macos` 確認無需互動即可登入；成功後依 [PTY README](modules/pty-terminal/README.md) 設定 `transport: "ssh"`、`host: "macos"` 與 Mac 上的絕對 `cwd`。

需要協助實際連線時，只需提供 **SSH host alias** 與 **Mac 上的專案絕對路徑**，並明確授權實連；不需要提供密碼。若一定要使用帳號密碼，需另行實作讓使用者直接在終端機輸入、不經過模型的互動登入介面；目前 extension 未提供此功能。

### Monitor v1

入口 `modules/monitor/src/index.ts`，三工具預設 inactive；managed child 完全不註冊並拒絕直接 execute。`monitor_start` 支援 command stdout、WebSocket text、既有 Shell/Subagent readonly job snapshots；`monitor_status`／`monitor_stop` 只操作本 session/canonical cwd/generation。總期限預設5分鐘、上限30分鐘（不是Shell輸出停滯timeout）；4 active、32 retained、固定 byte/rate/buffer bounds。WS預設公網wss，private與ws需本URL分別opt-in；驗證後DNS pin、TLS/SNI、禁redirect/compression、16KiB preallocation cap；root direct `ws@8.22.0`。Job停止只清timer，不取消原工作／query模型；command stderr僅診斷、stdin ignored。Legacy WSL stdin transport拒絕，不偷偷換shell。

`wakeAgent` 預設true；false仍提交display custom `monitor_event`但不要求turn。Busy由agent_start/agent_settled維持，ordered data／bounded batches，submitted不代表host ack／persisted；cancel/exit不代表source close／descendants cleanup，reload不恢復或重播。完整schema／limits／Blackhole producer交接與驗證邊界見 [Monitor README](modules/monitor/README.md)。Blackhole allowlist接線另由父agent協調，未因此宣稱壓縮共存已通過。

### 新增分類筆記

```json
{ "type": "report", "content": "# Report\n\nVerification results…\n" }
```

`type` 限定 `plan | issue | research | report | task`，寫入呼叫時工作目錄下的 `./<type>/<TYPE>-<UTC timestamp>.md`，採緊湊 UTC 格式 `YYYYMMDDTHHmmssSSSZ`，例如 `./report/REPORT-20261001T043000123Z.md`；保留毫秒與時間排序，既有筆記不更名。目錄不存在會自動建立；內容以 UTF-8 原樣保存，同名檔案會換名、不覆寫。文字結果、details 與 structuredContent 均只回報相對路徑（`relativePath`），不暴露絕對路徑；後續直接使用 `read`／`edit`／`write` 操作。

獨立入口：`modules/note-tools/src/index.ts`。若使用 `--tools` 明確 allowlist，請加入 `note` 才能啟用；exclusions／no-tools 仍優先。`defaultTools` 不是 extension tools 的全域 allowlist。完整契約見 [Note Tools README](modules/note-tools/README.md)。

### Schedule Prompt

入口：`modules/schedule-prompt/src/index.ts`（來源 [tintinweb/pi-schedule-prompt](https://github.com/tintinweb/pi-schedule-prompt) 0.4.1，MIT，保留原 LICENSE；非使用者擁有的來源）。若使用 `--tools` 明確 allowlist，請加入 `schedule_prompt` 才能啟用；exclusions／no-tools 仍優先。指令與儲存路徑沿用來源，另有本地 `endAt` 截止擴充，完整說明見 [Schedule Prompt README](modules/schedule-prompt/README.md)。

- Pi 1.0.0 適配：in-process subagent 改傳 `modelRuntime`（取代已移除的 `modelRegistry` 選項），其餘行為不變。
- 帶 `model` 的 job 以 `createAgentSession` 在行程內執行，**不經** Subagents 模組的 argument builder／`--exclude-tools subagent` 保障；預設 `noExtensions`、僅內建工具，`extensions: true` 才載入其他 extensions。這不是 OS sandbox，取消只呼叫 `session.abort()`，不代表底層 process tree 已停止。
- 排程在 `session_start` 啟動、`session_shutdown` 停止；Pi 關閉後不會觸發，沒有補跑。排定觸發的 job 可能呼叫模型並產生費用，請自行確認 prompt 與 model。
- 本地擴充 `endAt`：含秒與時區的 ISO 截止時間（如 `2030-01-01T18:00:00+08:00`，請改成預期未來時間），到達後拒絕新觸發並自動停用；不是強制結束已啟動工作。`update` 省略欄位保留原截止、`endAt: null` 清除，過期工作須先延長／清除再明確 `enable`。舊資料未設截止者不變；舊版或新舊混跑不保證截止生效。測試分組 `npm run test:module -- schedule-prompt` 包含專屬離線 Pi 1.1.0 host probe。

### Blackhole 壓縮與最後回答顯示

本地入口 `modules/blackhole/src/index.ts` 轉接 0.5.12 原 factory，保留 `/blackhole`、`recall`、記憶與原生 compaction 流程。修正 `getBranch()` 掃描方向：Pi 回傳 oldest-first，現在從成功的 compaction entry 往較舊訊息掃描。`showPreCompactionMessage: true` 時，最新被省略且未 aborted 的 assistant 文字會保存為 `[Previous output — display only]` 副本（最多 16 KiB），resume 可讀回並顯示；不增加模型訊息，不改 tail 保留界線。

現行 Blackhole **只替換 Pi 已啟動的原生摘要**：Pi 控制 threshold／reserve、auto／manual／overflow 時點、preparation、cut／tokensBefore、persist／rebuild、retry／cancel；允許 Pi 在 final 後原生 threshold 壓縮及 callback replay，不修改 Pi。舊 `midRunCompaction`／`tailBehavior: "minimal"`／BH threshold 自選 timing/cut 描述只屬歷史，不能控制現行保留邊界。已被 Pi native tail 保留的最新 final 不新建 display 副本；只有真的被切掉的最新 assistant 文字可保存 plain custom，零模型投影。歷史 raw entries 不刪除，但 resume 不是完整歷史視圖，也不回填舊缺失副本。設定／採用與 filters 見 [configuration](docs/configuration.md) 和 [migration](docs/migration.md)。根 `npm run test:module -- blackhole` 沿用 Vitest 與離線 Pi 1.1.0 exact native preparation/cut、兩種 retained/dropped final、persist／resume／renderer probes；不是付費模型或人工 TUI 驗證。新 Pi-owned source仍需獨立review與父agent固定source根驗收，不能以fixture green宣稱已採用／release。

### Blackhole 通知 evidence 與穩定引用

`recall`／`/blackhole-recall` 新增 allowlisted persisted `custom_message` 消費端：Shell 完成批次、Subagent task/query 結果、Runtime 診斷、Schedule subagent 結果與背景 reconciliation。以 ID 搜尋後使用 `e:<persisted-entry-id>`／`page`；stable ID namespace 不重編舊 message-only `#N`。排除 plain custom、display-only 副本、start/inline markers、private query 欄位與 credentials；details 的 producer-specific 結構為權威，正文僅補公開 scalar display，不提升為指令或 goal/preference。Query 的 lateUsage／snapshotUnavailable（含 false）保留，但不復活失敗答案。

新 summary 最多16 refs／8000 structural chars，carry／strip 必須驗證實際 insertion span、SHA-256／refs 的 optional `blackhole.notificationEvidence` provenance；不是相信 Markdown header，也不是身份簽章。無 metadata 的舊 compactions 不回填／改寫；壓縮時機、tail、設定與舊 ref 不變。Evidence 專用 scanner 在 parse 前限64 KiB line，另限32 MiB讀取／100000 lines；不涵蓋舊 generic raw scanner 或宿主已解析的 branch。Selected projection、summary 樣本與 raw history 完整程度不同，producer outputTruncated 與 projection partial 也不同。分頁只推進已交付 body；tiny budget 不足回 `isError`／結構診斷、零交付且無 cursor，最小文字可能僅 `!`；`0` 只解除文字 budget，不解除 projection/scanner 界限。Unavailable 僅表示 selected inspection 未取得，不能推全歷史 absence／outcome。詳見 [Blackhole recall](modules/blackhole/docs/recall.md)。

離線 fixtures 驗證持久化消費端，不代表 producer lifecycle／exactly-once／process-tree cleanup、真實 provider、人工 TUI 或根 release gates 已通過；不讀 logs、不重播或重啟 outcome_unknown 舊工作。

### 有限次 API 錯誤恢復

原生入口 `modules/pi-runtime/src/index.ts` 預設啟用。明確 argument／tool JSON 錯誤會在最終可操作 boundary 加入模型可見診斷，最多 2 次，同診斷再出現就暫停；network／context／auth／billing 沿用宿主，不疊加重試。一般 `invalid_request_error` 不足以觸發自動恢復。

Cyber／policy 及未知錯誤保留待 review 診斷，使用 `/runtime-recover <合法用途與授權範圍澄清>` 並在 idle 真正 TUI 明確確認後，才提交一次診斷 continuation；RPC／JSON／print 即使提供 dialog method 仍拒絕，不推定同意；**不是自動反覆改寫以避開 safeguard**，也不保證 provider 會讓模型收到下一次請求。`/runtime-recovery off` 可停用，`on` 不補額度。額度在 session 中先保留，tree／reload 不回補；`--no-session` 不支援。此機制可能增加模型費用，不改個人 settings/auth，不重播工具副作用。新任務以 idle input／preflight／agent_start 與實際 admitted user-object 的一次性phase證據識別（含transform/template），不是raw prompt文字匹配。完整限制與驗證見 [Pi Runtime README](modules/pi-runtime/README.md)；目前六檔baseline取得limited static acceptance（復審未重跑測試），14-mode為worker既有離線證據；根release gates／retry／Blackhole／overflow共存仍未驗收，不以單模組green宣稱根交付通過。

### GPT 速度切換

`/fast` 設定 Fast（`service_tier: "priority"`），`/ultrafast` 設定 Ultrafast（`service_tier: "ultrafast"`），`/normal` 關閉本 extension 的 tier 注入。指令不是 toggle。只對 `openai`／`openai-codex` provider 且完整 ID 符合 `gpt-<major>[.<minor>]-<luna|terra|sol|astra>`、版本 >= 5.6 的模型生效；`5.10` 與 `6` 皆符合。Ultrafast 遇到 luna／terra 的實際速度降為 Fast，換回 sol／astra 恢復 Ultrafast；其他模型請求保持原樣。

TUI footer 顯示 Normal／Fast／Ultrafast，並標註降級或 inactive。預設 Normal；命令保存全域 `pi-gpt-speed.mode`，受信任專案設定可在下次載入時覆蓋。入口與完整契約見 [GPT Speed README](modules/gpt-speed/README.md)。若已裝 pi-codex-fast 或其他速度 extension，請先停用以避免衝突。模型 pattern 是本地政策，不保證後端權限或支援。

### Structured JSON 交付

```powershell
$schema = '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}'
pi -p "Extract company name: Acme" --json-schema $schema                       # stdout：整個 stdout 是一行 JSON
pi -p "Extract company name: Acme" --json-schema $schema --json-output result.json   # 寫入檔案
```

只有兩個旗標：`--json-schema`（根必須是 `type: "object"`）與 `--json-output`（有給＝寫入檔案，沒給＝輸出到 stdout）。stdout 模式僅 print 模式、每次執行一個 prompt；成功輸出一份 compact JSON + newline，診斷與錯誤走 stderr（前綴 `pi-json-schema:`），失敗時 exit code 為 1 且不交付內容。模型沒呼叫 `json_output` 時固定採 best-effort：先解析最後一則助理訊息，再最多一次額外模型抽取。不是 `--mode json` 的 JSONL 事件串流，也不是 provider-native response_format。明確工具 allowlist 要加入 `json_output`；排除或 no-tools 時不做抽取呼叫。

驗證使用 zod 4；zod 無法忠實驗證的 schema 關鍵字（`if/then/else`、`not`、`dependent*`、外部 `$ref` 等）會在啟動時被拒絕，完整範圍見 [JSON Schema README](modules/json-schema/README.md)。入口為 `modules/json-schema/src/index.ts`。

### 穩定性防護（本地修正）

- Schedule store 只有 ENOENT 才視為空；讀取或損壞隔離失敗拒絕修改，不覆蓋既有資料。持久化清理故障不跳過 scheduler/widget teardown，cron 驗證不建立 timer。
- PTY `waitFor` 用可終止 worker（單次最多1秒、最多16個）；完整 escape 序列超過單次50KiB限制時明示丟棄並推進 cursor。Shutdown 確認 transport exit 才釋放 ownership，失敗保留並回報，不虛構退出。
- JSON Schema 拒絕會漏驗的 enum/const 同層約束與型別衝突；pattern 限保守線性子集以保護 Pi 同步工具驗證，含 pattern 的本地驗證另用可終止且可重用的 worker pool（計算預算2秒、最多4個 worker，最多256筆等待；取消或故障的 worker 確認終止才釋放名額）。這會拒絕部分先前接受的 schema，詳見模組 README。
- Web HTML 擷取移到可終止 worker，避免 JSDOM 同步解析阻塞 TUI／abort；不下載 image／stylesheet 等不必要資源。URL/DNS 檢查仍未釘住實際連線 IP，無法根治 DNS rebinding；有敏感內網的環境需另以網路出口政策隔離，不得把 Fetch 當 SSRF sandbox。
- Subagents 暫存 prompt/task I/O 與清理套用取消／期限；已開始的 OS I/O 不保證可中斷，晚到操作自行清理，不在取消後啟動 child。晚到 query terminal/close 更新 retained cleanup 狀態，不復活答案或重複用量。

以上不改 trust、工具 activation、儲存位置或 provider credentials，也不提供 OS sandbox、exactly-once 或強制取消遠端工作。Schedule mutation 與損毀隔離都必須取得鎖；遇到 contention 立即拒絕，不按鎖齡接管、不無鎖寫入。Crash 遺留鎖須確認沒有 writer 後手動移除；inline follow-up 排隊語意仍保留。

## 選擇載入模組

使用 `pi config`，或在 Pi settings 的 package entry 使用原生 filters，例如只載入檔案與 shell：

```json
{
  "packages": [{
    "source": "D:/projects/pi-better-tools",
    "extensions": [
      "modules/shell-tools/src/index.ts",
      "modules/file-tools/src/index.ts"
    ],
    "prompts": []
  }]
}
```

十二個模組（subagents、shell-tools、file-tools、web-tools、note-tools、gpt-speed、json-schema、pty-terminal、schedule-prompt、blackhole、pi-runtime、monitor）的公開入口均為 `modules/<name>/src/index.ts`。薄入口轉接既有實作，內部資源位置不變。

Filters 以整合包 root 為基準；與 tool allowlist 不同，它們控制 extension 是否執行／是否啟動生命週期資源。既有 filters 若使用舊入口路徑，請手動更新為新路徑，見 [入口遷移](docs/migration.md#unified-typescript-entry-points)。

## 設定與限制

第一版保留所有既有設定鍵／儲存位置，沒有新增統一設定遷移層。[docs/configuration.md](docs/configuration.md) 列出 Web 搜尋、五組 debugLog、agentDir 差異與資料隱私。

- 安裝路徑改變可能使舊 managed Subagent sessions 無法續接；不自動改寫 fingerprint／來源路徑。
- `pi -e` 的 parent 臨時 extensions 不自動傳給 child；需要 child 可探索到的全域或受信任專案設定。
- 取消是要求，不保證所有任意 descendants 或既有副作用消失。
- 不會自動清除舊 logs、已移除 Scheduler 模組遺留的資料（`<agentDir>/pi-scheduler/`、`~/.pi/logs/pi-scheduler/`）、修改 auth 或移除舊 OS tasks。

## 開發與驗證

```powershell
npm run build
npm run typecheck
npm test
npm run test:integration
npm run test:browser      # 真實 Chromium；Linux 首次可用 setup:browser 安裝瀏覽器與系統依賴
npm run test:package      # 真實 tarball + 乾淨 production install；需要 npm registry
npm run sources:verify    # 匯入來源／本地適配雜湊
npm pack                 # prepack 會執行 build（目前為 no-op）
```

跨平台測試：Subagent transcript 位置以 `realpath` 驗證（包括 macOS `/var`／`/private/var` alias）；依遠端已授權的測試精簡移除大型 shell／stress probes，不宣稱仍有該項覆蓋。Web debug-log 解析明確的 Windows 絕對磁碟／UNC 路徑，其餘依宿主 cwd basename 正規化，保留 POSIX 檔名中的反斜線語意。Windows-only 平台測試仍另行標示 skip，不能算通過。

所有長時間腳本定期輸出英文進度；測試不用真實憑證／付費模型。`test:package` 是封裝／runtime smoke，不等同全部 source regression。Skip 不算通過；人工 fullscreen TUI／真實 provider 不在離線驗證範圍。更多結構見 [docs/architecture.md](docs/architecture.md)。
