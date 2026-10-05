# Web Tools

提供網頁抓取與網路搜尋工具：

- **`web_fetch`**：以 Playwright Chromium headless 渲染公開網頁，輸出清理後的 Markdown 或純文字。
- **`web_search`**：依 `provider` 設定分三種模式：
  - `openai`（預設）：只在 OpenAI 請求中注入原生 `web_search`，不註冊同名 function tool，也不處理 OpenAI 密鑰（由 Pi 管理）。
  - `brave`／`exa`：註冊自訂 `web_search` 工具，回傳來源與供應商 snippets，不呼叫摘要模型。
- **`/web-tools`** 指令：`status`、`sources`。

整合包需要 Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`，依根 manifest 為準。Chromium 不會在載入 extension 時下載或啟動；在 package 根目錄執行 `npm run browser:install` 僅下載瀏覽器，Linux／WSL2 可明確執行 `npm run setup:browser` 一併安裝系統依賴（可能要求 sudo），或以 `npm run browser:install-deps` 單獨安裝系統依賴；`fetch.channel: "chrome"` 可改用本機 Google Chrome（不使用個人 profile）。瀏覽器在第一次 `web_fetch` 時才啟動。

安裝與跨平台驗證命令以[根 README](../../README.md)為準，請勿在模組目錄獨立安裝依賴。

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
| `openai-codex`／`openai-codex-responses` | 注入，無額外開關或實驗性警告（後端仍需支援） |
| virtual model、Claude、Gemini、Chat Completions、自訂 proxy | 不注入 |

若請求中已存在同名 `web_search` function tool，本模組會中止該請求並報錯，不刪除對方工具；請勿同時啟用其他提供 `web_search` 的 extension。切換到非 OpenAI 模型後原生搜尋即不可用；需跨模型一致搜尋請改用 Brave／Exa。

`captureSources: true` 時，將終結回應中的來源 URL／title／citation offsets 以 `pi-web-tools.native-sources` custom entry 存入 session（每筆最多 50 項、24 KiB，超過標示 truncated；URL 上限 2048 字元，title 上限 300 字元；拒絕非 HTTP(S) 或含帳密的 URL）。不保存 raw events、回應 body、搜尋 query 或 auth headers；取消／失敗的回答不保存。這些資料可能含敏感 URL，僅在需要時啟用。

`openai-codex` 使用相同的預設 OpenAI 搜尋設定，不需要額外 opt-in；本 extension 不顯示 Codex 實驗性警告。已移除 `providers.openai.experimentalCodex`，舊設定請刪除該欄位後 `/reload`（保留未知欄位拒絕規則）。設定錯誤與不支援模型的診斷仍保留；是否接受請求取決於實際後端及認證。

### Brave／Exa

```json
{ "provider": "brave", "providers": { "brave": { "apiKeyEnv": "BRAVE_API_KEY" } } }
```

```json
{ "provider": "exa", "providers": { "exa": { "apiKeyEnv": "EXA_API_KEY" } } }
```

Brave 使用 Web Search endpoint；Exa 使用 Search endpoint（`type: "auto"`、highlights），不啟用生成答案。

### 診斷 log（選用）

在 `~/.pi/agent/settings.json` 以目前工作目錄最後一層資料夾名稱為頂層 key（明確的 Windows 絕對磁碟／UNC 路徑跨平台解析，其餘路徑依宿主語意；名稱正規化為安全字元），設定 `"debugLog": true`（必須為布林值 `true`）：

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
- 回傳 title、URL、HTTP status 與警告（模型可見文字不含取得時間，仍在 data）；不是 AI 摘要。`Final URL` 行僅在與請求 URL 不同時顯示（`data.finalUrl` 永遠保留）。
- 錯誤訊息附下一步提示（仍不含 Playwright log、headers 或 DNS 細節）：`BROWSER_UNAVAILABLE` 指示執行 `npm run browser:install` 且不要重試；`NETWORK_BLOCKED` 說明私有／本機位址不可抓、請改用公開 URL；`TIMEOUT` 建議調整 `waitForSelector` 或換頁；`UNSUPPORTED_CONTENT`（PDF、下載等）建議改找 HTML 版本。
- HTTP 錯誤、不支援內容或空內容視為失敗。反爬與登入頁偵測僅為啟發式。
- 不處理 PDF、影音或下載；不登入、不繞過 CAPTCHA 或付費牆、不使用個人 cookies。

### `web_search`（僅 `brave`／`exa` 模式註冊）

| 參數 | 必填 | 說明 |
| --- | --- | --- |
| `query` | 是 | 1–2000 字元 |
| `numResults` | 否 | 1–10；省略時用設定值 |

```json
{ "query": "Playwright Chromium headless documentation", "numResults": 5 }
```

回傳每筆結果的 URL、title、供應商 snippet 與可取得的發布日期；全文請用 `web_fetch`。無結果時提示改寫關鍵字。工具 description 於註冊時依設定寫明實際 provider（Brave 或 Exa）；schema 無 `provider` 欄位（由設定決定），舊呼叫帶入的 `provider` 會在 `prepareArguments` 丟棄。模型可見文字不含 Provider 行，snippet 每筆最多 600 字元（`data`／`structuredContent` 保留完整內容與 provider）。`promptGuidelines` 要求回答附來源 URL、以 `web_fetch` 讀最相關 1~3 筆、不僅憑 snippet 下結論，並附 query 語法提示。一次只查一個供應商，不跨供應商 fallback、不自動重試；429 時提示有限格式的 Retry-After；逾時或取消會中止 HTTP 請求。

## 指令

- `/web-tools status`：顯示設定路徑、目前模型的原生搜尋開關與未支援原因、REST 金鑰是否已設定（不顯示金鑰）、來源捕捉設定與 browser 初始化狀態；不發送網路探測。
- `/web-tools sources`：顯示目前 session branch 最近一筆原生搜尋來源紀錄。

無 UI 模式下輸出至 stderr，不污染 JSON stdout。

## TUI 顯示

`web_fetch` 與 REST `web_search` 有專用 call/result renderer：收合顯示網頁／搜尋來源摘要、HTTP／provider 資訊、警告、截斷及全文暫存路徑，展開顯示原有結果文字。來源標為不可信外部資料；URL 標籤移除 userinfo，顯示文字清理控制字元（不代表全面敏感資料遮蔽）。Renderer 不啟動 browser、不發送 provider 請求，亦不改 content／details／structuredContent。OpenAI 原生 `web_search` 不屬於 Pi function tool，由宿主／模型回應呈現。

## 輸出限制

- 工具 content 上限 24 KiB／1000 行（含截斷提示）；頁面抽取內容超過 1 MiB 時截斷並加上警告（不再失敗），格式化結果 2 MiB，原始／渲染 HTML 5 MiB；每個代理回應（含子資源）以 content-length 與實際 body 大小限制 10 MiB，超過即阻擋；media／font 子資源不抓取。Playwright 會先在 Node 緩衝完整 body，此上限限制交給瀏覽器的內容，不是傳輸期間的記憶體峰值。
- 超長結果存於 OS temp 的 `pi-web-tools-*` 目錄並回傳絕對路徑，可用 `read` 分頁讀取；POSIX 檔案為 `0600`，Windows 依賴使用者 profile／temp 的 ACL。暫存檔不會在 shutdown 時刪除，亦可能被 OS 清理。
- 兩個工具宣告 `outputSchema`：`{ text, data?, dataOmitted, truncated, fullOutputPath? }`；structuredContent 超過 64 KiB 時省略 `data` 並設 `dataOmitted`。
- Playwright 會先緩衝網路回應再檢查大小，這些限制不是總流量或峰值記憶體上限。

## 安全行為與限制

- 只存取公開 HTTP(S)；預設阻擋私有、loopback、link-local 與 metadata 位址。初始 URL、redirect 與子資源皆檢查；拒絕內嵌帳密的 URL。此限制無法由設定關閉。
- `web_search` 已無 `provider` 參數；provider 僅由設定決定，舊呼叫帶入的值會被丟棄，不能繞過已設定的單一 provider。設定為 OpenAI 時 REST 搜尋仍回傳 PROVIDER_UNSUPPORTED。
- 主頁面 redirect 以 abort 後重新 goto 處理，redirect 回應上的 Set-Cookie 不會寫入 browser cookie jar（已知限制）；子資源 redirect 同樣由 Node 端手動追蹤。
- context 關閉設有 5 秒上限，逾時仍會釋放佇列名額，瀏覽器由 idle／shutdown 清理。
- 為逐跳驗證 redirect，網路請求經 Playwright context request 取回後交給 browser；部分重新導向子資源的相對 URL 語意可能與一般瀏覽不同。
- 不是完整安全沙箱：DNS 檢查與實際連線之間仍有 DNS rebinding 競態（Playwright `route.fetch` 不提供固定已驗證 IP 的連線選項，因此未實作 IP pinning），且 Chromium 會執行遠端 JavaScript；高敏感環境需以 OS／container 控制 egress。不適合作為公開或多租戶抓取服務。
- 頁面與搜尋內容是不可信的外部資料，清理 HTML 不能消除 prompt injection；網頁與搜尋結果會進入 Pi 對話並傳送給模型供應商。
- Pi 的 offline 設定不等於阻擋本模組的網路；如需阻擋請使用 OS／container 網路政策。
