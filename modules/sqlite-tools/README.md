# SQLite Tools（整合版）

來源為使用者擁有的 `D:/projects/pi-sqlite-tools` 0.1.0；程式碼已納入本模組，不依賴來源路徑。入口為 `modules/sqlite-tools/src/index.ts`，使用 Node 內建 `node:sqlite`，無新增 runtime dependencies。安裝、Pi 1.2.0／Node 基準及唯一 lockfile 以根專案為準。來源雜湊與本地適配見 `docs/sources.json`、`docs/adaptations.json`；保留原來源 LICENSE。

## Deferred tools 與短提示

八個工具皆以 `exposure: "deferred"`、`sqlite` namespace 註冊：`sqlite_open`、`sqlite_close`、`sqlite_status`、`sqlite_query`、`sqlite_execute`、`sqlite_list_tables`、`sqlite_describe_table`、`sqlite_manual`。Fixed mode 只註冊後六個工具。

與 PTY 相同，由 Pi Runtime 統一處理 `tool_search` 啟用、無搜尋工具時的直接宣告 fallback，以及未載入時的系統提示，不另加 module-local hook。提示包含：

> To read SQLite databases, use tool_search to find and load the sqlite tools. (query "sqlite")

搜尋 `sqlite` 載入同 namespace 目前已註冊且允許的工具；載入後提示消失。`--tools`／`--exclude-tools`／`--no-tools` 由宿主限制，不能透過搜尋繞過。只單獨載入本模組而未載入 Pi Runtime 時，不會自行加入短提示或啟用搜尋工具。

## 連線與設定

每個 extension instance 一個連線，`session_shutdown`（包含 reload）關閉；不遷移既有資料庫或改寫使用者設定。模式於 `session_start` 固定，優先順序：

```text
非空 SQLITE_PATH > 受信任專案的 .pi/agent/sqlite.json > manual mode
```

- Manual mode：先 `sqlite_open({ file_path: "data/app.sqlite" })`，完成後 `sqlite_close`。
- Fixed mode：啟動時開啟指定資料庫，完全不註冊 open／close，不能切換資料庫。
- 專案設定格式：`{ "databasePath": "./data/app.sqlite" }`；相對路徑以 session `ctx.cwd` 為準，而非設定檔目錄。
- 未信任專案不讀取設定檔；環境變數仍有效。無效設定或開啟失敗不退回 manual mode。修改設定後 `/reload`。
- Agent 可見文字（工具結果、錯誤、`sqlite_manual`、`sqlite_status` 的 hint）只提及工具、工具參數與 slash command，以「the user's database settings」之類中性詞彙描述設定問題，不含設定檔路徑、欄位或環境變數名稱；精確名稱只出現在給人看的 UI 通知。

## SQL 與安全

`sqlite_query` 執行回傳資料列的 SQL；`sqlite_execute` 執行不回傳資料列的寫入／schema SQL。寫入前先 `sqlite_status` 確認資料庫；不熟悉 schema 時使用 list／describe。

`bindings` 接受 positional array 或 named object，每個 statement 使用一種風格；`params` 保留相容用途。輸出限制為 2,000 行／50 KB，截斷時回報完整輸出的暫存檔路徑。使用者值透過 bindings 傳遞，不插值進 SQL。

`node:sqlite` 的連線與 SQL 在獨立的 Node 子行程（`src/sqlite-process.mjs`，由 `src/sqlite-client.ts` 管理）內同步執行，不佔用 Pi 主執行緒；`sqlite_query` 逐列讀取，一次最多 10,000 列或約 8 MiB（超過時結果帶 `truncated: true`，請加 `LIMIT`／條件縮小範圍；單一首列就超過位元組預算時直接報錯，請改選較少欄位或用 `substr()`）；欄名取自 statement metadata，重名欄位與零列結果都保留欄位；超過 1 KiB 的 BLOB 只回前 1 KiB 與 `byteLength`。截斷結果的暫存檔（`<tmp>/pi-sqlite-tools/<uuid>.json`）保留 24 小時，之後在下一次寫入暫存檔時清除。

開啟資料庫不改變其 journal mode（不會把檔案永久轉成 WAL）。開啟不存在的路徑會建立新的空資料庫，結果訊息會明示「Database created」，以免路徑打錯時誤以為開啟了既有資料庫。

**交易與鎖：** 每次工具呼叫是獨立的一句 SQL。`sqlite_execute` 拒絕交易控制語句（`BEGIN`／`COMMIT`／`END`／`ROLLBACK`／`SAVEPOINT`／`RELEASE`，不分大小寫，可有前置空白與註解），以免連線停在未提交交易並持有寫鎖；此外每次 query／execute 結束後若連線仍在交易中，會自動 `ROLLBACK` 並回報錯誤。連線以 `timeout: 2000`（`BUSY_TIMEOUT_MS`，Node 22.16 起支援）開啟：另一連線持鎖時最多等待 2 秒再報 `database is locked`。鎖等待只阻塞子行程，不阻塞 Pi 事件迴圈。

**單一 statement：** `node:sqlite` 只編譯第一句、其餘會被靜默丟棄，因此 `sqlite_query`／`sqlite_execute` 遇到第一句之後仍有程式碼（字串、引號識別字、括號識別字與註解內的分號不算）一律拒絕；`CREATE TRIGGER` 本體含分號，交由 SQLite 處理。

**`sqlite_query` 不是唯讀（未修，刻意保留）：** 它的契約是「回傳資料列」。`INSERT … RETURNING`、`PRAGMA journal_mode=WAL` 這類回傳資料列的語句會真的寫入（後者永久改變資料庫），因為若強制 `query_only`，`INSERT … RETURNING` 將沒有任何工具可執行（`sqlite_execute` 拒絕回傳資料列的語句）。破壞性操作仍應先 `sqlite_status` 確認資料庫。

**暫存輸出清理：** 超過 24 小時的完整輸出檔在每次產生新輸出時清除；每次最多 `stat` 2,048 個符合檔名規則的候選（非本模組檔名不計），超過時起點輪轉，因此排在目錄後段的過期檔會被之後的呼叫處理到，不會永遠留下。

**取消與子行程：** 每個 session 一個子行程（第一次需要連線時才啟動，`fork`、IPC 使用 advanced serialization、stdio 靜音、old space 256 MB）、一次只跑一個呼叫，依序排隊。`sqlite_*` 呼叫的 `AbortSignal` 被 abort 時：`sqlite_open`／`sqlite_close`／`sqlite_status` 等所有 `sqlite_*` 呼叫都會收到訊號：排隊中被取消的呼叫立即返回且在輪到時略過（不會關閉目前連線或建立資料庫），已取消的呼叫直接拒絕；正在執行的呼叫以 `SIGKILL` 終止子行程（`node:sqlite` 無 interrupt，worker thread 也無法在原生呼叫中被中止），**等 close 事件確認退出後**才回報 cancelled，期間不啟動替代行程。取消訊息不保證寫入是否已提交：可能剛好晚於提交，重試前須先查核資料。下一次呼叫才啟動新子行程並重開同一檔案（重開失敗則回報並視為已關閉）；連線本地狀態（暫存表等）因此遺失。`kill()` 回傳失敗且行程未退出時，回報無法終止並保留所有權，不建立新行程。`session_shutdown` 永久停用 client：立即終止子行程，並拒絕尚在排隊的操作（含 `sqlite_open`）。子行程由一般 Node 啟動，不能載入 `node_modules` 內的 TypeScript，所以它匯入的 `sqlite-core.mjs`（`SqliteManager` 的純 JavaScript 實作，型別在 `sqlite-core.d.mts`；`sqlite-manager.ts` 只是轉出）必須維持純 JavaScript，`installed-layout.test.ts` 以 node_modules 佈局驗證；父行程消失（IPC disconnect）時子行程自行結束。限制：沒有執行期限，未取消的無終止條件查詢會一直佔用子行程，須靠取消結束；列數／位元組上限只約束已回傳的資料列。

此模組可依目前使用者權限讀寫資料庫，不是唯讀工具集或 OS sandbox。啟用整合版前，請手動停用獨立 `pi-sqlite-tools`，避免同名工具重複註冊。

## 驗證

根目錄執行 `npm run test:module -- sqlite-tools`：strict typecheck、來源單元測試及離線真實 Pi SDK deferred 搜尋／提示／manual-fixed reload 與清理測試。測試不呼叫模型或真實 provider credentials；根 manifest／跨模組與封裝驗證另由 `test:cross`、`test:package` 負責。

## Error messages

Failure responses name the parameter, the rule and the fix (2026-10-24 guidance pass; see plan/error-message-handoff.md). Driver errors are wrapped with the operation, SQLite code, a SQL excerpt of at most 200 characters and a category hint.
