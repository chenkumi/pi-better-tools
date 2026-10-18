# DeepSeek 官方 API 的伺服器端 Web Search 能力調查

調查日期：2026-10-17（依 api-docs.deepseek.com 線上文件）
範圍：官方文件（api-docs.deepseek.com）與官方 api.deepseek.com 端點說明
限制：未登入、未使用 API key、未對 api.deepseek.com 發出任何真實請求

## 結論摘要

DeepSeek **確實提供官方伺服器端聯網搜尋能力**，但**不在 OpenAI Chat Completions 的 `tools` 裡**。共有兩種官方形式：

1. **Responses API 的 hosted `web_search` 工具**（伺服器端執行，目前僅 `deepseek-v4-pro`）。
2. **獨立的 Search / Fetch raw JSON API**：`POST /v1/tools/search`、`POST /v1/tools/fetch`。

Chat Completions（`/chat/completions`）仍然**只有 client 端 function calling**，`tools` 官方明訂「Currently, only functions are supported as a tool」。

---

## Q1. 是否有 hosted / server-side web search tool？

**有**，兩種形式。

### 1a. Responses API hosted `web_search` 工具

來源：<https://api-docs.deepseek.com/guides/responses_api/>（段落 "Tools"）
來源：<https://api-docs.deepseek.com/api/create-response/>（`tools` schema）

- `tools[].type` 可能值：`function` / `custom` / `web_search`。
- `web_search`：「Supported with `deepseek-v4-pro`. The API runs the search on the server, adds the results to the context, and continues the response. Ignored with `deepseek-flash`.」
- API reference 原文：「`function` tools are supported; `web_search` is supported with `deepseek-v4-pro`; other built-in tool types are ignored.」
- 其他 built-in 工具（`file_search` / `code_interpreter` / `computer_use` / `mcp`）都被忽略。
- 伺服器端呼叫會以 `web_search_call` output item 呈現；串流事件為 `response.web_search_call.in_progress` / `searching` / `completed`（文件註明 deepseek-v4-pro only）。
- 先前 response 的 `web_search_call` items 可放回 `input`，其搜尋結果會被還原並串回 context。
- 端點：`POST https://api.deepseek.com/responses`（stateless，`store: false`）。
- 文件未列出 `web_search` 的任何額外參數（無 filters、無 max_uses 之類欄位）。

最小請求體（依文件 schema 推得，未實測）：

```json
{
  "model": "deepseek-v4-pro",
  "input": "Find the latest official DeepSeek API update and cite the primary page.",
  "tools": [{ "type": "web_search" }]
}
```

相對應的 Codex 端設定（官方 Codex 整合頁）：

```toml
model = "deepseek-v4-pro"
web_search = "live"
```

來源：<https://api-docs.deepseek.com/quick_start/agent_integrations/codex/>（段落 "Web Search"，原文：「Built-in web search is disabled by the setup script and is available only with deepseek-v4-pro… DeepSeek executes the searches on the server, and the requests are billed at Search API pricing.」）

### 1b. 獨立 Search / Fetch API（raw JSON，非 chat 形式）

來源：<https://api-docs.deepseek.com/guides/search/>
來源：<https://api-docs.deepseek.com/api/search/>
來源：<https://api-docs.deepseek.com/api/fetch/>

| API | Endpoint |
| --- | --- |
| Search | `POST https://api.deepseek.com/v1/tools/search` |
| Fetch | `POST https://api.deepseek.com/v1/tools/fetch` |

Search request 欄位：`query`（必填，1–128 字元）、`count`（1–50，預設 10）、`ori_question`、`localization`、`need_content`。支援 `site:`、`-site:`、`-`、`"-"`、`"..."`、`lang:`、`after:`、`before:` 等運算子。Unknown fields are ignored。

```json
{
  "query": "DeepSeek V4 release",
  "count": 5,
  "need_content": true
}
```

Search response：`results[]`，每項含 `rerank_score`、`title`、`url`、`snippet`、`summary`、`content`、`site_name`、`site_icon`、`date`、`authority`。

Fetch request：`url`（必填，≤8192 字元、http/https、不得含帳密）。response：`{ title, content }`（content 為 Markdown）。

計費（<https://api-docs.deepseek.com/quick_start/pricing>）：Search / Fetch 每 1,000 次成功請求各 USD 0.75；QPS 各 5（帳號層級，另加 Fetch per-domain QPS）。錯誤格式為 OpenAI-compatible error format。

## Q2. 是否只有 client 端 function calling？文件怎麼說？

**Chat Completions（`POST /chat/completions`）部分：是，只有 function calling。**

來源：<https://api-docs.deepseek.com/api/create-chat-completion/>

- `tools` 欄位原文：「A list of tools the model may call. **Currently, only functions are supported as a tool.**」
- `tools[].type` 可能值僅 `[function]`；`tool_calls[].type` 亦僅 `[function]`。
- `tool_choice`：`none` / `auto` / `required` / 指定 function；thinking 模式下 `required` 與 named tool choice 會回 400。
- `strict: true` 為 Beta（需 `base_url="https://api.deepseek.com/beta"`）。

來源：<https://api-docs.deepseek.com/guides/tool_calls/>

- 「Tool Calls allows the model to call external tools to enhance its capabilities.」
- 明確註記：「the functionality of the `get_weather` function needs to be provided by the user. The model itself does not execute specific functions.」
- Tool Calls 在 thinking mode（DeepSeek-V3.2 起）亦支援；strict mode 的 base_url Beta 機制只影響 schema 驗證，與 web search 無關。

因此，若使用 `/chat/completions`（OpenAI 相容路徑），要聯網必須自行在 client 端執行搜尋並以 function/tool 結果回填；**API 不會代為聯網**。

## Q3. 其他聯網相關 API／產品功能／非官方整合

**官方 API 提供：**
- `/responses` 的 hosted `web_search`（見 Q1a）。
- `/v1/tools/search`、`/v1/tools/fetch` 獨立 API（見 Q1b）。
- 官方 Harness 整合的 server-side tool calls：<https://api-docs.deepseek.com/guides/search/> 與 pricing 頁皆註明「when you use the DeepSeek API through DeepSeek Harness, Claude Code, or Codex, server-side tool calls already hit the Search and Fetch APIs. These calls are currently free of charge; per-request billing starts at 00:00 Beijing time on November 1, 2026.」

**官方產品功能（非 API）：**
- DeepSeek 自家 App/Web 的「Internet Search」開關（chat.deepseek.com）：<https://api-docs.deepseek.com/news/news1210/> 原文「🌐 Internet Search is now live on the web! Visit https://chat.deepseek.com/ and toggle "Internet Search" for real-time answers.」這是網頁/App 產品功能，不是 API 參數。
- 變更日誌把內部搜尋引擎對外開放：<https://api-docs.deepseek.com/updates/> 2026-10-17「Opening up the in-house search API」（以自家 in-house DeepSeek search engine 驅動）。

**非官方整合（不屬於 DeepSeek 官方 API）：**
- 第三方平台包裝，如火山引擎（Volcengine）的「DeepSeek-R1 联网搜索 API」（<https://developer.volcengine.com/articles/7527946946733211711>）：由第三方平台提供 Bot-ID 等自訂機制。
- 第三方 MCP server，如 glama.ai 上的 websearch-deepseek（<https://glama.ai/mcp/servers/lyumeng/websearch-deepseek>）：屬社群整合。
- 第三方部落格轉述（如 chendahuang.com、chat-deep.ai）：非官方來源，僅可作為線索，不可作為結論依據。

## Q4. beta / preview 或近期 release note 是否提到新增 hosted search？

- **有（已 GA，非標示 beta）**：Change Log 2026-10-17「Opening up the in-house search API」對外開放 Search & Fetch API。<https://api-docs.deepseek.com/updates/>
- 官方 docs 頂部橫幅：「Search / Fetch API is now available, powered by our in-house search engine and supporting web search and fetch.」（出現於 `/`、`/api/deepseek-api/`、多數頁面）
- 付費/免費過渡：Search & Fetch 對 Harness / Claude Code / Codex 的 server-side tool calls「currently free of charge」，2026-11-01 00:00（北京時間）起改為 per-request 計費。來源：<https://api-docs.deepseek.com/guides/search/>、<https://api-docs.deepseek.com/quick_start/pricing/>。
- Models & Pricing 頁的 feature 表中，標為 Beta 的只有「Chat Prefix Completion（Beta）」與「FIM Completion（Beta）」，**沒有**把 web search 標為 beta。來源：<https://api-docs.deepseek.com/quick_start/pricing/>。
- 未找到官方明文說「hosted search 正在 beta / preview」的頁面。

---

## 未能驗證清單

1. **`web_search` 是否真的只支援 `deepseek-v4-pro`**：官方文件一致寫 v4-pro only（Responses guide、create-response reference、Codex 頁），但 Codex 整合頁的 `models.json` 範例對 `deepseek-flash` 這個 slug 仍寫 `"supports_search_tool": true`、`"web_search_tool_type": "text"`，兩者不一致；未以真實請求確認實際行為。（第三方部落格聲稱可用 `deepseek-v4-flash`，與官方文件衝突，不予採信。）
2. **`web_search` 工具是否接受額外欄位**（例如 filters、搜尋上限、網域限制）：官方 schema 未列出，僅列 `type`；未知欄位行為未記載（「Unknown fields are ignored」只寫在 Search API 的 request body 說明）。未實測。
3. **hosted `web_search` 的實際 output/usage 形狀與計費單位**：Codex 頁稱「billed at Search API pricing」，但 Responses API 的 `usage` 只列 token 統計，未定義 web_search 的 per-request 計費如何在 response 中呈現。未實測。
4. **Beta base_url（`https://api.deepseek.com/beta`）是否也能用 `web_search`**：未找到說明；`/beta` 目前只與 strict tool calling、Chat Prefix、FIM 有關。
5. **`/anthropic`（Anthropic 格式）是否支援伺服器端 web search**：未在本次讀取的頁面中查到明確說明。官方 SDK/工具層（如 opencode issue 提到的 `server_tool_use` / `web_search_tool_result`）為第三方 repo 敘述，未經官方文件證實。
6. **DeepSeek Harness 的 server-side tool 名稱與參數**：pricing/guide 頁只說 Harness / Claude Code / Codex 的 server-side tool calls 會打到 Search 與 Fetch API，未列出具體工具名稱或 schema；未讀 Harness 專屬文件。
7. **QPS、費率是否會變動**：官方註明保留調整價格的權利；以上數字為調查當日文件值。
8. **實際可用性與地區限制**：未以真實 API key 驗證 endpoint 可達性、HTTP 402 餘額限制、`localization` 的實際效果。

## 參考來源清單

- <https://api-docs.deepseek.com/guides/search/> — Search & Fetch guide（欄位、運算子、response、錯誤、計費、QPS）
- <https://api-docs.deepseek.com/api/search/> — Search API reference
- <https://api-docs.deepseek.com/api/fetch/> — Fetch API reference
- <https://api-docs.deepseek.com/guides/responses_api/> — Responses API guide（Tools 表、串流事件、相容性）
- <https://api-docs.deepseek.com/api/create-response/> — Responses API reference（`tools` schema）
- <https://api-docs.deepseek.com/api/create-chat-completion/> — Chat Completions reference（"only functions are supported"）
- <https://api-docs.deepseek.com/guides/tool_calls/> — Tool Calls guide
- <https://api-docs.deepseek.com/updates/> — Change Log（2026-10-17 Opening up the in-house search API）
- <https://api-docs.deepseek.com/quick_start/pricing/> — Models & Pricing（Search & Fetch 價格、免費過渡、Beta 標記）
- <https://api-docs.deepseek.com/quick_start/agent_integrations/codex/> — Codex 整合（Web Search 段落）
- <https://api-docs.deepseek.com/news/news1210/> — DeepSeek App/Web 的 Internet Search（產品功能）
- <https://developer.volcengine.com/articles/7527946946733211711> — 第三方（火山引擎）非官方整合
- <https://glama.ai/mcp/servers/lyumeng/websearch-deepseek> — 第三方 MCP server
