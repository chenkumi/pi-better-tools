# Note Tools

提供 `note` 工具：在目前工作目錄下建立分類 Markdown 筆記，檔名自動產生，並回報儲存路徑。

## 參數

| 參數 | 說明 |
| --- | --- |
| `type` | 分類：`plan`、`design`（設計文件）、`issue`、`research`、`report`、`task` |
| `content` | 完整檔案內容（UTF-8，原樣寫入；空字串或僅空白會被拒絕） |

只接受這兩個參數。

```json
{ "type": "plan", "content": "# Plan\n\n步驟…\n" }
```

## 行為

- 以 Pi 的 `ctx.cwd` 為根，必要時建立 `<type>/` 目錄，新增 `<type>/<TYPE>-<UTC 時間戳>.md`，例如 `plan/PLAN-20261008T060625729Z.md`（緊湊 UTC 格式 `YYYYMMDDTHHmmssSSSZ`，保留毫秒、固定寬度及時間排序；既有筆記不更名）。
- 檔名由系統自動產生，只含分類及時間戳，不附加內容標題或 slug，也不接受使用者指定路徑或檔名。
- 內容原樣寫入，不加標題、frontmatter 或模板；含孤立 UTF-16 surrogate 的內容會被拒絕。
- 以 exclusive-create 建立，不覆寫既有檔案；檔名碰撞時時間戳加 1 毫秒重試，最多 1000 次（刻意保留此規則；僅碰撞時可能比呼叫時刻晚最多 999 毫秒，檔名時間戳不是精確的寫入時間證明），超過則回報 `NOTE_FILENAME_COLLISION`。
- 回傳文字只含一個路徑：`Saved note: <相對路徑> (relative to cwd; use read/edit on this path to change it)`，不含絕對路徑；`details`、`structuredContent` 與輸出 schema 皆只含 `{ relativePath }`（`relativePath` 相對於 cwd、使用 `/`）。
- 寫入開始前會檢查取消；開始寫入後會完成該次寫入。
- 若 `<cwd>/<type>` 是指向工作目錄外的 symlink／junction，回報 `NOTE_DIRECTORY_ESCAPE` 並拒絕寫入（以 realpath 驗證）。
  路徑比較以完整 segment 進行（`..`、`..` + 分隔符、絕對路徑才算逃逸），因此指向工作區內名為 `..archive` 之類目錄的 junction 會被接受。
- 已知限制（威脅模型）：realpath 檢查之後祖先目錄被外部寫入者換成指向工作區外的 junction 時，`wx` 建立後會再以 realpath 重新驗證父目錄；若已逃出工作區，立即移除剛建立的空檔並回報 `NOTE_DIRECTORY_ESCAPE`（寫入內容前）。這縮小但不消除視窗：不宣稱原子防禦，持續性外部 writer 在驗證之後再次替換仍不在範圍內；host 的 mutation queue 不鎖外部 writer。`tests/note-toctou.integration.test.mjs` 覆蓋單次替換情境。
- 空白或僅空白字元的內容回報 `NOTE_EMPTY`，訊息指示模型補上完整文件後重呼叫，不建立任何檔案。
- 內容上限 8 MiB（UTF-8 位元組），超過回報 `NOTE_TOO_LARGE`；寫入中途失敗（例如磁碟已滿）時，會盡力刪除本次建立的殘缺檔案後再回報錯誤。
- 本工具僅負責新增；後續讀取或修改請用檔案工具（read／edit／write）操作回傳的路徑。

## TUI 顯示

呼叫顯示分類與內容首行摘要，不帶入整份 Markdown；下方獨立一行於參數串流接收時動態顯示 `receiving N bytes`，參數完整後改為 `received N bytes`，以 `Buffer.byteLength(content, "utf8")` 計算目前內容的 UTF-8 位元組數（不含分類或 JSON 包裝；缺少內容時為 0）。此計數表示參數接收量，不代表儲存成功，失敗／取消後仍保留呼叫顯示。結果只顯示儲存相對路徑，展開時也不顯示絕對路徑。錯誤／部分結果有文字提示。Renderer 只調整顯示，不修改回傳 content、details 或 structuredContent。

## 設定

無設定鍵。工具是否啟用依 Pi 的工具選取／排除設定。
