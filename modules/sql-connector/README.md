# SQL Connector（整合版）

來源為使用者擁有的 `D:/projects/pi-sql-connector` 0.1.0，已納入本模組，不依賴來源路徑。入口為 `modules/sql-connector/src/index.ts`；根 package／lockfile 是唯一安裝單元，支援基準為 Pi 1.3.0。來源快照與適配記錄見 `docs/sources.json`、`docs/adaptations.json`。原來源宣告 MIT，整合專案採根 MIT LICENSE。

## 支援的資料庫與 deferred tools

| 設定鍵／namespace | 工具 | SQL placeholder | params |
| --- | --- | --- | --- |
| `mysql` | `mysql_state`、`mysql_query`、`mysql_update` | `?` | ordered array |
| `mssql` | `mssql_state`、`mssql_query`、`mssql_update` | `@name` | object，鍵名不含 `@` |
| `pgsql` | `pgsql_state`、`pgsql_query`、`pgsql_update` | `$1`、`$2`… | ordered array |

每個專案每種引擎最多一個設定，只有已配置的引擎才註冊工具，九個工具全部採 `exposure: "deferred"`。存取資料庫前，用 `tool_search` 搜尋 `mysql`、`mssql` 或 `pgsql`。Pi Runtime 統一提供未載入 namespace 的短提示；載入後移除提示。來源完整參數與安全提示以 `*_state` 的 `promptGuidelines` 提供，只在該工具載入後送出，不另加整份 system prompt replacement。

與 PTY／SQLite 相同，不自行啟用 `tool_search` 或繞過 `--tools`、`--exclude-tools`、`--no-tools`。單獨載入本模組而沒有 Pi Runtime 時，沒有共用提示／startup fallback。Deferred 指延遲向模型宣告工具，不是將已載入的工具程式碼或所有 JS dependencies 延後匯入。

## 專案掛載設定

在 **session 工作目錄**建立 `.pi/agent/sql-connector.json`，只保留需要的資料庫鍵；分享用範例在 `examples/sql-connector.example.json`。設定檔包含敏感資料，請加入專案 ignore，不要提交。模組不會建立、複製或改寫此檔案。

```json
{
  "pgsql": {
    "host": "127.0.0.1",
    "username": "pi_reader",
    "password": "${PGPASSWORD}",
    "database": "analytics",
    "ssl": true
  }
}
```

只有 `ctx.isProjectTrusted()` 為 true 時讀取設定。未信任、未設定或設定無效時不註冊資料庫工具；無效設定以安全訊息回報。沒有 SQLite 的 `SQLITE_PATH`／manual-open 模式，也不讀來源專案或使用者 home 的設定檔。

- 預設 port：MySQL 3306、MSSQL 1433、PostgreSQL 5432。
- 密碼接受 literal 或完整 `${ENV_VAR}`，不做任意字串插值。MySQL 可省略／留空 username、password、database 使用 driver/server 預設。
- MSSQL SQL Authentication 使用 username／password；Windows Authentication 設 `windowsAuth: true`、省略 username／password。
- MSSQL named instance 使用 `instanceName`，該情況不要指定 port。Windows Authentication 預設 `odbcDriver: "ODBC Driver 18 for SQL Server"`。
- `ssl`／`trustServerCertificate` 保留來源行為；`trustServerCertificate: true` 只應用於明確信任的本機／自簽開發伺服器，不為了連線成功自動降低 TLS 驗證。

修改設定後使用 `/reload` 或 `/sql-connector-reload`。連線池在首次實際操作時建立；shutdown／reload 關閉池，不跨行程恢復連線。

## 安裝與原生 driver

根 runtime dependencies 固定為 `mysql2@3.24.6`、`mssql@12.7.9`、`pg@8.23.1`，由根 lockfile 管理（2026-10-16 更新；來源快照身份不變）；宿主 Pi peers 不放入 runtime dependencies。從根目錄執行 `npm install --ignore-scripts` 或 `npm ci --ignore-scripts`。

MSSQL Windows Authentication 另需 optional dependency `msnodesqlv8@5.6.0` 的原生 bindings，以及系統 ODBC driver。一般 MySQL／PostgreSQL／MSSQL SQL Authentication 不需要它。整合版只在建立 Windows Authentication adapter 時才 require `mssql/msnodesqlv8`，不因未編譯／未安裝 ODBC binding 阻止整個套件載入。

需要 Windows Authentication 時，在根目錄明確執行 `npm rebuild msnodesqlv8 --foreground-scripts`，並自行安裝對應 ODBC driver；無可用 prebuild 時需要該套件要求的 native build 工具。根 allowScripts 僅允許固定的 `msnodesqlv8@5.6.0` 與原有 node-pty，不自動允許其他 dependency scripts。未安裝原生 driver 時不退回另一種認證。此任務不自動安裝系統 ODBC 或連線真實資料庫。

## 安全與限制

- 先用 `*_state` 確認連線，再用 `*_query` 查詢；MySQL／PostgreSQL SELECT／CTE 要有 literal `LIMIT 1..200`，MSSQL 要有 `TOP 1..200`。
- `*_update` 只接受單一 INSERT／UPDATE／DELETE；UPDATE／DELETE 需要 top-level WHERE，每次寫入都需互動 UI 確認。非互動模式拒絕寫入，取消確認不執行。
- 保留來源 SQL allowlist、單一 statement、參數 binding、取消與安全化 driver errors。結果最多 200 rows／約 48 KiB，常見敏感欄位名稱遮蔽；不是完整 DLP 或完整 SQL parser。
- SQL 檢查依各引擎的字串、識別字與註解語法切分：PostgreSQL dollar-quote（`$$…$$`、`$tag$…$tag$`）與巢狀 `/* */`、MSSQL `[...]`（`]]` 跳脫）與巢狀註解、MySQL backtick、`#` 註解及「`--` 後須接空白」規則。MySQL／PostgreSQL 字串字面值內的反斜線一律拒絕（其意義取決於伺服器設定），請改用參數 binding；未結束的字串、識別字或註解拒絕。
- MSSQL batch 不需分隔符即可接第二個 statement，因此 `mssql_query` 另拒絕可起始非讀取 statement 或轉送 SQL 的關鍵字（例如 `SET`、`DECLARE`、`WAITFOR`、`BACKUP`、`RESTORE`、`KILL`、`SHUTDOWN`、`DBCC`、`USE`、`BEGIN`／`COMMIT`、`OPENQUERY`／`OPENROWSET`）；`mssql_update` 除 UPDATE 本身的 `SET` 外同樣拒絕，並拒絕第二個 `INSERT`／`UPDATE`／`DELETE`，以及 `UPDATE`／`DELETE` 內任何 `INTO`（`INSERT` 僅允許一個），避免無分隔符追加第二句 DML 或 `SELECT ... INTO`。與這些字同名的欄位／別名請以 `[name]` 引用。
- 讀取在資料庫層另有防護：PostgreSQL 一律走 extended protocol（無參數時也不會成為可執行多 statement 的 simple query），並在 `BEGIN READ ONLY` 交易內執行後 rollback；MySQL 以單一 prepared statement 在 `START TRANSACTION READ ONLY` 內執行後 rollback，讀取有 30 秒 client 端逾時。MySQL 寫入不加 client 端逾時：逾時只會斷線，不會停止伺服器上的寫入。失敗或逾時的連線直接丟棄，不放回 pool；MySQL 等待連線的佇列上限 32。
- 唯讀交易不阻擋所有副作用（例如 PostgreSQL `pg_terminate_backend()`、MSSQL 讀取中的函式／程序行為），MSSQL 也沒有交易層防護；最終界線仍是資料庫帳號權限，讀取請使用唯讀帳號。
- 資料庫帳號權限仍是最終安全界線，請使用最小權限；工具不是 OS sandbox，也不能以 SQL 檢查代替權限管理。
- 與 SQLite 模組並存，沒有工具名稱衝突。啟用前請手動停用獨立 `pi-sql-connector` extension，避免重複註冊；不自動修改真實 settings/auth。

## 驗證

根目錄 `npm run test:module -- sql-connector` 執行 strict typecheck、來源 Vitest 與離線真實 Pi SDK probes。涵蓋 configured-only deferred discovery、共用提示、無搜尋 fallback、trust、缺少／無效設定、allowlist/no-tools/exclude、重載撤除引擎與舊 runtime 關閉。Production package probe 使用隔離 credentials，檢查 relocation／drivers 可載入與寫入拒絕，不連線任何資料庫。

真實 MySQL／MSSQL／PostgreSQL 伺服器、Windows Authentication native bindings／ODBC、TLS 握手與資料庫權限需在使用者授權的環境另外驗證；離線 mock／loader 通過不等於這些實際連線已驗證。
