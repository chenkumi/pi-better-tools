# SQL Connector：MySQL／MSSQL／PostgreSQL 掛載

## 指令與工具

| Namespace／搜尋字串 | 工具 | params 與 placeholder |
| --- | --- | --- |
| mysql | mysql_state、mysql_query、mysql_update | array，`?` |
| mssql | mssql_state、mssql_query、mssql_update | object，`@name`（鍵不含@） |
| pgsql | pgsql_state、pgsql_query、pgsql_update | array，`$1`／`$2`… |

九工具皆 deferred，先用 tool_search 搜尋對應 namespace。只為已配置引擎註冊，不配置就沒有該工具。`/sql-connector-reload` 等同請求重載設定／關閉既有池，也可用 `/reload`。

## Config 與作用範圍

只讀受信任 session cwd 的 `.pi/agent/sql-connector.json`，不是 home 或 Pi settings。每種引擎一組連線設定：

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

此為佔位範例；密碼放環境變數，設定檔不要提交。只接受完整 `${ENV_VAR}` 引用或 literal，不做任意插值。預設 ports：mysql3306、mssql1433、pgsql5432；MySQL 可省略 username／password／database 採 driver/server 預設。

MSSQL SQL Authentication 使用 username/password；Windows Authentication 使用 windowsAuth true 並省略帳密。Named instance 使用 instanceName，該情況不要指定 port；Windows Authentication 預設 ODBC Driver 18 for SQL Server。trustServerCertificate true 只限明確信任的本機／自簽開發伺服器，不為成功連線自動降低 TLS。

設定變更後 reload；未信任／缺設定／無效設定不註冊 DB 工具。池在首次實際操作時建立，shutdown 關閉。與 SQLite 的 SQLITE_PATH／manual-open 模式無關。

- `/settings:sql-connector`（僅互動 TUI、僅受信任專案）開面板：每種引擎一個開關與連線欄位；密碼來源 `env`（寫成 `${VAR}`，建議）或 `key`（遮罩輸入、明文存入 JSON，既有密碼不回顯、留空保留）。只在存檔時寫專案 `sql-connector.json`，只重建被改的引擎區塊、其餘原樣保留；關閉最後一個引擎時刪除檔案；不降級 TLS／認證（`trustServerCertificate` 預設關）。存檔後詢問是否 `/reload`。

## 安裝與驗證

依賴只在 package 根安裝。Windows Authentication 額外需要 optional msnodesqlv8 native bindings 與系統 ODBC driver；使用者明確執行 `npm rebuild msnodesqlv8 --foreground-scripts` 並配置 ODBC。一般 MySQL／PostgreSQL／MSSQL SQL Authentication 不需此 native binding，缺少時不改用另一種認證。

先用 *_state 檢查連線，但這會實際接觸資料庫，需使用者授權。Reads 保留 LIMIT／TOP 1..200；updates 僅單一 INSERT／UPDATE／DELETE、後兩者須 top-level WHERE，且每次互動確認，非互動拒絕。遵守最小 DB 權限，不把 parser／遮蔽當 sandbox 或完整 DLP。停用原獨立 pi-sql-connector 避免重複註冊，不自動複製來源設定或讀出密碼。
