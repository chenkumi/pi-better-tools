# SQLite Tools：manual／fixed 掛載

## 指令與工具

`sqlite_open`、`sqlite_close`、`sqlite_status`、`sqlite_query`、`sqlite_execute`、`sqlite_list_tables`、`sqlite_describe_table`、`sqlite_manual` 全部 deferred，先以 `tool_search` 搜尋 `sqlite`。沒有專用 slash 設定命令；fixed mode 完全不註冊 `sqlite_open`／`sqlite_close`，這兩個工具也不會出現在 `tool_search` 結果中。

## Config 與作用範圍

支援兩種互斥模式：manual 由 agent 呼叫 `sqlite_open` 指定檔案，不需建立 config；fixed 從設定取得固定檔案，啟動時自動開啟，不能透過工具切換資料庫。

啟動時優先順序：非空 `SQLITE_PATH` > 受信任專案 `<cwd>/.pi/agent/sqlite.json` > manual mode。前兩者都屬於 fixed mode；兩者皆未提供可用來源時才進入 manual mode（例如環境變數未設且專案設定檔不存在）。

專案檔案範例：

```json
{ "databasePath": "./data/app.sqlite" }
```

- 相對路徑以 session cwd 為準，不是 `.pi/agent/` 或 package 安裝目錄。
- `SQLITE_PATH` 在啟動環境設定，不寫在 Pi settings；空白值視為未設，環境變數不受專案 trust 影響。
- 未信任專案不讀專案檔；無效設定或 fixed 開啟失敗不退回 manual。
- 模式於啟動時固定；fixed 的資料庫路徑也固定。要改變模式或 fixed 路徑，需調整上述設定來源後 `/reload` 或重啟；重載前提醒目前背景工作可能受影響。
- Manual 要先 `sqlite_open`，可用 `sqlite_close` 關閉，或再次 `sqlite_open` 切換檔案；切換時會先關閉原連線，再嘗試開啟新檔案，失敗不會保留原連線。每 instance 同時只有一個連線，shutdown 關閉。
- 不讀取 home 的同名 sqlite.json，也沒有全域 `pi-sqlite-tools` config namespace。

## 使用與驗證

Manual 呼叫示例：`sqlite_open { file_path: "data/app.sqlite" }`；注意開檔可能建立新資料庫，先確認目標。先 sqlite_status 核對目前 path，再 list／describe／query；sqlite_execute 修改 schema／資料前仍要確認目標。

`bindings` 接受 positional array 或 named object，一個 statement 不混用；params 為相容別名。Query 回傳 rows，execute 用於不回傳 rows 的 SQL。這不是唯讀 sandbox。

啟用整合版前停用獨立 pi-sqlite-tools，避免重複工具；不自動搬移資料或改真實設定。
