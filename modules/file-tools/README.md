# File Tools

覆寫 Pi 內建的 `read`、`write`、`edit` 三個工具，提供行號、版本雜湊、精確比對與原子寫入。只覆寫這三個工具；權限與 hook 仍由 Pi 負責，工具 annotations 只是提示，不是授權。

## 共通行為

- 路徑：相對路徑（相對 cwd）、絕對路徑、開頭 `@`、家目錄展開、`file://` URL。Windows 另接受 `/C/...`、`/mnt/C/...`、`/cygdrive/C/...`；格式錯誤的 URL 會被拒絕。
- 所有 schema 皆為 strict（不允許未宣告欄位）。選填欄位傳 `null` 等同省略；必填欄位仍拒絕 `null`。
- 檔案上限 50 MiB；文字須為合法 UTF-8（否則 `INVALID_ENCODING`）。
- 版本雜湊：32 字元 SHA-256 token（SHA-256 前 128 bit，十六進位），亦接受 64 字元完整 SHA-256。
- 對同一檔案的操作透過 Pi 的 file mutation queue 排序。
- 錯誤以例外拋出（`isError: true`），內容為 `[FILE_TOOL_ERROR]` JSON；TUI 僅調整顯示，不改變模型可見內容。

## TUI 顯示

`read`／`write` 呼叫沿用宿主 renderer；`read` 成功、syntax highlighting 與圖片附件亦保留宿主行為。`[FILE_TOOL_ERROR]` 由專用 renderer 顯示操作、錯誤碼、訊息及 recovery，展開可看路徑／行範圍，不原樣輸出錯誤 JSON。`write` 成功顯示寫入 bytes，展開顯示路徑與 SHA-256；模型仍收到原本的 `[FILE_WRITE_SUCCESS]`。`edit` 保留 diff renderer，三者共用錯誤 formatter。這些都是顯示層變更，不改工具回傳格式。

## `read`

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `path` | string（必填） | 檔案路徑 |
| `offset` | integer ≥ 1 | 起始行（1 基底） |
| `limit` | integer ≥ 1 | 最多回傳行數 |

- 輸出以 `[FILE_METADATA] {...}` 開頭，其後每行為 `<絕對行號>│<內容>`；前綴是中介資料，不可複製進 `edit.oldText`。metadata 含版本 token。
- 單次最多 2000 行／50 KiB；被截斷或受 `limit` 限制時附 `[READ_CONTINUATION] nextOffset=...; totalLines=...; reason=...`。過長而被略過的行以 `reason=oversized_line_skipped` 標示。
- 圖片（PNG／JPEG／GIF／WebP／BMP，以檔頭判斷）交由 Pi 內建圖片附件行為處理。以檔頭判斷不等於完整驗證圖片。
- 若路徑不存在，且為 `<skill 目錄>/SKILL.md`，並唯一對應到已載入的 skill 檔，會自動更正為該路徑，並在輸出加入 `[SKILL_PATH_AUTO_CORRECTED]`。
- 背景 subagent 的 managed `subagent-sessions/<ULID 或舊 UUID>/runs/<taskId>/transcript.jsonl.partial` 若回報 `FILE_NOT_FOUND`，會檢查同目錄 `transcript.jsonl`：存在時僅指引明確改讀、不自動替換；兩者皆不存在時提示等待完成通知。權限／probe 錯誤保留，缺失不代表工作已完成。完成通知中的 conversation aggregate `logPath` 與 run-local 行數不同，不可沿用 offset。

```json
{ "path": "src/app.ts", "offset": 1, "limit": 200 }
```

## `write`

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `path` | string（必填） | 檔案路徑；父目錄自動建立 |
| `content` | string（必填） | 完整 UTF-8 內容；空字串會清空檔案 |
| `expectedHash` | string | 最近一次 `read` 的版本 token，或 `"missing"`（路徑必須尚不存在） |

- 省略 `expectedHash` 為無條件覆寫，但提交前仍會重新驗證自己的初始快照。
- 新檔以不覆蓋的原子方式建立；既有檔以同目錄原子取代。
- 拒絕以符號連結為寫入目標（`SYMLINK_UNSUPPORTED`）。
- 成功回傳 `[FILE_WRITE_SUCCESS]` JSON。

```json
{ "path": "src/new-file.ts", "content": "export {};\n", "expectedHash": "missing" }
```

## `edit`

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `path` | string（必填） | 既有檔案 |
| `expectedHash` | string | 版本 token；檔案已變更則 `STALE_FILE` |
| `edits` | array（必填，1–100 項） | 取代操作 |

每個 `edits` 項目：

| 欄位 | 說明 |
| --- | --- |
| `oldText` | 精確文字（非空）。與 `regex` 二擇一 |
| `regex` | ECMAScript RegExp（非 Python／PCRE），最長 4096 字元。與 `oldText` 二擇一 |
| `regexFlags` | 僅限 `regex`；允許 `i`、`m`、`s`、`u`，各最多一次；不可用 `g` |
| `newText` | 必填；空字串代表刪除 |
| `lineRange` | `{ start, end }`，1 基底、含頭尾的搜尋視窗，`end ≥ start` |
| `replaceAll` | 預設 `false`；為 `false` 時選定範圍內必須剛好一處符合 |
| `replacementMode` | `"literal"`（預設）或 `"template"`（僅 `regex`，啟用 `$1`、`$<name>` 等） |

行為：

- regex 搭配 `lineRange` 時，視窗文字以獨立字串比對：`^`、`$`、lookbehind／lookahead 看不到視窗外的內容；需要整檔語意時請省略 `lineRange`。
- `read`／`edit`／`write` 只接受一般檔案；FIFO、裝置與目錄回報 `FILE_NOT_READABLE`／`FILE_NOT_WRITABLE`，不會阻塞。
- 新檔建立優先用 hard link 保證不覆蓋；檔案系統不支援時改用 exclusive create（`wx`）。寫入會 fsync、在 rename 前套用目標權限；Windows 上 rename 遇 EPERM／EBUSY 會短暫重試；失敗時盡力移除本次建立的空目錄。
- regex 的 1 秒預算從 worker 實際開始比對起算（不含 worker 啟動與大字串複製）。
- 未指定 `lineRange` 時為整檔比對，文字須唯一（除非 `replaceAll: true`）。
- `lineRange` 只是初始搜尋視窗，不是整行取代邊界。literal `oldText` 在視窗內找不到、但整檔恰有一處時，自動採用該處；整檔多處則 `AMBIGUOUS_MATCH` 並回報候選範圍。regex 沒有此回退。
- 所有 `edits` 皆對原始快照比對，不得重疊，全部驗證通過後才一次原子提交。
- 保留 BOM 與未修改處的 CRLF／LF 混用；取代結果若含孤立 surrogate 則 `INVALID_ARGUMENT`，檔案不變。
- `edits` 接受 JSON 字串或單一物件形式（會正規化為陣列）；頂層的 `oldText`／`regex`／`newText`／`lineRange`／`lineStart`／`lineEnd` 會被拒絕。
- 成功回傳 `[FILE_EDIT_SUCCESS]`（含 `appliedEdits`、`matchedCount`、`changedCount`、`sha256Before`、`sha256After`、最多 20 筆 `changedRanges`）與 `[DIFF]` unified diff。

```json
{
  "path": "src/app.ts",
  "expectedHash": "<read 回傳的 32 字元 token>",
  "edits": [
    { "oldText": "const enabled = false;", "newText": "const enabled = true;" },
    { "regex": "^status: .*$", "regexFlags": "m", "newText": "status: ok", "lineRange": { "start": 200, "end": 350 } }
  ]
}
```

## 限制

- 輸入與結果檔案：50 MiB；edit 驗證預算 10 秒；regex 單次 1 秒；regex 比對上限 10,000、edit 比對上限 20,000。
- diff 在可終止的 worker 中計算：逾時 2 秒、old-generation heap 256 MiB、顯示加 patch 輸出上限 50 MiB。無法產生 diff 時於提交前失敗，不會提交後才回報成功。
- 並行保證僅涵蓋參與 Pi file mutation queue 的工具；提交前重新驗證可縮小但無法消除與任意外部寫入者的競爭。

## 錯誤碼

`INVALID_ARGUMENT`、`FILE_NOT_FOUND`、`FILE_NOT_READABLE`、`FILE_NOT_WRITABLE`、`INVALID_ENCODING`、`FILE_TOO_LARGE`、`SYMLINK_UNSUPPORTED`、`RANGE_OUT_OF_BOUNDS`、`TEXT_NOT_FOUND`、`TEXT_NOT_FOUND_IN_RANGE`、`AMBIGUOUS_MATCH`、`OVERLAPPING_EDITS`、`INVALID_REGEX`、`REGEX_TIMEOUT`、`OPERATION_TIMEOUT`、`TOO_MANY_MATCHES`、`RESULT_TOO_LARGE`、`STALE_FILE`、`FILE_ALREADY_EXISTS`、`NO_CHANGE`、`OPERATION_ABORTED`、`IO_ERROR`

## 設定

唯一設定鍵為 `pi-file-tools.debugLog`（boolean，預設 `false`），寫在 Pi 全域設定檔 `~/.pi/agent/settings.json`；若設定了 `PI_CODING_AGENT_DIR`，則為該目錄下的 `settings.json`。檔案不存在視為預設值；JSON 無效、`pi-file-tools` 不是物件或 `debugLog` 不是 boolean 時，擴充載入會拋出錯誤。

```json
{
  "pi-file-tools": {
    "debugLog": true
  }
}
```

啟用後，失敗的 `read`／`write`／`edit`（含參數驗證失敗）會以 JSON Lines 附加到 `~/.pi/logs/pi-file-tools/YYYY-MM-DD.jsonl`，每筆含時間、工具、toolCallId、原始請求與結構化錯誤。請求可能包含檔案路徑與內容，請妥善保管。寫入日誌失敗不會遮蔽原始錯誤。
