# Pi Better Tools

單一 Pi extensions package，整合 Subagents、Shell Tools、Precise File Tools、Web Tools、Scheduler 與 PTY Terminal，加上 JSON Schema structured delivery，並提供本專案原生 Note Tools、GPT Speed 與 Goal extensions。必要程式碼與資源已納入 `modules/`，不依賴來源專案的本機路徑。

> 本專案採用 [MIT License](LICENSE)。使用者已確認五個來源專案均為其所有，並授權本整合專案採 MIT；封裝測試以根目錄 `LICENSE` 為必要授權檔，不要求重複模組 LICENSE；原有模組授權聲明仍保留，來源與相依套件說明見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。`private: true` 僅用於避免誤發布 npm，不限制未來公開至 GitHub；目前未執行任何遠端發布。

## 本機安裝

需要 Node.js **`^22.22.2 || ^24.15.0 || >=26.0.0`**（與 jsdom 30 的 runtime 需求一致） 與 `@earendil-works/*` namespace 的 Pi。開發基準固定 Pi **1.0.0**；production smoke matrix 涵蓋 **0.99.1／0.99.2／1.0.0**，不代表所有 Pi 版本皆相容。

```powershell
cd D:\projects\pi-better-tools
npm ci --ignore-scripts
npm run pty:install       # 明確執行 node-pty native setup；無 prebuild 時需編譯工具
npm run build             # 僅獨立 pi-scheduler CLI 需要編譯；Pi extensions 直接載入 TS
npm run browser:install   # 若需要 web_fetch 的 Chromium
pi install D:/projects/pi-better-tools
```

只在目前使用中的專案安裝：`pi install -l D:/projects/pi-better-tools`。先試用、不改設定：`pi --no-extensions -e D:/projects/pi-better-tools`。所有 Pi extensions 都直接載入 `modules/<name>/src/index.ts`；修改本機程式碼後 `/reload` 或重新啟動 Pi 即可，不必先 build。只有使用獨立 `pi-scheduler` CLI 時才需重新 `npm run build`。

**若原五個 packages 或獨立 `pi-pty-terminal` 已啟用，請先停用其 extensions**，避免與整合包重複註冊相同工具。這些設定不會自動修改。完整步驟與回退見 [docs/migration.md](docs/migration.md)。

Pi-managed npm／git package 安裝會處理 runtime dependencies；本機路徑不會自動替你執行 npm install。Chromium 不在 tarball 裡，extension 載入時也不下載／啟動瀏覽器。解壓 tarball 後可在安裝目錄執行 `npm run browser:install`；勿在 runtime-only tarball 執行 repository 的 build／test scripts。

### macOS 安裝（Apple Silicon／Intel）

請先安裝符合上述版本要求的 Node.js 與 `@earendil-works/pi-coding-agent`，並以 `command -v node npm pi` 確認命令位置。Apple Silicon 建議使用原生 ARM64 Node.js，避免混用 Rosetta／Intel 與 ARM64 安裝；可用 `node -p 'process.platform + " " + process.arch'` 確認目前 Node.js 的平台／架構。

```bash
cd ~/GitHub/pi-better-tools    # 改成實際 checkout 路徑
npm ci --ignore-scripts
npm run pty:install       # 明確執行 node-pty native setup；無 prebuild 時需編譯工具
npm run build                 # 僅獨立 pi-scheduler CLI 需要
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
npm run build                 # 僅獨立 pi-scheduler CLI 需要
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

## 功能

| 模組 | 工具／命令 | 注意事項 |
| --- | --- | --- |
| Subagents | `subagent`；`/implement`、`/scout-and-plan`、`/implement-and-review` | 四個內建 agents；single／parallel／chain 全自動保存，ready 後用 resume 續接；child 排除遞迴 subagent |
| PTY Terminal | `pty_spawn/write/read/resize/wait_exit/kill/list` | `target` 預設 local；named WSL／SSH targets；session 綁定 target，關閉 transport 不保證遠端背景程序停止 |
| Shell Tools | 覆寫 `bash`、`powershell` | `timeoutMs` 為毫秒 inactivity timeout；不自動啟用未選的 shell；PowerShell backend 僅原生 Windows |
| File Tools | 覆寫 `read`、`write`、`edit` | 絕對行號、32 字元 hash、精準 literal／regex、原子寫入、diff worker |
| Web Tools | `web_fetch`；條件式 REST `web_search`；`/web-tools status`、`/web-tools sources` | OpenAI 原生模式不註冊同名 function tool；Brave／Exa 要明確設定；無登入／CAPTCHA bypass／PDF |
| Scheduler | `schedule_create/update/status/cancel`；`/schedule` | Pi 開啟時運行，不安裝 OS service、不補跑錯過時間；runner CLI 保留相容用途 |
| Note Tools | `note` | `{ type, content }`；自動分類、產生時間戳檔名，只新增 Markdown 檔案並回報路徑，不覆寫 |
| GPT Speed | `/fast`、`/ultrafast`、`/normal` | GPT >= 5.6 的 luna／terra／sol／astra pattern；Ultrafast 在 luna／terra 降為 Fast；TUI 顯示實際速度 |
| Goal | `/goal`；`goal get/complete/blocked` | 原文驗收目標持續推動，與 plan 分離；明確 pause／resume／clear；有界續跑、保守恢復 |
| JSON Schema | 條件式 `json_output`；`--json-schema`、`--json-output` | CLI schema + zod 4 驗證；有 `--json-output` 寫檔、否則單一 JSON stdout；未給 `--json-schema` 時 inactive |

Subagents **只保留 managed／可續接持久化**：首次呼叫照常提供 agent/task 或 tasks/chain，成功會回傳 `subagentSessionId`；後續只傳 `resume` 與新 `task`。已移除 `resumable` 開關，舊呼叫請省略它。所有新 sessions 存於 `<agentDir>/subagent-sessions/<ULID>/`；失敗／取消不會冒稱 ready，舊 ephemeral logs 不自動轉換。

工具 activation 仍由 Pi 的工具選取與 extension `defaultActive` 決定。`defaultTools` 不是全域 allowlist：部分 extension tools 會在註冊時啟用；需要嚴格唯讀請使用 `--tools read`，需要全部停用請用 `--no-tools`，排除工具用 `--exclude-tools`。整合包不增加另一層權限或 OS sandbox。

Pi **1.0.0** 預設 fullscreen TUI；本專案不自動修改 UI 設定，需要舊模式可自行用 `--tui-mode regular`。新版 `/reload` 會啟用新加入 `defaultTools` 的工具，但不會因刪除 defaults 而撤權；explicit tools／no-tools／exclusions 仍優先。

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

### 新增分類筆記

```json
{ "type": "report", "content": "# Report\n\nVerification results…\n" }
```

`type` 限定 `plan | issue | research | report | task`，寫入呼叫時工作目錄下的 `./<type>/<TYPE>-<UTC timestamp>.md`，例如 `./report/REPORT-2026-10-01T04-30-00-123Z.md`。目錄不存在會自動建立；內容以 UTF-8 原樣保存，同名檔案會換名、不覆寫。結果回傳絕對／相對路徑；後續直接使用 `read`／`edit`／`write` 操作。

獨立入口：`modules/note-tools/src/index.ts`。若使用 `--tools` 明確 allowlist，請加入 `note` 才能啟用；exclusions／no-tools 仍優先。`defaultTools` 不是 extension tools 的全域 allowlist。完整契約見 [Note Tools README](modules/note-tools/README.md)。

### GPT 速度切換

`/fast` 設定 Fast（`service_tier: "priority"`），`/ultrafast` 設定 Ultrafast（`service_tier: "ultrafast"`），`/normal` 關閉本 extension 的 tier 注入。指令不是 toggle。只對 `openai`／`openai-codex` provider 且完整 ID 符合 `gpt-<major>[.<minor>]-<luna|terra|sol|astra>`、版本 >= 5.6 的模型生效；`5.10` 與 `6` 皆符合。Ultrafast 遇到 luna／terra 的實際速度降為 Fast，換回 sol／astra 恢復 Ultrafast；其他模型請求保持原樣。

TUI footer 顯示 Normal／Fast／Ultrafast，並標註降級或 inactive。預設 Normal；命令保存全域 `pi-gpt-speed.mode`，受信任專案設定可在下次載入時覆蓋。入口與完整契約見 [GPT Speed README](modules/gpt-speed/README.md)。若已裝 pi-codex-fast 或其他速度 extension，請先停用以避免衝突。模型 pattern 是本地政策，不保證後端權限或支援。

### 驗收目標持續推動

```text
/goal 使用者能登入；錯誤密碼不得登入；既有功能不退化；相關測試實際通過。
/goal status
/goal pause
/goal resume
/goal clear
```

Goal 定義成功結果，不管理 plan／steps；沒有計畫也能開始、續跑並完成。當輪結束但尚未達標，主 agent 使用目前上下文與專案現況繼續；完成須透過 `goal complete` 保存驗收報告，不以「計畫已完成」或自然語言宣告改狀態。報告是模型提供的證據，非獨立 auditor。

明確工具清單要加入 `goal`；排除工具時不會自行啟用。每次 start／resume 至多 20 次自身續跑提案、3 次連續空自動回覆則暫停；不是 token／費用硬上限。Reload／恢復／branch change 的 active 先 paused，須明確 resume。Child markers 禁用 goal command／tool／自動接管。完整契約與儲存故障恢復見 [Goal README](modules/goal/README.md)。若已裝其他同名 Goal extension，請先停用。

### Structured JSON 交付

```powershell
$schema = '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}'
pi -p "Extract company name: Acme" --json-schema $schema                       # stdout：整個 stdout 是一行 JSON
pi -p "Extract company name: Acme" --json-schema $schema --json-output result.json   # 寫入檔案
```

只有兩個旗標：`--json-schema`（根必須是 `type: "object"`）與 `--json-output`（有給＝寫入檔案，沒給＝輸出到 stdout）。stdout 模式僅 print 模式、每次執行一個 prompt；成功輸出一份 compact JSON + newline，診斷與錯誤走 stderr（前綴 `pi-json-schema:`），失敗時 exit code 為 1 且不交付內容。模型沒呼叫 `json_output` 時固定採 best-effort：先解析最後一則助理訊息，再最多一次額外模型抽取。不是 `--mode json` 的 JSONL 事件串流，也不是 provider-native response_format。明確工具 allowlist 要加入 `json_output`；排除或 no-tools 時不做抽取呼叫。

驗證使用 zod 4；zod 無法忠實驗證的 schema 關鍵字（`if/then/else`、`not`、`dependent*`、外部 `$ref` 等）會在啟動時被拒絕，完整範圍見 [JSON Schema README](modules/json-schema/README.md)。入口為 `modules/json-schema/src/index.ts`。

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

十個模組（subagents、shell-tools、file-tools、web-tools、scheduler、note-tools、gpt-speed、goal、json-schema、pty-terminal）的公開入口均為 `modules/<name>/src/index.ts`。薄入口轉接既有實作，內部資源位置不變。

Filters 以整合包 root 為基準；與 tool allowlist 不同，它們控制 extension 是否執行／是否啟動生命週期資源。既有 filters 若使用舊入口路徑，請手動更新為新路徑，見 [入口遷移](docs/migration.md#unified-typescript-entry-points)。

## 設定與限制

第一版保留所有既有設定鍵／儲存位置，沒有新增統一設定遷移層。[docs/configuration.md](docs/configuration.md) 列出 Web 搜尋、五組 debugLog、agentDir 差異與資料隱私。

- 安裝路徑改變可能使舊 managed Subagent sessions 無法續接；不自動改寫 fingerprint／來源路徑。
- `pi -e` 的 parent 臨時 extensions 不自動傳給 child；需要 child 可探索到的全域或受信任專案設定。
- 一般 Subagent child 若載入 Scheduler，也可能參與原有 host／standby election；只有 Scheduler child marker 明確停用巢狀 host，第一版不擴張此政策。
- 取消是要求，不保證所有任意 descendants 或既有副作用消失。Scheduler claim 不是 exactly-once。
- 不會自動搬移排程、清除舊 logs、修改 auth 或移除舊 OS tasks。

## 開發與驗證

```powershell
npm run build
npm run typecheck
npm test
npm run test:integration
npm run test:browser      # 真實 Chromium；Linux 首次可用 setup:browser 安裝瀏覽器與系統依賴
npm run test:package      # 真實 tarball + 乾淨 production install；需要 npm registry
npm run test:matrix       # tarball smoke + Goal／SDK hooks／JSON delivery：Pi 0.99.1 / 0.99.2 / 1.0.0
npm run sources:verify    # 匯入來源／本地適配雜湊
npm pack                 # prepack 會重建 Scheduler
```

跨平台測試：Subagent transcript 位置以 `realpath` 驗證（包括 macOS `/var`／`/private/var` alias）；大型 shell 輸出在 Windows 使用 PowerShell、macOS／Linux 使用 Bash，實際產生超過 600 KiB，驗證完整輸出及精簡 transcript，不以 skip 代替。Web debug-log 解析明確的 Windows 絕對磁碟／UNC 路徑，其餘依宿主 cwd basename 正規化，保留 POSIX 檔名中的反斜線語意。Windows-only 平台測試仍另行標示 skip，不能算通過。

所有長時間腳本定期輸出英文進度；測試不用真實憑證／付費模型／生產排程。`test:matrix` 是封裝／runtime smoke，不等同各版的全部 source regression。Skip 不算通過；人工 fullscreen TUI／真實 provider 不在離線驗證範圍。更多結構見 [docs/architecture.md](docs/architecture.md)。
