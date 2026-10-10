# File Tools

覆寫 Pi 內建的 `read`、`write`、`edit`、`ls` 四個工具。前三者提供行號、版本雜湊、精確比對與原子寫入；`ls` 沿用 Pi 1.1.0 的公開 factory。File Tools 不再註冊 `grep`／`find`，留給宿主或 FFF override；原五行 grep 預覽包裝亦已移除。權限、activation 與 hook 仍由 Pi 負責，工具 annotations 只是提示，不是授權。

## 共通行為

- `read/write/edit` 路徑：相對路徑（相對 cwd）、絕對路徑、開頭 `@`、家目錄展開、`file://` URL。Windows 另接受 `/C/...`、`/mnt/C/...`、`/cygdrive/C/...`；格式錯誤的 URL 會被拒絕。開頭 `@` 沿用 Pi 路徑慣例：字面檔案已存在時優先使用，否則剝除 `@`（父目錄存在亦同）。建立字面 `@types/foo.d.ts` 請用 `./@types/foo.d.ts` 或絕對路徑，避免建立到 `types/`；此慣例未改變。
- `read/write/edit` schema 為 strict（不允許未宣告欄位）；`ls` 保留宿主 schema。選填欄位傳 `null` 等同省略；必填欄位仍拒絕 `null`。
- `read/write/edit` 檔案上限 50 MiB；文字須為合法 UTF-8（否則 `INVALID_ENCODING`）。
- 版本雜湊：32 字元 SHA-256 token（SHA-256 前 128 bit，十六進位），亦接受 64 字元完整 SHA-256。
- `read/write/edit` 對同一檔案的操作透過 Pi 的 file mutation queue 排序；搜尋／目錄工具沿用宿主唯讀行為，不提供多檔案快照一致性。
- `read/write/edit` 錯誤以例外拋出（`isError: true`），內容為 `[FILE_TOOL_ERROR]` JSON；TUI 僅調整顯示，不改變模型可見內容。

## TUI 顯示

`read`／`write` 呼叫沿用宿主 renderer；`read` 成功、syntax highlighting 與圖片附件亦保留宿主行為。`[FILE_TOOL_ERROR]` 由專用 renderer 顯示操作、錯誤碼、訊息及 recovery，展開可看路徑／行範圍，不原樣輸出錯誤 JSON。`write` 成功顯示寫入 bytes，展開顯示路徑與 SHA-256；`edit` 展開顯示完整 diff。兩者的 renderer 皆讀 `details`（結構化欄位），`write` 在宿主未提供 `details` 時退回解析文字（相容精簡單行與舊的多行 JSON）。三者共用錯誤 formatter。成功結果的模型文字已精簡（見下方各工具），完整資料只在 `details`；失敗輸出（`[FILE_TOOL_ERROR]`、錯誤碼、recovery）不縮減。

## `read`

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `path` | string（必填） | 檔案路徑 |
| `offset` | integer ≥ 1 | 起始行（1 基底） |
| `limit` | integer ≥ 1 | 最多回傳行數 |

- 輸出以單行 `[FILE_METADATA] {"path":...,"sha256":...}` 開頭，其後每行為 `<絕對行號>│<內容>`；前綴是中介資料，不可複製進 `edit.oldText`（此規則只在 `promptGuidelines`，結果不再附 `[LINE_PREFIX]` 說明行）。`sha256` 為版本 token。讀取整檔時只有 `path`、`sha256`；只讀部分範圍時另有 `lines`（`"起-迄"`，無輸出為 `"none"`）與 `total`（總行數）。完整的 `path`／`sha256`／`totalLines`／`lineStart`／`lineEnd`／`truncation` 仍在 `details`。
- 單次最多 2000 行／50 KiB；被截斷或受 `limit` 限制時附 `[READ_CONTINUATION] nextOffset=...; totalLines=...; reason=...`。過長而被略過的行以 `reason=oversized_line_skipped` 標示。
- 圖片（PNG／JPEG／GIF／WebP／BMP，以檔頭判斷）交由 Pi 內建圖片附件行為處理。以檔頭判斷不等於完整驗證圖片。
- 圖片委派給宿主 read 時帶入公開的有效設定 `images.autoResize`（`pi.getSettings()`，呼叫時讀取，預設 true，與宿主原生 read 一致）；provider 的 image limits 仍來自轉送的 `ctx.model`。回歸測試：`tests/image-autoresize.integration.test.mjs`（真實 Pi CLI，大型 PNG，autoResize true／false）。
- 同步 Pi 1.1.0 的 `outputSchema/structuredContent`：codemode `tools.read()` 在文字檔回傳相同的行號／metadata 字串；圖片回傳 `{ type: "image", data, mimeType, note }`，可直接 `image(await tools.read(...))`。模型 content／附件保留，不用 details 冒充結果。
- 若路徑不存在，且為 `<skill 目錄>/SKILL.md`，並唯一對應到已載入的 skill 檔，會自動更正為該路徑，並在輸出加入 `[SKILL_PATH_AUTO_CORRECTED]`。
- 背景 subagent 的 managed `subagent-sessions/<ULID 或舊 UUID>/runs/<taskId>/transcript.jsonl.partial` 若回報 `FILE_NOT_FOUND`，會檢查同目錄 `transcript.jsonl`：存在時僅指引明確改讀、不自動替換；兩者皆不存在時提示等待完成通知。權限／probe 錯誤保留，缺失不代表工作已完成。完成通知中的 conversation aggregate `logPath` 與 run-local 行數不同，不可沿用 offset。

```json
{ "path": "src/app.ts", "offset": 1, "limit": 200 }
```

## `ls`

- 同名工具執行委派 host `createLsToolDefinition`，使用 `ctx.cwd`，保留 schema、limits、renderer、取消與錯誤傳遞。
- 選填 `path/limit`；預設最多 500 entries／50 KiB，字母排序、目錄加 `/`、包含 dotfiles，不依 gitignore 過濾。
- `defaultActive:false`，不呼叫 `setActiveTools` 或修改 settings；選取／排除由 Pi 控制。選填 null 仍正規化為省略。
- `grep`／`find` 的參數、內容與 renderer 不再由 File Tools 包裝；FFF override 使用 FFF schema，非宿主 schema 的別名。

## `write`

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `path` | string（必填） | 檔案路徑；父目錄自動建立 |
| `content` | string（必填） | 完整 UTF-8 內容；空字串會清空檔案 |
| `expectedHash` | string | 最近一次 `read` 的版本 token，或 `"missing"`（路徑必須尚不存在） |

- 省略 `expectedHash` 為無條件覆寫，但提交前仍會重新驗證自己的初始快照。
- 新檔以不覆蓋的原子方式建立；既有檔以同目錄原子取代。
- 拒絕以符號連結為寫入目標（`SYMLINK_UNSUPPORTED`）。
- 成功回傳單行 `[FILE_WRITE_SUCCESS] {"sha256":...,"bytes":...}`；新建檔案才附 `"created":true`（預設值不輸出）。`details` 含 `path`、`sha256`、`bytes`、`created`。

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

- 提示詞精簡：regex／flags／`(?m)`／`replaceAll` 的完整規則只放在 `promptGuidelines`；tool description 僅一句用途，schema 欄位描述只保留型別與限制。`edit` 回傳的 `sha256After` 可直接作為下一次 `expectedHash`。`read` 的 `promptGuidelines` 不指定搜尋工具或要求使用 shell 搜尋，避免與其他已掛載工具的指引競爭。
- 錯誤 recovery 提示 shell：`read` 對目錄的 `FILE_NOT_READABLE` 指向 `ls`／`rg --files`；`INVALID_ENCODING` 指向 `xxd`／`iconv`；`[LINE_TOO_LARGE]` 行附 `sed -n 'Np' | cut -c`／`head -c` 提示。`TEXT_NOT_FOUND_IN_RANGE` 對 literal 與 regex 皆附 `candidateRanges` 與 `rangePreview`。
- regex 搭配 `lineRange` 時，視窗文字以獨立字串比對：`^`、`$`、lookbehind／lookahead 看不到視窗外的內容；需要整檔語意時請省略 `lineRange`。
- `read`／`edit`／`write` 只接受一般檔案；FIFO、裝置與目錄回報 `FILE_NOT_READABLE`／`FILE_NOT_WRITABLE`，不會阻塞。
- 新檔建立優先用 hard link 保證不覆蓋；檔案系統不支援時改用 exclusive create（`wx`）。寫入會 fsync、在 rename 前套用目標權限；暫存檔以固定長度短名稱（`.pi-ft-<ulid>.tmp`，與目標同目錄）建立，不受長檔名影響；rename 前會再比對雜湊並以 size／mtime／inode 做最後檢查（只縮小競態窗口，不取代雜湊）；Windows 上 rename 遇 EPERM／EBUSY／EACCES 會以有上限的 backoff 重試（共約 3 秒，每次重試前重新驗證雜湊）；失敗時盡力移除本次建立的空目錄。
- regex 的 1 秒預算從 worker 實際開始比對起算（不含 worker 啟動與大字串複製）。同一次 edit 的 regex 驗證重用一個 worker；連續相同搜尋範圍只傳文字一次，不同範圍仍以獨立字串比對。驗證結束（含失敗／取消）會終止 worker，不跨 edit 保留檔案內容。
- 未指定 `lineRange` 時為整檔比對，文字須唯一（除非 `replaceAll: true`）。
- `lineRange` 只是初始搜尋視窗，不是整行取代邊界。literal `oldText` 在視窗內找不到、但整檔恰有一處時，自動採用該處；整檔多處則 `AMBIGUOUS_MATCH` 並回報候選範圍。regex 沒有此回退。
- 所有 `edits` 皆對原始快照比對，不得重疊，全部驗證通過後才一次原子提交。
- 保留 BOM 與未修改處的 CRLF／LF 混用；取代結果若含孤立 surrogate 則 `INVALID_ARGUMENT`，檔案不變。
- `edits` 接受 JSON 字串或單一物件形式（會正規化為陣列）；頂層的 `oldText`／`regex`／`newText`／`lineRange`／`lineStart`／`lineEnd` 會被拒絕。
- 成功回傳單行 `[FILE_EDIT_SUCCESS] {"sha256After":...,"edits":N,"replacements":N,"added":N,"removed":N}` 與「精簡 diff」`[DIFF]`：只留 hunk，每個變更前後最多 1 行 context，單行最多 200 字元（超出附 `…[+N chars]`），最多 40 行（超出以 `… N more diff line(s) omitted` 一行取代）。`replacements` 僅在與 `edits` 不同時輸出，`added`／`removed` 為 0 時省略。`sha256After` 可直接作下一次 `expectedHash`。完整 `diff`、`patch`、`firstChangedLine`、`appliedEdits`、`matchedCount`、`changedCount`、`sha256Before`、`sha256After`、`changedRanges`、`added`、`removed` 只放在 `details`，供 renderer 使用，不進模型文字。

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
- 並行保證僅涵蓋參與 Pi file mutation queue 的工具；提交前重新驗證可縮小但無法消除與任意外部寫入者的競爭。完整內容雜湊檢查不會以 stat 取代；每次 rename 重試亦重新讀取、比對完整雜湊，再做最後 stat 檢查。
- 既有檔以 rename 取代會改變 inode／硬連結關係；僅盡力保留 mode，不保證保留 Windows ACL／其他檔案 metadata。這是原子取代的限制，不會改成非原子原地寫入。

## 錯誤碼

`INVALID_ARGUMENT`、`FILE_NOT_FOUND`、`FILE_NOT_READABLE`、`FILE_NOT_WRITABLE`、`INVALID_ENCODING`、`FILE_TOO_LARGE`、`SYMLINK_UNSUPPORTED`、`RANGE_OUT_OF_BOUNDS`、`TEXT_NOT_FOUND`、`TEXT_NOT_FOUND_IN_RANGE`、`AMBIGUOUS_MATCH`、`OVERLAPPING_EDITS`、`INVALID_REGEX`、`REGEX_TIMEOUT`、`OPERATION_TIMEOUT`、`TOO_MANY_MATCHES`、`RESULT_TOO_LARGE`、`STALE_FILE`、`FILE_ALREADY_EXISTS`、`NO_CHANGE`、`OPERATION_ABORTED`、`IO_ERROR`

## 設定

唯一設定鍵為 `pi-file-tools.debugLog`（boolean，預設 `false`），寫在 Pi 全域設定檔 `~/.pi/agent/settings.json`；若設定了 `PI_CODING_AGENT_DIR`，則為該目錄下的 `settings.json`。檔案不存在視為預設值；檔案無法讀取、JSON 無效、`pi-file-tools` 不是物件或 `debugLog` 不是 boolean 時，擴充仍會載入，改以 `debugLog: false` 運作並發出 `PI_FILE_TOOLS_SETTINGS` 警告（含設定檔路徑）。

```json
{
  "pi-file-tools": {
    "debugLog": true
  }
}
```

啟用後，失敗的 `read`／`write`／`edit`（含參數驗證失敗）會以 JSON Lines 附加到 `~/.pi/logs/pi-file-tools/YYYY-MM-DD.jsonl`，每筆含時間、工具、toolCallId、請求與結構化錯誤。請求中的 `content`、`oldText`、`newText`、`regex`、字串形式的 `edits` 及錯誤中的 `rangePreview`、`INVALID_REGEX` 診斷訊息（可能回顯 regex）只記錄長度與 SHA-256（`{ redacted, length, sha256 }`），不保留全文；超深無效請求的子樹會遮罩，不直接寫出未檢查的內容。路徑與其他欄位原樣保留，日誌無保留期限，請妥善保管。寫入日誌失敗不會遮蔽原始錯誤。

## 與 @ff-labs/pi-fff 的共存

File Tools 在 manifest 中先於 pi-fff 載入，但不再佔用 `grep`／`find`。全域 `<agentDir>/pi-fff.json` 設定 `{"mode":"override"}` 後，兩個搜尋工具由 FFF 提供；不修改第三方實作、版本或其他使用者設定。`/fff-mode override` 可切換目前 session 的模式，需 `/reload`，且不改全域檔案；已保存的 session mode 可優先於全域設定。若 resume 後仍非 override，先執行該命令再 reload，或建立新 session。FFF 預設的 tools-and-ui／tools-only 仍可用；不將所有使用者自動改為 override。

`tests/fff-override-conflict.integration.test.mjs` 已從 TODO 升為正式回歸：真實 Pi／manifest順序／原生 FFF，確認 startup 及 reload 的 provider、active/callable、別名停用與實際搜尋結果，無 fake finder。

pi-fff 0.11.0 上游缺陷以 `known-upstream` `todo` 測試保留（`tests/fff-aux-capacity.integration.test.mjs`：aux finder 並發超過 MAX_AUX；`tests/fff-shutdown-fence.integration.test.mjs`：shutdown 後才 resolve 的 finder 仍被發布且未 destroy）。這些測試使用 SDK 邊界的 fake finder，不載入原生 DLL。FFF 測試因 file-tools 模組 `test:integration` 為固定清單而不會被自動探索，需直接以 `node --import tsx --test modules/file-tools/tests/fff-*.integration.test.mjs` 執行。
