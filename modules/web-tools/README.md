# Web Tools

提供網頁抓取與網路搜尋工具：

- **`web_fetch`**：以 Playwright Chromium headless 渲染公開網頁，輸出清理後的 Markdown 或純文字。
- **`web_search`**：依 `provider` 設定分三種模式：
  - `openai`（預設）：只在 OpenAI 請求中注入原生 `web_search`，不註冊同名 function tool，也不處理 OpenAI 密鑰（由 Pi 管理）。
  - `brave`／`exa`：註冊自訂 `web_search` 工具，回傳來源與供應商 snippets，不呼叫摘要模型。
- **`/web-tools`** 指令：`status`、`sources`。

整合包需要 Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`（依根 manifest／jsdom 30）。安裝與跨平台驗證命令以[根 README](../../README.md)為準，請勿在模組目錄獨立安裝依賴。Chromium 不會在載入 extension 時下載或啟動，需以 `npm run browser:install` 明確安裝；`fetch.channel: "chrome"` 可改用本機 Google Chrome（不使用個人 profile）。瀏覽器在第一次 `web_fetch` 時才啟動。

## 設定

設定檔：`~/.pi/agent/web-search.json`（不隨 `PI_CODING_AGENT_DIR` 遷移）。可在啟動前以環境變數 `PI_WEB_TOOLS_CONFIG` 指定**絕對路徑**；空值或相對路徑視為非法，不回退。檔案不存在時採用預設值。設定只在 extension 載入時讀取，變更後需 `/reload`。不修改 Pi 的 `settings.json`／`auth.json`。

不接受未知欄位（包括 `$schema`）。非法設定會停用搜尋注入／註冊並顯示錯誤，`web_fetch` 仍以預設值運作；不會自動切換到其他供應商。範例見 `examples/web-search.json`，JSON Schema 見 `schemas/web_search.schema.json`（僅供編輯器關聯）。

| 鍵 | 預設 | 範圍／說明 |
| --- | --- | --- |
| `version` | `1` | 僅接受 `1` |
| `provider` | `"openai"` | `openai`／`brave`／`exa` |
| `enabled` | `true` | 只控制搜尋；`web_fetch` 不受影響 |
| `numResults` | `5` | 1–10，僅 REST 搜尋（Brave／Exa） |
| `searchTimeoutMs` | `60000` | 1000–120000，僅 REST 搜尋 |
| `providers.openai.experimentalCodex` | `false` | 允許對 legacy `openai-codex` 注入原生搜尋 |
| `providers.openai.captureSources` | `false` | 擷取原生搜尋來源紀錄（需 Pi 提供 `provider_stream_event`） |
| `providers.brave.apiKeyEnv` | `"BRAVE_API_KEY"` | 存放金鑰的環境變數名稱 |
| `providers.brave.apiKey` | — | 明文金鑰；與 `apiKeyEnv` 互斥 |
| `providers.exa.apiKeyEnv` | `"EXA_API_KEY"` | 同上 |
| `providers.exa.apiKey` | — | 同上 |
| `fetch.channel` | `"chromium"` | `chromium`／`chrome` |
| `fetch.timeoutMs` | `30000` | 1000–120000 |
| `fetch.maxConcurrency` | `2` | 1–4 |
| `fetch.idleTimeoutMs` | `60000` | 1000–300000，瀏覽器閒置回收 |

`apiKeyEnv` 須為合法環境變數名稱；`apiKey` 與 `apiKeyEnv` 不得同時設定，建議優先使用環境變數。不支援 shell command 型密鑰。錯誤訊息不含 HTTP 回應 body 或認證 headers。

### OpenAI 原生搜尋

```json
{ "provider": "openai", "enabled": true }
```

目前模型為下列 provider／API 時，於 `before_provider_request` 以追加方式加入 `tools: [{ "type": "web_search" }]` 與 `include: ["web_search_call.action.sources"]`（不刪除既有 tools／include、不改 `tool_choice`、不重複加入）：

| provider／API | 行為 |
| --- | --- |
| `openai`／`openai-responses` | 注入 |
| `azure-openai-responses` | 注入（部署需支援） |
| `openai-codex` | 預設不注入；`experimentalCodex: true` 時才注入，不保證後端接受 |
| virtual model、Claude、Gemini、Chat Completions、自訂 proxy | 不注入 |

若請求中已存在同名 `web_search` function tool，本模組會中止該請求並報錯，不刪除對方工具；請勿同時啟用其他提供 `web_search` 的 extension。切換到非 OpenAI 模型後原生搜尋即不可用；需跨模型一致搜尋請改用 Brave／Exa。

`captureSources: true` 時，將終結回應中的來源 URL／title／citation offsets 以 `pi-web-tools.native-sources` custom entry 存入 session（每筆最多 50 項、24 KiB，超過標示 truncated；URL 上限 2048 字元，title 上限 300 字元；拒絕非 HTTP(S) 或含帳密的 URL）。不保存 raw events、回應 body、搜尋 query 或 auth headers；取消／失敗的回答不保存。這些資料可能含敏感 URL，僅在需要時啟用。

### Brave／Exa

```json
{ "provider": "brave", "providers": { "brave": { "apiKeyEnv": "BRAVE_API_KEY" } } }
```

```json
{ "provider": "exa", "providers": { "exa": { "apiKeyEnv": "EXA_API_KEY" } } }
```

Brave 使用 Web Search endpoint；Exa 使用 Search endpoint（`type: "auto"`、highlights），不啟用生成答案。

### 診斷 log（選用）

專案名稱依宿主原生 cwd basename 正規化（NFKC、非安全字元換成 `_`、保留字加前綴）；POSIX 檔名中的反斜線不是 Windows 路徑分隔符。此契約不解析其他平台的路徑字串。

在 `~/.pi/agent/settings.json` 以目前工作目錄最後一層資料夾名稱正規化後為頂層 key，設定 `"debugLog": true`（必須為布林值 `true`）：

```json
{ "my-project": { "debugLog": true } }
```

`web_fetch`／REST `web_search` 執行丟出錯誤時，寫入 `~/.pi/logs/<project_name>/tool-errors-YYYY-MM-DD.jsonl`（時間、工具名、錯誤名稱／訊息／stack，並遮蔽常見 token／key／URL 憑證；不含工具參數與頁面／搜尋內容）。每個 project 每日上限 2 MiB，最多保留 7 個日期檔；POSIX 以 `0700`／`0600` 建立。寫入失敗不覆蓋原錯誤。

## 工具

### `web_fetch`

| 參數 | 必填 | 說明 |
| --- | --- | --- |
| `url` | 是 | 1–8192 字元 |
| `format` | 否 | `markdown`（預設）／`text` |
| `extraction` | 否 | `auto`／`main`／`body` |
| `waitForSelector` | 否 | CSS selector，1–500 字元；用於延遲渲染的頁面 |

```json
{ "url": "https://example.com/docs", "format": "markdown", "extraction": "auto", "waitForSelector": "main" }
```

- 等待 DOMContentLoaded 與有界限的內容就緒，不依賴 networkidle。
- 以 Readability 擷取正文，必要時回退 main／body，並回報實際使用的 extraction。
- 移除 script、導覽等非正文元素，保留程式碼、列表、表格與安全的絕對連結。
- 每次呼叫使用獨立 browser context，cookies／storage 不共用；browser 共用並於閒置後回收。取消只影響該次抓取，session shutdown／reload 時清理 browser。
- 回傳 title、最終 URL、HTTP status、取得時間與警告；不是 AI 摘要。
- HTTP 錯誤、不支援內容或空內容視為失敗。反爬與登入頁偵測僅為啟發式。
- 不處理 PDF、影音或下載；不登入、不繞過 CAPTCHA 或付費牆、不使用個人 cookies。

### `web_search`（僅 `brave`／`exa` 模式註冊）

| 參數 | 必填 | 說明 |
| --- | --- | --- |
| `query` | 是 | 1–2000 字元 |
| `provider` | 否 | `brave`／`exa`；省略時用設定值 |
| `numResults` | 否 | 1–10；省略時用設定值 |

```json
{ "query": "Playwright Chromium headless documentation", "provider": "brave", "numResults": 5 }
```

回傳每筆結果的 URL、title、供應商 snippet 與可取得的發布日期；全文請用 `web_fetch`。一次只查一個供應商，不跨供應商 fallback、不自動重試；429 時提示有限格式的 Retry-After；逾時或取消會中止 HTTP 請求。

## 指令

- `/web-tools status`：顯示設定路徑、目前模型的原生搜尋開關與未支援原因、REST 金鑰是否已設定（不顯示金鑰）、來源捕捉設定與 browser 初始化狀態；不發送網路探測。
- `/web-tools sources`：顯示目前 session branch 最近一筆原生搜尋來源紀錄。

無 UI 模式下輸出至 stderr，不污染 JSON stdout。

## 輸出限制

- 工具 content 上限 24 KiB／1000 行（含截斷提示）；頁面抽取內容上限 1 MiB，格式化結果 2 MiB，原始／渲染 HTML 5 MiB。
- 超長結果存於 OS temp 的 `pi-web-tools-*` 目錄並回傳絕對路徑，可用 `read` 分頁讀取；POSIX 檔案為 `0600`，Windows 依賴使用者 profile／temp 的 ACL。暫存檔不會在 shutdown 時刪除，亦可能被 OS 清理。
- 兩個工具宣告 `outputSchema`：`{ text, data?, dataOmitted, truncated, fullOutputPath? }`；structuredContent 超過 64 KiB 時省略 `data` 並設 `dataOmitted`。
- Playwright 會先緩衝網路回應再檢查大小，這些限制不是總流量或峰值記憶體上限。

## 安全行為與限制

- 只存取公開 HTTP(S)；預設阻擋私有、loopback、link-local 與 metadata 位址。初始 URL、redirect 與子資源皆檢查；拒絕內嵌帳密的 URL。此限制無法由設定關閉。
- 為逐跳驗證 redirect，網路請求經 Playwright context request 取回後交給 browser；部分重新導向子資源的相對 URL 語意可能與一般瀏覽不同。
- 不是完整安全沙箱：DNS 檢查與實際連線之間仍可能有競態，且 Chromium 會執行遠端 JavaScript；高敏感環境需以 OS／container 控制 egress。不適合作為公開或多租戶抓取服務。
- 頁面與搜尋內容是不可信的外部資料，清理 HTML 不能消除 prompt injection；網頁與搜尋結果會進入 Pi 對話並傳送給模型供應商。
- Pi 的 offline 設定不等於阻擋本模組的網路；如需阻擋請使用 OS／container 網路政策。
