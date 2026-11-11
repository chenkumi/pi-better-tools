# Image Generation

原生模組：一個 deferred 工具 `image_generate` 與 `/settings:image-generation`。依文字描述產生新圖片，存成專案內的新檔案並回報路徑。三個後端：OpenAI Images API、Gemini API、本機 Codex CLI。

- 預設不載入；用 `tool_search image` 載入（由 Pi Runtime 的 `deferred-tools.ts` 統一處理，本模組不自帶啟用或提示程式）。不是 `defaultActive`。
- Subagent child 不註冊此工具與指令；Fork child 會註冊，但沒有互動 UI 可確認付費請求（見「確認」）。
- 本模組不 import 其他 `modules/`；金鑰與設定都不進專案檔。

## 工具 `image_generate`

| 參數 | 說明 |
|---|---|
| `prompt` | 必填，≤ 32000 字元。完整描述（主體、風格、構圖、要顯示的文字）。 |
| `backend` | `openai`／`gemini`／`codex`，預設用設定的 `backend`；已停用的後端拒絕。 |
| `aspectRatio` | 如 `16:9`。OpenAI 接受 1:3–3:1；Gemini 依模型的固定清單；Codex 只當 prompt 提示。 |
| `resolution` | `1K`／`2K`／`4K`。OpenAI 換算成 `WxH`；Gemini 對應 `image_size`（2.5 Flash Image 沒有此參數）；Codex 只當提示。 |
| `quality` | 只有 OpenAI（`auto/low/medium/high/xhigh/max`，`xhigh`／`max` 只有 2.5 系列以上）。 |
| `format` | OpenAI：png／jpeg／webp。**Gemini 只回 JPEG**，Codex 存 PNG。 |
| `transparentBackground` | OpenAI（須 png／webp）與 Codex（提示）；Gemini 不支援。 |
| `count` | 1–10，預設 1，另受設定 `maxImages` 限制。OpenAI 用 `n`；Gemini／Codex 一張一次呼叫。 |

後端無法套用的選項會列在結果的 `ignored`，不是默默丟掉；值不合法則在送出前拒絕（不花錢）。結果 `details`：`backend`、`model`、`controls`（`api` 或 `prompt-hint`）、`files[]`（`path`、`bytes`、`sha256`、`mime`、`width`／`height`）、`ignored`、`notes`、`usage`、`requestId`、`elapsedMs`。內容只有文字（路徑、大小、雜湊前綴），不含 base64；設定 `inlinePreview: true` 才附第一張（≤ 4 MiB）圖片，因為圖片 token 昂貴，且 Pi Auto Compact 的折疊只保留文字。

不接受參考圖、遮罩或編輯；不接受使用者指定路徑或檔名。

### 輸出檔案

預設目錄 `<cwd>/.pi/generated-images/`（設定 `outputDir`，必須是專案內的相對路徑、不含 `..`）。檔名由系統產生：`IMG-<UTC 時間戳>-<序號>.<png|jpg|webp>`，以 `wx` 只新增、不覆寫（撞名加 `-2`…）。建立目錄時逐段 `lstat`，既有的連結或非目錄一律拒絕（不會被導出專案外）。位元組先以魔數驗證（不信任供應商宣稱的格式）；寫入失敗時移除本次已建立的檔案。

## 後端

| 後端 | 憑證 | 預設模型 | 輸出 |
|---|---|---|---|
| OpenAI | Pi 內 provider `openai` 的 **API key** | `gpt-image-2.6-sunburst` | `POST https://api.openai.com/v1/images/generations`，只讀 `b64_json` |
| Gemini | Pi 內 provider `google` 的 API key | `gemini-nano-banana-2.1` | `POST https://generativelanguage.googleapis.com/v1beta/interactions`，`response_format.mime_type` 固定 `image/jpeg` |
| Codex CLI | 本機 `codex login`（ChatGPT 登入） | Codex 預設 | `codex exec --json --ephemeral --skip-git-repo-check -s read-only -C <空暫存目錄>`，由 `thread_id` 找 `$CODEX_HOME/generated_images/<thread_id>/` |

- **金鑰只走 Pi 登入**：由 `ctx.modelRegistry` 在每次請求時解析，不讀專案檔、不存進本設定檔。OAuth 登入（例如 ChatGPT）不是 API key：先以 `isUsingOAuth` 判斷並拒絕，不會被刷新、也不會送到供應商 API。金鑰只放在請求標頭，不進 URL、結果、`details` 或錯誤訊息。Pi 自己解析 provider 認證時可能納入它支援的其他來源（例如環境變數）；本模組不另讀任何環境變數。
- **端點固定**，不接受使用者提供的 URL 或 baseUrl（測試以工廠參數注入假端點，不是設定鍵）。不跟轉址、絕對逾時、回應位元組上限 64 MiB（Gemini 的回應本體光是 `thought.signature` 就約 1 MB）。
- **不自動重試、後端之間不自動備援**：付費請求逾時或 5xx 時不知道供應商是否已計費；錯誤訊息明講「可能已被處理」。取消只取消本地請求，不代表供應商端已停止或不計費。
- **Codex**：在空的暫存目錄、唯讀沙箱下執行，環境變數用白名單（不傳 `OPENAI_API_KEY`／`CODEX_API_KEY`，避免意外改走 API 計價），stdin 關閉。這只縮小 Codex agent 能碰的範圍，**不是 sandbox**；取消／逾時只是要求行程結束（Windows 另以 `taskkill /T` 盡力），不代表整棵 process tree 已停止。用量算在 ChatGPT 方案額度，不能精確控制尺寸、品質與格式（只能寫進 prompt，結果標 `controls: "prompt-hint"`）。`codex.path` 不可是 `.cmd`／`.bat` shim（prompt 以參數傳入，不經 shell）；Windows 以 npm 安裝只有 `codex.cmd` 時，預設的 `codex` 會沿 PATH 找到該 shim，改以 `node <同目錄>
ode_modules@openaicodexincodex.js` 直接啟動（仍不經 shell）；其他安裝方式或目錄結構不同時不猜測，須把 `codex.path` 指到實際執行檔，找不到時錯誤訊息會提示。
- 供應商與 Codex 回傳的文字一律視為不受信任資料：截斷、清除控制字元後才顯示。

## 確認（付費請求）

設定 `confirm`：`first`（預設，每個 session、每個後端第一次詢問）、`always`、`never`。詢問用底部面板（`bottomConfirm`），內容含後端、模型、張數、prompt 長度與前 200 字、目的地與計費方式。所有不花錢就會失敗的檢查（設定、參數、輸出目錄、登入、Codex 是否安裝與已登入）都在詢問之前完成。

沒有互動 UI（例如 Fork child）且需要詢問時回 `IMAGE_CONFIRM_UNAVAILABLE`，不送出請求；要讓 Fork 能產生圖片，使用者須明確把 `confirm` 設為 `never`。

## 設定

`~/.pi/agent/image-generation.json`（可用 `PI_IMAGE_GENERATION_CONFIG` 覆寫路徑，測試用）。**只有使用者層**，不讀專案層。嚴格驗證、未知鍵報錯、錯誤訊息不回顯值；檔案不存在是預設值；每次呼叫重新讀取，存檔後不需 `/reload`。設定錯誤時工具回 `IMAGE_CONFIG_INVALID`，不退回其他後端。**沒有任何金鑰欄位。**

總開關 `enabled`（**預設 `false`**，要用須明確設為 `true`；改成 `true` 後需 `/reload` 才註冊工具）：`false` 時載入階段不註冊 `image_generate`（deferred 清單也看不到），只保留 `/settings:image-generation` 以便重新開啟；執行中改成 `false` 則之後的呼叫回 `IMAGE_BACKEND_DISABLED`。從「啟動時為 false」改回 `true` 需 `/reload`。各後端另有自己的 `enabled`。

```json
{
  "version": 1,
  "enabled": false,
  "backend": "openai",
  "confirm": "first",
  "outputDir": ".pi/generated-images",
  "maxImages": 4,
  "inlinePreview": false,
  "timeoutMs": 180000,
  "openai": { "enabled": true, "model": "gpt-image-2.6-sunburst", "quality": "auto", "format": "png" },
  "gemini": { "enabled": true, "model": "gemini-nano-banana-2.1", "resolution": "1K" },
  "codex": { "enabled": true, "path": "codex", "model": "（省略＝Codex 預設）", "timeoutMs": 300000 }
}
```

`/settings:image-generation`（共用 settings-panel）：General／OpenAI／Gemini／Codex 四頁；只在存檔時原子寫入、保留未改的鍵。各後端頁有「檢查」動作（Enter 執行）：OpenAI／Gemini 只回報 Pi 內有沒有 API key（絕不顯示或載入金鑰）、是否為 OAuth；Codex 執行 `codex login status`。模型 ID 不寫死成列舉（清單變動快），符合 `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` 即可。

## 錯誤碼

`IMAGE_CONFIG_INVALID`、`IMAGE_BACKEND_DISABLED`、`IMAGE_INVALID_ARGUMENT`、`IMAGE_AUTH_MISSING`、`IMAGE_AUTH_FAILED`、`IMAGE_CONFIRM_UNAVAILABLE`、`IMAGE_DECLINED`、`IMAGE_CODEX_MISSING`、`IMAGE_CODEX_FAILED`、`IMAGE_REQUEST_REJECTED`、`IMAGE_BLOCKED`、`IMAGE_RATE_LIMITED`、`IMAGE_PROVIDER_ERROR`、`IMAGE_NETWORK`、`IMAGE_TIMEOUT`、`IMAGE_CANCELLED`、`IMAGE_RESPONSE_TOO_LARGE`、`IMAGE_NO_OUTPUT`、`IMAGE_BAD_IMAGE`、`IMAGE_OUTPUT_DIR`（登記於 `shared/README.md`）。

## 實測紀錄（2026-11-11，使用者核准的真實呼叫；官方文件與實際行為的差異以實測為準）

- **Gemini**（`gemini-nano-banana-2.1`，Interactions API）：不帶 `Api-Revision` 即成功（約 20 秒，1024x1024 JPEG）。**`mime_type` 只接受 `image/jpeg`**（送 `image/png` 回 400，與官方文件範例不符）。回應 `steps[]` 含 `thought`（`signature` 約 1 MB）與 `model_output`（`content[]` 的 `image` 區塊 `data` 為 base64）。錯誤形狀 `{error:{message,code}}`。
- **OpenAI**（`gpt-image-2.6-sunburst`，`quality: low`，1024x1024，png）：約 12 秒、約 1 MB 回應；`data[].b64_json` 與 `generation_id`，無 `url`、無 `revised_prompt`；`usage` 為 input 22／output 824 tokens。`GET /v1/models` 對該 key 列出 2.6／2.5／2／1.5／1-mini 與 `chatgpt-image-latest`。錯誤為 `{error:{message,type:"image_generation_user_error",param,code:"invalid_value"}}`，`type` 同時涵蓋一般參數錯誤，所以分類以 `error.code`／HTTP 狀態為準。最小像素 655,360（例如 16:9 的 1K 是 1088x608 而不是 1024x576）。
- **Codex CLI 0.167.0**：`thread.started.thread_id` 就是 `$CODEX_HOME/generated_images/<thread_id>/` 的目錄名，檔名 `exec-<uuid>.png`；`--ephemeral` 與 `-s read-only` 下仍會存圖；`--json` 事件**不含圖片項目**，只有 agent_message、`turn.completed.usage`；啟動時的 `type:"error"` 項目只是 under-development 警告，不是失敗；stderr 會提示讀 stdin，所以 stdin 必須關閉。

### 未驗證

- 內容政策封鎖的實際形狀（OpenAI `moderation_blocked`、Gemini 安全封鎖）：不刻意送違規 prompt，以 HTTP 狀態與截斷後的 `error.message` 原樣呈現。
- OpenAI 2.5／2.6 以外模型、`xhigh`／`max` 品質、透明背景的實際結果；Gemini 其他模型（`gemini-3.1-flash-image`、`gemini-3-pro-image`、`gemini-2.5-flash-image`）；Gemini 的 `image_size` 4K。
- 透過真實 Pi host 載入此工具並由模型呼叫（本模組只有離線測試與上述直接 API 實測）。Pi 的憑證存放（`ctx.modelRegistry.isUsingOAuth`／`getProviderAuth`）以假物件測過，未在真實 host 內實測。
- Codex 在 Windows 以外平台、`codex` 為 `.cmd` shim 的情形（刻意拒絕）。
- 多於 1 張的 Gemini／Codex 實測（以假伺服器與假 `codex` 腳本測過流程）。

## 驗證

離線單元測試（`npm run test:module -- image-generation`）：假 HTTP 伺服器（請求形狀、金鑰只在標頭、回應解析、錯誤分類、不重試、回應上限、轉址、取消）、假 `codex` 腳本（登入檢查、參數、環境白名單、以 thread id 找檔、無圖／失敗／舊檔、取消）、存檔（只新增、連結拒絕）、確認流程（first／always／never、拒絕、無 UI、免費失敗先於詢問）、設定驗證與面板。不呼叫真實供應商、不使用真實 credentials。
