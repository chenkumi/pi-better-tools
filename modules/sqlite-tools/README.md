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

## SQL 與安全

`sqlite_query` 執行回傳資料列的 SQL；`sqlite_execute` 執行不回傳資料列的寫入／schema SQL。寫入前先 `sqlite_status` 確認資料庫；不熟悉 schema 時使用 list／describe。

`bindings` 接受 positional array 或 named object，每個 statement 使用一種風格；`params` 保留相容用途。輸出限制為 2,000 行／50 KB，截斷時回報完整輸出的暫存檔路徑。使用者值透過 bindings 傳遞，不插值進 SQL。

`node:sqlite` 在 Pi 主執行緒同步讀取，因此 `sqlite_query` 逐列讀取，一次最多 10,000 列或約 8 MiB（超過時結果帶 `truncated: true`，請加 `LIMIT`／條件縮小範圍）；超過 1 KiB 的 BLOB 只回前 1 KiB 與 `byteLength`。截斷結果的暫存檔（`<tmp>/pi-sqlite-tools/<uuid>.json`）保留 24 小時，之後在下一次寫入暫存檔時清除。

開啟資料庫不改變其 journal mode（不會把檔案永久轉成 WAL）。開啟不存在的路徑會建立新的空資料庫，結果訊息會明示「Database created」，以免路徑打錯時誤以為開啟了既有資料庫。

此模組可依目前使用者權限讀寫資料庫，不是唯讀工具集或 OS sandbox。啟用整合版前，請手動停用獨立 `pi-sqlite-tools`，避免同名工具重複註冊。

## 驗證

根目錄執行 `npm run test:module -- sqlite-tools`：strict typecheck、來源單元測試及離線真實 Pi SDK deferred 搜尋／提示／manual-fixed reload 與清理測試。測試不呼叫模型或真實 provider credentials；根 manifest／跨模組與封裝驗證另由 `test:cross`、`test:package` 負責。
