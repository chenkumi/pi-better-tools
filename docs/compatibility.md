# 宿主相容性

本專案的開發基準是 Pi 1.3.0（見 `AGENTS.md`）。本文件只記錄在其他「執行同一份 Pi 1.3.0 原始碼」的宿主上實際量到的差異；沒有實測的項目一律列為未驗證，不視為相容。

## Pi-Bolt 0.9.6

[Pi-Bolt](https://github.com/opensec-git/Pi-Bolt) 是把 Pi 1.3.0 編譯成單一執行檔的分支（Bun 1.4.3，預設 JIT 關閉）。Extension API 與 hook 事件與上游 1.3.0 相同，差異在執行環境。

- 實測環境：Windows 11 x64、Pi-Bolt 0.9.6（`pi-bolt --version` 為 `1.3.0 (Pi-Bolt 0.9.6, win32-x64, JIT off)`），2026-10-21。
- 實測方法：隔離的 `PI_CODING_AGENT_DIR`、`PI_OFFLINE=1`，用臨時 extension 在 `session_start` 內探測，不呼叫模型。探測腳本不在 repository 內。

### 已確認

| 項目 | 結果 |
|---|---|
| 十九個 `pi.extensions` 入口載入 | 全部載入（`pi-bolt doctor` 無載入失敗） |
| 本專案使用的 hook 事件 | 事件名稱與分派方法都存在於 Pi-Bolt 的 extension runner |
| Pi 套件 import | 本專案只 import `pi-coding-agent`、`pi-tui`、`pi-ai`（含 `/compat`）、`pi-agent-core`，皆在 Pi-Bolt 的虛擬模組清單內 |
| `node:sqlite`（建表、寫入、查詢） | 可用 |
| `node-pty`（ConPTY 執行 `cmd /c echo`） | 可用 |
| `new Worker(source, { eval: true })` | 可用 |
| FFF override | 預設（無 JIT）版本中 `@ff-labs/fff-bun` 載入會失敗，`@ff-labs/pi-fff` 退回 `fff-node`；本專案已安裝該套件 |

`doctor` 與探測只驗證「載入」與上列呼叫，不代表每個工具的完整行為都已在 Pi-Bolt 上測過。

### 已知差異

**Worker 的記憶體上限不生效。** 在 Pi-Bolt 中，`new Worker(..., { resourceLimits: { maxOldGenerationSizeMb } })` 沒有限制效果：實測設定 16 MB 上限，Worker 配置約 320 MB 陣列仍正常完成，沒有被終止。以下位置依賴這個上限，在 Pi-Bolt 上不能依賴它：

- File diff Worker（`modules/file-tools/src/diff-runner.ts`，`DIFF_WORKER_OLD_GENERATION_MB`）
- JSON Schema 驗證 Worker（`modules/json-schema/src/validation-pool.ts`，128 MB）
- Web 內容擷取 Worker（`modules/web-tools/src/fetch/extract.ts`）
- PTY 輸出比對 Worker（`modules/pty-terminal/src/matcher.ts`，64 MB）

只有堆積上限這一項確認失效。逾時、輸入大小限制與 Worker 終止在 Pi-Bolt 上的行為沒有另外測試；需要硬性記憶體保護時，請改用 Node 上的 Pi。

**Subagent／Fork 子行程。** Pi-Bolt 的 `process.execPath` 是 Pi 執行檔本身，不是 Node，不能執行 `cli.js`。`getPiInvocation` 現在偵測到編譯版 Bun 宿主（`process.argv[1]` 為 `/$bunfs/root/…` 或 `X:/~BUN/root/…`）時，直接以 `process.execPath` 啟動子行程，不再傳入套件 `cli.js`。修正前，子行程會把 `cli.js` 路徑當成第一則 prompt。`PI_SUBAGENTS_PI_CLI` 仍優先。Fork 共用同一個函式。見 `modules/subagents/README.md`。

### 未驗證

- 以真實模型執行 Subagent／Fork 的端到端流程（修正只由單元測試與呼叫形狀實測支持）。
- Web 真實瀏覽器 `fetch`（Playwright 在 Bun 下）、MSSQL 的 `msnodesqlv8`。
- `sqlite`／`pty`／`web`／`json-schema` 等工具在 Pi-Bolt 上的完整行為（只確認載入與上表呼叫）。
- 重型測試組（`test:heavy`、`test:heavy:blackhole`）未在 Pi-Bolt 上執行。
- Linux、macOS 版本與 JIT 版本（`PIBOLT_VARIANT=x64-jit`）。

### 營運備註

- 預設版本以直譯器執行執行期載入的 extension，載入較慢（實測 `sql-connector` 約 8.6 秒、`blackhole` 約 6.3 秒；首次啟動含 Defender 掃描與 jiti 快取建立）。可改用 JIT 版本或 `pi-bolt compile`；後者對本專案的大型模組是否可行未驗證。
- Pi-Bolt 的 Bun 轉譯快取在 `%USERPROFILE%\.bun\install\cache\@t@pi-bolt`。曾有防毒軟體把其中的快取檔（內容為 Azure Identity SDK 的 `AzurePowerShellCredential`，由 `sql-connector` 的依賴引入）誤判為惡意軟體；檔案內容為一般 SDK 程式碼，快取可刪除並會重建。
- Pi-Bolt 不讀取工作目錄的 `.env`，環境變數需在啟動它的 shell 設定。
