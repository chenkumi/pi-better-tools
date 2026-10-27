# 宿主相容性

本專案的開發基準是 Pi 1.4.0（見 `AGENTS.md`）。本文件只記錄在其他宿主上實際量到的差異；沒有實測的項目一律列為未驗證，不視為相容。

> 以下 Pi-Bolt 0.9.6 的結果是 2026-10-21 對 Pi 1.3.0 原始碼量得，早於本專案升級到 Pi 1.4.0。Pi-Bolt 尚未在 1.4.0 基準上重測；在重測前，下列「已確認」項目不視為 1.4.0 相容證據。

## Pi-Bolt 0.9.6

[Pi-Bolt](https://github.com/opensec-git/Pi-Bolt) 是把 Pi 1.3.0 編譯成單一執行檔的分支（Bun 1.4.3，預設 JIT 關閉）。Extension API 與 hook 事件與上游 1.3.0 相同，差異在執行環境。

- 實測環境：Windows 11 x64、Pi-Bolt 0.9.6（`pi-bolt --version` 為 `1.3.0 (Pi-Bolt 0.9.6, win32-x64, JIT off)`），2026-10-21。
- 實測方法：隔離的 `PI_CODING_AGENT_DIR`、`PI_OFFLINE=1`，用臨時 extension 在 `session_start` 內探測，不呼叫模型。FFF 另以臨時 extension 載入真實 `src/fff-override.mjs`、代為觸發 `session_start` 並直接執行其 `grep`／`find` 工具。探測腳本不在 repository 內。

### 已確認

| 項目 | 結果 |
|---|---|
| 二十個 `pi.extensions` 入口載入 | 全部載入（`pi-bolt doctor` 無載入失敗） |
| 本專案使用的 hook 事件 | 事件名稱與分派方法都存在於 Pi-Bolt 的 extension runner |
| Pi 套件 import | 本專案只 import `pi-coding-agent`、`pi-tui`、`pi-ai`（含 `/compat`）、`pi-agent-core`，皆在 Pi-Bolt 的虛擬模組清單內 |
| `node:sqlite`（建表、寫入、查詢） | 可用 |
| `node-pty`（ConPTY 執行 `cmd /c echo`） | 可用 |
| `new Worker(source, { eval: true })` | 可用 |
| FFF override | 預設（無 JIT）版本中 `@ff-labs/fff-bun` 載入會失敗，`@ff-labs/pi-fff` 退回 `fff-node`；本專案已安裝該套件。實測 `fff-mode` 解析為 `override`、工具名為 `grep`／`find`，且兩者對真實目錄回傳正確結果（見下方「FFF 在 Pi-Bolt 的行為」） |

`doctor` 與探測只驗證「載入」與上列呼叫，不代表每個工具的完整行為都已在 Pi-Bolt 上測過。

### 已知差異

**Worker 的記憶體上限不生效。** 在 Pi-Bolt 中，`new Worker(..., { resourceLimits: { maxOldGenerationSizeMb } })` 沒有限制效果：實測設定 16 MB 上限，Worker 配置約 320 MB 陣列仍正常完成，沒有被終止。以下位置依賴這個上限，在 Pi-Bolt 上不能依賴它：

- File diff Worker（`modules/file-tools/src/diff-runner.ts`，`DIFF_WORKER_OLD_GENERATION_MB`）
- JSON Schema 驗證 Worker（`modules/json-schema/src/validation-pool.ts`，128 MB）
- Web 內容擷取 Worker（`modules/web-tools/src/fetch/extract.ts`）
- PTY 輸出比對 Worker（`modules/pty-terminal/src/matcher.ts`，64 MB）

只有堆積上限這一項確認失效。逾時、輸入大小限制與 Worker 終止在 Pi-Bolt 上的行為沒有另外測試；需要硬性記憶體保護時，請改用 Node 上的 Pi。

**FFF 在 Pi-Bolt 的行為。** pi-fff 走 jiti 的模組解析，`@ff-labs/fff-bun` 因此命中 Pi-Bolt 的 `JIT_ONLY_PACKAGES` 擋板（`loader.ts`），import 失敗後退回 `@ff-labs/fff-node`（N-API）；實測 `find "**/*.ts"` 與 `grep "hello"` 都回傳正確結果。Pi-Bolt 的 FFF 偵測只看載入路徑（`settings-manager.ts` 的 `FFF_EXTENSION`），抓不到本專案的薄包裝 `modules/file-tools/src/fff-override.mjs`：Pi-Bolt 會把自己的 `grep`／`find` 留在預設工具清單，override 模式下被同名 extension tool 覆蓋（`agent-session.ts` 先內建後 extension 寫入），非 override 模式（例如 `pi-fff.json` 設 `tools-only`）下則是 Pi-Bolt 原生 `grep`／`find` 與 `ffgrep`／`fffind` 並存。

- **不要與 `opensec-pi-fff` 並存。** 它是同一上游 0.11.0 的 Bun 重打包（`ffi-rs` 後端），註冊同樣的 flag／command／`@`-mention provider，且使用同一組 `<agentDir>/fff/{frecency,history}` 資料庫；兩份 finder 同開一組 native DB、重複 command 會被改名（`fff-mode:2`）而不是報錯。Pi-Bolt 安裝器也無法辨識本專案已提供 FFF（`install.ps1` 只比對套件來源字串是否含 `pi-fff`），仍會提議安裝；同批的 `opensec-pi-subagents` 與本專案 Subagents 工具同名，同樣不要一起裝。
- **要改用它取得 ffi-rs 後端時**，以 packages 物件形式過濾掉本專案的入口（`docs/packages.md`）：`{ "source": "npm:pi-better-tools", "extensions": ["!modules/file-tools/src/fff-override.mjs"] }`，再 `pi-bolt install npm:opensec-pi-fff`，之後 `/fff-mode override` 加 `/reload`（它預設 `tools-and-ui`）。此流程未實測。
- **JIT 版**（`PIBOLT_VARIANT=x64-jit`）沒有該擋板，會改走 `@ff-labs/fff-bun`；未實測。`fff-node` 是三條路徑中最慢的（`opensec-pi-fff` README 自述 grep literal 22.80 ms 對 1.82 ms `ffi-rs`、1.06 ms `bun:ffi`，未複驗）。
- **不要用絕對路徑載入 FFF 內部模組**（例如直接 import `@ff-labs/pi-fff/src/sdk.ts`）：那會繞過 jiti 的虛擬模組對應、載到真正的 `fff-bun`，而 `FileFinder.create()` 拋出的 `bun:ffi requires the JIT` 不會觸發上游的 `fff-node` 回退（上游只在 import 失敗時回退）。
- override 模式會覆蓋 Pi-Bolt 原生的 in-process `grep`／`find`，FFF 初始化失敗時該 session 沒有可用搜尋；要保留內建後備請把 `<agentDir>/pi-fff.json` 設為 `{"mode": "tools-only"}`。

**Subagent／Fork 子行程。** Pi-Bolt 的 `process.execPath` 是 Pi 執行檔本身，不是 Node，不能執行 `cli.js`。`getPiInvocation` 現在偵測到編譯版 Bun 宿主（`process.argv[1]` 為 `/$bunfs/root/…` 或 `X:/~BUN/root/…`）時，直接以 `process.execPath` 啟動子行程，不再傳入套件 `cli.js`。修正前，子行程會把 `cli.js` 路徑當成第一則 prompt。`PI_SUBAGENTS_PI_CLI` 仍優先。Fork 共用同一個函式。見 `modules/subagents/README.md`。

### 未驗證

- 以真實模型執行 Subagent／Fork 的端到端流程（修正只由單元測試與呼叫形狀實測支持）。
- Web 真實瀏覽器 `fetch`（Playwright 在 Bun 下）、MSSQL 的 `msnodesqlv8`。
- `sqlite`／`pty`／`web`／`json-schema` 等工具在 Pi-Bolt 上的完整行為（只確認載入與上表呼叫）。
- 重型測試組（`test:heavy`、`test:heavy:blackhole`）未在 Pi-Bolt 上執行。
- Linux、macOS 版本與 JIT 版本（`PIBOLT_VARIANT=x64-jit`），含 JIT 版的 FFF `fff-bun` 後端。
- FFF 在真實 TUI session（含 `@` 自動完成、`/fff-*` 指令）與大 repo 的效能；上述 FFF 探測是代為觸發 `session_start` 後直接執行工具。
- 以 `opensec-pi-fff` 取代本專案 FFF 入口的流程（packages 過濾）。

### 營運備註

- 預設版本以直譯器執行執行期載入的 extension，載入較慢（實測 `sql-connector` 約 8.6 秒、`blackhole` 約 6.3 秒；首次啟動含 Defender 掃描與 jiti 快取建立）。可改用 JIT 版本或 `pi-bolt compile`；後者對本專案的大型模組是否可行未驗證。
- Pi-Bolt 的 Bun 轉譯快取在 `%USERPROFILE%\.bun\install\cache\@t@pi-bolt`。曾有防毒軟體把其中的快取檔（內容為 Azure Identity SDK 的 `AzurePowerShellCredential`，由 `sql-connector` 的依賴引入）誤判為惡意軟體；檔案內容為一般 SDK 程式碼，快取可刪除並會重建。
- Pi-Bolt 不讀取工作目錄的 `.env`，環境變數需在啟動它的 shell 設定。
