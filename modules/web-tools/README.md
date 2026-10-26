# Web Tools

提供網頁抓取與網路搜尋工具：

- **`web_fetch`**：優先以 Playwright Chromium headless 渲染公開網頁；所選瀏覽器 executable 明確缺少時改用靜態 HTTP，兩者共用正文抽取並輸出清理後的 Markdown 或純文字。
- **`web_search`**：依 `provider` 設定分兩種模式：
  - `openai`（預設）／`native`：注入目前模型自己的原生搜尋（hosted search），不註冊同名 function tool，也不處理供應商密鑰（由 Pi 管理）。`openai` 僅限 OpenAI 家族 API（行為與舊版相同）；`native` 另外支援 Pi `google` provider 的 Gemini 3／4 系列（`googleSearch` grounding）與 Pi `anthropic` provider 的 Claude（`web_search_20250305`），其餘模型維持 inactive 警告。
  - `brave`／`exa`／`deepseek`：註冊自訂 `web_search` 工具，回傳來源與供應商 snippets，不呼叫摘要模型。
- **`/web-tools`** 指令：`status`、`sources`。

整合包需要 Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`，依根 manifest 為準。Chromium 不會在安裝套件或載入 extension 時下載；瀏覽器在第一次 `web_fetch` 時才嘗試啟動。發布後使用套件 CLI `pi-better-tools doctor` 唯讀診斷、`pi-better-tools browser install` 僅下載 Chromium、`pi-better-tools browser install-deps` 明確安裝 Linux／WSL2 系統依賴（可能要求 sudo，須使用者同意）。只在 PATH 的 bin 對應此安裝實例時使用短命令；否則複製診斷提供的目前 Node＋`setup/cli.mjs` 絕對路徑命令，不依 cwd，也不以 npx 安裝另一版 Playwright。安裝與執行 Pi 使用同一使用者及 `PLAYWRIGHT_BROWSERS_PATH`。`fetch.channel: "chrome"` 明確選擇本機 Google Chrome（不使用個人 profile）；Chromium 安裝命令不安裝 Chrome 或改設定。

Repository 的 `npm run browser:install`、`browser:install-deps`、`setup:browser` 保留為同一 CLI 的開發別名。完整安裝後操作也收錄於內建 `/skill:pi-tools-config` 的 Web reference，不要求 repository 或全域 bin 存在。

安裝與跨平台驗證命令以[根 README](../../README.md)為準，請勿在模組目錄獨立安裝依賴。

來源保留的 `scripts/compat.mjs` 是歷史相容性流程，不是整合包的受支援 host matrix；本專案僅驗證 Pi 1.1.0，不執行它安裝舊 host。其清理路徑會分別保留驗證／暫存刪除／manifest 完整性錯誤；即使刪除失敗仍檢查 checksum，多個失敗以 `AggregateError` 回報，全部成功才輸出 PASS。根 `tests/unit/cleanup-arbitration.test.mjs` 以無 I/O、無安裝的替身驗證實際 script body，不代表舊 host 相容性通過。

## 設定

設定檔：`~/.pi/agent/web-search.json`（不隨 `PI_CODING_AGENT_DIR` 遷移）。可在啟動前以環境變數 `PI_WEB_TOOLS_CONFIG` 指定**絕對路徑**；空值或相對路徑視為非法，不回退。檔案不存在時採用預設值。設定只在 extension 載入時讀取，變更後需 `/reload`。不修改 Pi 的 `settings.json`／`auth.json`。

不接受未知欄位（包括 `$schema`）。非法設定會停用搜尋注入／註冊並顯示錯誤，`web_fetch` 仍以預設值運作；不會自動切換到其他供應商。範例見 `examples/web-search.json`，JSON Schema 見 `schemas/web_search.schema.json`（僅供編輯器關聯）。

| 鍵 | 預設 | 範圍／說明 |
| --- | --- | --- |
| `version` | `1` | 僅接受 `1` |
| `provider` | `"openai"` | `openai`（僅 OpenAI 家族原生搜尋）／`native`（依模型 API 選原生搜尋：OpenAI 家族、Gemini 3／4、Anthropic）／`brave`／`exa`／`deepseek` |
| `enabled` | `true` | 只控制搜尋；`web_fetch` 不受影響 |
| `numResults` | `5` | 1–10，僅 REST 搜尋（Brave／Exa／DeepSeek） |
| `searchTimeoutMs` | `60000` | 1000–120000，僅 REST 搜尋 |
| `providers.openai.captureSources` | `false` | 擷取原生搜尋來源紀錄（需 Pi 提供 `provider_stream_event`） |
| `providers.google.captureSources` | `false` | 擷取 Gemini grounding 來源紀錄；同樣 opt-in，且只在 `provider: "native"` 下生效 |
| `providers.brave.apiKeyEnv` | `"BRAVE_API_KEY"` | 存放金鑰的環境變數名稱 |
| `providers.brave.apiKey` | — | 明文金鑰；與 `apiKeyEnv` 互斥 |
| `providers.exa.apiKeyEnv` | `"EXA_API_KEY"` | 同上 |
| `providers.exa.apiKey` | — | 同上 |
| `providers.deepseek.apiKeyEnv` | — | 同上；未設定 `apiKey`／`apiKeyEnv` 時改用 Pi 的 `deepseek` 登入憑證 |
| `providers.deepseek.apiKey` | — | 明文金鑰；與 `apiKeyEnv` 互斥；此值優先於 Pi 登入 |
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

### Gemini／Anthropic 原生搜尋（`provider: "native"`）

```json
{ "provider": "native" }
```

`native` 保留 `openai` 的全部行為，另外對 **Pi `google` provider 的 `gemini-3`／`gemini-4` 系列**（例如 `gemini-3-pro`、`gemini-4-argon`）注入 Gemini 的伺服器端 Google Search：在 `config.tools` 追加 `{ "googleSearch": {} }`，並設 `config.toolConfig.includeServerSideToolInvocations: true`。兩者都是 Gemini 3 起「內建工具與 function calling 併用」的必要條件。

- 注入的鍵必須是 camelCase：Pi 的 `@google/genai` 只把已知欄位映到 request body，寫成 `google_search` 或頂層 `tools` 會被默默丟掉。
- 真實 API 實測（2026-10-17）：`gemini-3.8-flash`／`gemini-4-argon` 帶 `googleSearch` + function declarations 均回 200，未被拒。模型**自己決定是否搜尋**：`gemini-4-argon` 那次有觸發（`provider_stream_event` 可看到 `groundingMetadata.webSearchQueries` 與 `groundingChunks`），`gemini-3.8-flash` 那次沒觸發，所以「請求沒 400」**不**等於「有搜尋」。有觸發時模型會寫出 `vertexaisearch.cloud.google.com/grounding-api-redirect/...` 轉址 URL，而不是來源網站原 URL。
- Gemini 2.5／2.0 不注入（官方只保證 Gemini 3 以後能與 function declarations 併用），`google-vertex` 也不注入（Vertex 不支援混用，且 SDK 對上述 flag 直接報錯）。兩者都會顯示 inactive 原因。
- 用法同 OpenAI 原生搜尋：不註冊 `web_search` tool、不碰 Gemini 密鑰。若另一 extension 以 client tool 形式提供 `web_search` function declaration，會中止該請求並報 `TOOL_CONFLICT`，不默默移除對方工具。
- 來源：Pi 目前不解碼 `groundingMetadata`／`url_citation`，所以模型看不到來源物件；指引文字因此要求把完整 URL 寫進回答。需要可靠來源清單時仍請用 `provider: "native"` 以外的 REST 供應商。

**Anthropic（`anthropic-messages`）**：對 Pi `anthropic` provider 注入 `{"type":"web_search_20250305","name":"web_search","max_uses":8}`。Anthropic 不相容端點（例如 `kimi-coding` 或自訂 proxy）預設不注入，因為沒實測，只顯示 inactive 原因。

- Pi 1.4.0 會丟棄回應中的 `server_tool_use`／`web_search_tool_result` 與 citations。真實 API 實測（`plan/PLAN-20261017T153936832Z.md` Step 4）：後續輪次缺少這些 block 的歷史 **會被接受（200）**，只失去「檢索上下文還原」與來源顯示；保留 block 卻移除 `encrypted_content` 才回 400。因為連線不會被弄壞，本模組不需要 block replay。
- 代價是模型看不到來源物件，因此指引要求回答自行寫出完整 URL；`pause_turn` 的續傳仍未實測。
- **來源捕捉（opt-in）**：`providers.google.captureSources: true` 時，`provider_stream_event` 上的 `groundingMetadata` 會寫成與 OpenAI 同一種 `pi-web-tools.native-sources` entry（來源與 citation offsets，上限 50 項／24 KiB），可用 `/web-tools sources` 檢視。只複製 `groundingChunks[].web.uri/title` 與 `groundingSupports[].segment` 的 offsets；搜尋 query、答案文字與 `searchEntryPoint` HTML 不落地。grounding 的 URL 通常是 `vertexaisearch.cloud.google.com/grounding-api-redirect/...` 轉址，捕捉不做 follow-redirect（不在 event 裡發隱藏網路請求），所以原站只能從 chunk 的 title（通常是來源網域）推測；grounding 沒觸發就沒有紀錄。

### Brave／Exa／DeepSeek

```json
{ "provider": "brave", "providers": { "brave": { "apiKeyEnv": "BRAVE_API_KEY" } } }
```

```json
{ "provider": "exa", "providers": { "exa": { "apiKeyEnv": "EXA_API_KEY" } } }
```

```json
{ "provider": "deepseek" }
```

Brave 使用 Web Search endpoint；Exa 使用 Search endpoint（`type: "auto"`、highlights），不啟用生成答案；DeepSeek 使用官方 standalone `POST https://api.deepseek.com/v1/tools/search`（`{ query, count }`、Bearer 認證），結果的 `snippet`／`summary` 對應工具輸出，`date` 對應 `publishedAt`。

DeepSeek 憑證解析順序：設定裡的 `providers.deepseek.apiKey`／`apiKeyEnv`（若明確設定）→ Pi 的 `deepseek` provider 登入憑證（`/login`，含 `DEEPSEEK_API_KEY` 等環境變數來源）→ `AUTH_REQUIRED`。因此已登入 DeepSeek 的人不需在設定裡再放金鑰。計費為官方 standalone API 價（每次成功請求 $0.75/1000）；本模組不顯示或查詢帳單。

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

- 瀏覽器路徑等待 DOMContentLoaded 與有界限的內容就緒，不依賴 networkidle。
- HTTP 相容模式只在啟動診斷確認 executable 缺少時使用，回報靜態內容警告，不執行 JavaScript、不載入子資源／cookie、不追蹤 meta refresh；不是 CAPTCHA／網站錯誤的繞過方式。`waitForSelector` 需要 browser，缺少時明確失敗，不靜默忽略。兩模式共用同一 queue、總 deadline、AbortSignal 與抽取 worker，不永久快取啟動失敗、不重設 timeout；也不修復 npm playwright 套件遺失。
- 以 Readability 擷取正文，必要時回退 main／body，並回報實際使用的 extraction。JSDOM／Readability 解析在可終止的 worker thread（`src/fetch/extract-worker.mjs`，1 GiB heap 上限）內執行，不阻塞主執行緒；取消、逾時或 shutdown 時直接 terminate worker；完成的 worker 最多保留 2 個、閒置 30 秒後回收（冷啟動載入 jsdom 約需數秒，首次 fetch 時與瀏覽器啟動並行預熱）。HTML 位元組上限在送進 worker 前亦檢查；活動 worker 保持 Node event loop 存活，只有閒置 worker 才 unref；啟動／執行失敗與退出均移出 pool，重用時保留生命週期監聽器並清除單次 job 監聽器。活動／閒置／終止中的 worker 合計最多 6 個，取消不先釋放名額，必須等實際 exit 或 terminate 完成；名額滿時回報 BUSY。shutdown 會停止新 worker、終止並等待所有活動／閒置／終止中的 worker；若終止失敗，不假裝 worker 已退出或提前重用其名額。
- 移除 script、導覽等非正文元素，保留程式碼、列表、表格與安全的絕對連結。
- 每次呼叫使用獨立 browser context，cookies／storage 不共用；browser 共用並於閒置後回收。取消只影響該次抓取，session shutdown／reload 時清理 browser。
- 回傳 title、URL、HTTP status 與警告（模型可見文字不含取得時間，仍在 data）；不是 AI 摘要。`Final URL` 行僅在與請求 URL 不同時顯示（`data.finalUrl` 永遠保留）。
- 錯誤訊息附下一步提示（仍不含 Playwright log、headers 或 DNS 細節）：`BROWSER_UNAVAILABLE` 保留錯誤碼，依已知啟動診斷分類：Playwright executable 缺少且要求 selector 時提示以相同使用者／browser cache 環境執行此安裝實例的 `browser install` CLI；Chrome executable 缺少時提示安裝 Google Chrome，或請使用者改用 Chromium 並安裝（訊息不寫設定鍵）；系統依賴缺失時提示 Linux／WSL 經使用者同意執行此安裝實例的 `browser install-deps` CLI；權限拒絕時檢查 executable／cache 權限與 OS 安全政策；啟動逾時時檢查負載／啟動限制，並請使用者調高抓取時限（訊息不寫設定鍵）；其他失敗只回報啟動失敗、未確認瀏覽器缺失。依分類檢查後才重試，不一律要求重裝或開新 session。整體 fetch deadline 仍優先回報既有 `TIMEOUT`；`NETWORK_BLOCKED` 說明私有／本機位址不可抓、請改用公開 URL；`TIMEOUT` 建議調整 `waitForSelector` 或換頁；`UNSUPPORTED_CONTENT`（PDF、下載等）建議改找 HTML 版本。
- HTTP 錯誤、不支援內容或空內容視為失敗。HTTP 相容路徑要求明確的 `text/html`、`application/xhtml+xml` 或 `text/plain` Content-Type；缺少 header 也拒絕，不做內容 sniffing（比 browser 路徑保守）。Plain text 先 escape 後抽取，BOM／HTTP charset／HTML early meta charset 依序解析；未知 charset 拒絕。反爬與登入頁偵測僅為啟發式。
- 不處理 PDF、影音或下載；不登入、不繞過 CAPTCHA 或付費牆、不使用個人 cookies。

### `web_search`（僅 `brave`／`exa`／`deepseek` 模式註冊）

| 參數 | 必填 | 說明 |
| --- | --- | --- |
| `query` | 是 | 1–2000 字元 |
| `numResults` | 否 | 1–10；省略時用設定值 |

```json
{ "query": "Playwright Chromium headless documentation", "numResults": 5 }
```

回傳每筆結果的 URL、title、供應商 snippet 與可取得的發布日期；全文請用 `web_fetch`。無結果時提示改寫關鍵字。工具 description 於註冊時依設定寫明實際 provider（Brave／Exa／DeepSeek）；schema 無 `provider` 欄位（由設定決定），舊呼叫帶入的 `provider` 會在 `prepareArguments` 丟棄。模型可見文字不含 Provider 行，snippet 每筆最多 600 字元（`data`／`structuredContent` 保留完整內容與 provider）。`promptGuidelines` 要求回答附來源 URL、以 `web_fetch` 讀最相關 1~3 筆、不僅憑 snippet 下結論，並附 query 語法提示。一次只查一個供應商，不跨供應商 fallback、不自動重試；429 時提示有限格式的 Retry-After；逾時或取消會中止 HTTP 請求。

## 指令

- `/web-tools status`：顯示設定路徑、目前模型的原生搜尋開關與未支援原因（含 Gemini 2.x／Vertex／Anthropic 等具體原因）、REST 金鑰是否已設定（含 DeepSeek 是 `pi-managed` 或 `missing`，不顯示金鑰）、兩個 `captureSources` flag 與對應的來源解碼狀態、browser 初始化狀態；不發送網路探測。
- `/web-tools sources`：顯示目前 session branch 最近一筆原生搜尋來源紀錄（OpenAI 原生搜尋與 Gemini grounding 共用同一種 entry）。

無 UI 模式下輸出至 stderr，不污染 JSON stdout。

## TUI 顯示

`web_fetch` 與 REST `web_search` 有專用 call/result renderer：收合顯示網頁／搜尋來源摘要、HTTP／provider 資訊、警告、截斷及全文暫存路徑，展開顯示原有結果文字。來源標為不可信外部資料；URL 標籤移除 userinfo，顯示文字清理控制字元（不代表全面敏感資料遮蔽）。Renderer 不啟動 browser、不發送 provider 請求，亦不改 content／details／structuredContent。OpenAI 原生 `web_search` 不屬於 Pi function tool，由宿主／模型回應呈現。

## 輸出限制

- 工具 content 上限 24 KiB／1000 行（含截斷提示）；頁面抽取內容超過 1 MiB 時截斷並加上警告（不再失敗），格式化結果 2 MiB，原始／渲染 HTML 5 MiB；瀏覽器路徑的每個代理回應（含子資源）在讀取時以有界串流限制 10 MiB（主文件 5 MiB），wire（壓縮後）與解壓後大小各自限制，超過即中止讀取並阻擋；每次 fetch 的子資源另有上限 200 個請求、累計解壓後 32 MiB（含進行中的位元組），超過的子資源被阻擋並加警告；media／font／image／stylesheet 子資源不抓取（直接 abort；抽取不渲染也不套用 CSS）。瀏覽器路徑不再使用 Playwright `route.fetch`（它會無上限緩衝並解壓整個 body；約 0.4 MiB 的 gzip 可使宿主 RSS 增加約 900 MiB），改由 `src/fetch/bounded.ts` 的 Node http(s) 有界串流取得，再以 `route.fulfill` 交給瀏覽器；解壓後 body 會移除 content-encoding／content-length。支援 gzip／deflate／br，其他 content-encoding 回報 `UNSUPPORTED_CONTENT`。
- 超長結果存於 OS temp 的 `pi-web-tools-*` 目錄並回傳絕對路徑，可用 `read` 分頁讀取；POSIX 檔案為 `0600`，Windows 依賴使用者 profile／temp 的 ACL。暫存目錄不會在 shutdown 時刪除；之後產生新輸出時，最多每 10 分鐘一次、最多檢查 512 個項目，順便移除超過 24 小時的 `pi-web-tools-*` 目錄（best effort，失敗不影響結果），亦可能被 OS 清理。
- 兩個工具宣告 `outputSchema`：`{ text, data?, dataOmitted, truncated, fullOutputPath? }`；structuredContent 超過 64 KiB 時省略 `data` 並設 `dataOmitted`。`web_search` 的 `data.provider` 由 REST provider 清單產生（`brave`／`exa`／`deepseek`），2026-10-23 修正前 schema 漏列 `deepseek`。
- 位元組上限在讀取／解壓過程中強制執行，單一回應的緩衝峰值約為上限加一個 chunk；同一次 fetch 的子資源以累計預算限制總緩衝；每個子資源請求（含其 redirect 鏈的每一跳）都計入同一個 200 請求上限。這仍不是總流量上限（同時進行中的請求、被中止前已收到的 wire 位元組不計入保證），也不是 OS 層資源隔離。
- HTTP 相容路徑分別在 wire／解壓後串流限制 5 MiB，decoded HTML 亦限制 5 MiB；支援 gzip／deflate／br。超限或取消會銷毀串流並等待本機 request close，不表示遠端處理已停止。

## 安全行為與限制

- 只存取公開 HTTP(S)；預設阻擋私有、loopback、link-local 與 metadata 位址。初始 URL、redirect 與子資源皆檢查；拒絕內嵌帳密的 URL。此限制無法由設定關閉。
- `web_search` 已無 `provider` 參數；provider 僅由設定決定，舊呼叫帶入的值會被丟棄，不能繞過已設定的單一 provider。設定為 `openai`／`native` 時 REST 搜尋不註冊，直接呼叫會回傳 PROVIDER_UNSUPPORTED。
- 主頁面 redirect 以 abort 後重新 goto 處理，redirect 回應上的 Set-Cookie 不會寫入 browser cookie jar（已知限制）；子資源 redirect 同樣由 Node 端手動追蹤。
- context 關閉設有 5 秒上限，逾時仍會釋放佇列名額，瀏覽器由 idle／shutdown 清理。
- 為逐跳驗證 redirect，網路請求由有界 Node 傳輸取回（Cookie 取自該 context 的隔離 cookie jar；redirect 跳點的 Set-Cookie 以盡力解析寫回該 jar，最終回應的 Set-Cookie 由 `route.fulfill` 交給 Chromium）後交給 browser；部分重新導向子資源的相對 URL 語意可能與一般瀏覽不同。
- HTTP 相容路徑以 Node HTTP(S) 逐跳檢查 URL／所有 DNS 位址並綁定已核可 IP；保留原 hostname 的 Host／SNI／TLS 憑證驗證，不修改全域 dispatcher 或自動使用代理。僅 GET，串流限制傳輸與解壓後內容，取消會關閉 request／response。此路徑的 pinning 不代表下面的瀏覽器限制已修復，也不是 OS sandbox。
- 瀏覽器路徑不是完整安全沙箱：DNS 檢查與實際連線各自解析，仍有 DNS rebinding 競態。有界傳輸仍沿用 DNS 預檢加一般連線（未釘住 IP），因此未實作 IP pinning；已加入事後緩解：每個回應在讀取 body 並交給瀏覽器前，以 socket 的 `remoteAddress` 檢查實際連線的對端位址，非公開或缺少位址即 fail closed（`NETWORK_BLOCKED`），每個 redirect 跳點都檢查。此緩解只能阻止回應內容被使用，惡意 DNS 仍可能讓請求本身已送達內部位址（盲 SSRF，例如帶副作用的 GET/POST）；完整防護仍需 OS／container egress 控制。同一次 fetch 內每個 hostname 僅做一次 DNS 檢查（結果含失敗皆快取），實際連線位址則逐回應檢查，且 Chromium 會執行遠端 JavaScript；高敏感環境需以 OS／container 控制 egress。不適合作為公開或多租戶抓取服務。
  R04 回歸：`tests/integration/fetch.test.ts` 鎖定現況（盲請求仍送達、僅阻止回應使用），「私有目標零請求」以 `todo` 記錄，不使 CI 變紅。
- 頁面與搜尋內容是不可信的外部資料，清理 HTML 不能消除 prompt injection；網頁與搜尋結果會進入 Pi 對話並傳送給模型供應商。
- Pi 的 offline 設定不等於阻擋本模組的網路；如需阻擋請使用 OS／container 網路政策。

## Error messages

Failure responses name the parameter or host, the cause category and the fix, and never include upstream bodies, headers or keys (2026-10-24 guidance pass; see plan/error-message-handoff.md).
- When the web-search configuration is invalid, `web_search` stays unregistered and `web_fetch` guidelines carry one line with the bounded rule and how to fix it (`/reload`); no unselected tool is enabled.
- `waitForSelector` accepts 1 to 500 characters (schema and runtime agree); timeout messages state the actual deadline in seconds and ask the user to raise the fetch time limit, without naming the settings key. Messages that reach the agent never name settings keys, environment variables or the settings file path (for example a missing search API key asks the user to set "a valid <provider> search service API key in the web tools configuration"); an invalid configuration is reported to the agent only as the error code plus a generic reason. The exact key and file names stay in human-facing output (UI warnings and `/web-tools status`).
