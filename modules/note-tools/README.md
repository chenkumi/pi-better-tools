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

- 以 Pi 的 `ctx.cwd` 為根，必要時建立 `<type>/` 目錄，新增 `<type>/<TYPE>-<UTC 時間戳>.md`，例如 `plan/PLAN-2026-10-01T04-30-00-123Z.md`（時間戳中的 `:`、`.` 換成 `-`）。
- 內容原樣寫入，不加標題、frontmatter 或模板；含孤立 UTF-16 surrogate 的內容會被拒絕。
- 以 exclusive-create 建立，不覆寫既有檔案；檔名碰撞時時間戳加 1 毫秒重試，最多 1000 次，超過則回報 `NOTE_FILENAME_COLLISION`。
- 回傳文字 `Saved note: <相對路徑>` 與絕對路徑；`structuredContent` 為 `{ type, path, relativePath }`（`path` 為絕對路徑，`relativePath` 使用 `/`）。
- 寫入開始前會檢查取消；開始寫入後會完成該次寫入。
- 本工具僅負責新增；後續讀取或修改請用檔案工具（read／edit／write）操作回傳的路徑。

## 設定

無設定鍵。工具是否啟用依 Pi 的工具選取／排除設定。
