# Note Tools

提供 `note` 工具：在目前工作目錄下建立分類 Markdown 筆記，檔名自動產生，並回報儲存路徑。

## 參數

| 參數 | 說明 |
| --- | --- |
| `type` | 分類：`plan`、`issue`、`research`、`report`、`task` |
| `content` | 完整檔案內容（UTF-8，原樣寫入；允許空字串） |

只接受這兩個參數。

```json
{ "type": "plan", "content": "# Plan\n\n步驟…\n" }
```

## 行為

- 以 Pi 的 `ctx.cwd` 為根，必要時建立 `<type>/` 目錄，新增 `<type>/<TYPE>-<UTC 時間戳>.md`，例如 `plan/PLAN-20261001T043000123Z.md`（緊湊 UTC 格式 `YYYYMMDDTHHmmssSSSZ`，保留毫秒、固定寬度及時間排序；既有筆記不更名）。
- 內容原樣寫入，不加標題、frontmatter 或模板；含孤立 UTF-16 surrogate 的內容會被拒絕。
- 以 exclusive-create 建立，不覆寫既有檔案；檔名碰撞時時間戳加 1 毫秒重試，最多 1000 次，超過則回報 `NOTE_FILENAME_COLLISION`。
- 回傳文字 `Saved note: <相對路徑>` 與絕對路徑；`structuredContent` 為 `{ type, path, relativePath }`（`path` 為絕對路徑，`relativePath` 使用 `/`）。
- 寫入開始前會檢查取消；開始寫入後會完成該次寫入。
- 若 `<cwd>/<type>` 是指向工作目錄外的 symlink／junction，回報 `NOTE_DIRECTORY_ESCAPE` 並拒絕寫入（以 realpath 驗證）。
- 內容上限 8 MiB（UTF-8 位元組），超過回報 `NOTE_TOO_LARGE`；寫入中途失敗（例如磁碟已滿）時，會盡力刪除本次建立的殘缺檔案後再回報錯誤。
- 本工具僅負責新增；後續讀取或修改請用檔案工具（read／edit／write）操作回傳的路徑。

## TUI 顯示

呼叫顯示分類與內容首行摘要，不帶入整份 Markdown；結果顯示儲存相對路徑，展開時另顯示絕對路徑。錯誤／部分結果有文字提示。Renderer 只調整顯示，不修改回傳 content、details 或 structuredContent。

## 設定

無設定鍵。工具是否啟用依 Pi 的工具選取／排除設定。
