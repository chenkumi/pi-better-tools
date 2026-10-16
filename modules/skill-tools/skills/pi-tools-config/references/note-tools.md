# Note Tools：分類筆記

## 指令與工具

只有 `note { type, content }`，沒有專用 slash command。

```json
{ "type": "task", "content": "# 待辦\n\n說明需要完成的工作。\n" }
```

`type` 為 plan／design／issue／research／report／task。檔案自動新增至當前 cwd 的分類目錄，檔名為 `TYPE-<UTC 時間戳>.md`，不附加標題或 slug。回傳單一相對路徑；不接受指定檔名、資料夾或覆寫既有文件。後續以 read／edit 操作實際回傳路徑。

## Config 與作用範圍

**沒有模組設定鍵，也沒有獨立 config 檔。** 工具啟停使用 Pi 工具選取／排除；輸出位置由呼叫當下 `ctx.cwd` 決定，不是 package 安裝目錄。不要捏造 `note.outputDir` 等不存在的設定。

內容不可只有空白，上限 8 MiB。分類目錄指向 workspace 外時拒絕寫入；不是 OS sandbox。驗證可在使用者指定的測試 workspace 新增一份筆記並核對回傳路徑，不能為驗證而覆寫既有筆記。
