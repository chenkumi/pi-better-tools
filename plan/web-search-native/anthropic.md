# Anthropic Messages API 原生 web search tool（server-side）規格研究

研究日期：（依研究執行時官方站台內容為準）
來源皆為 Anthropic 官方文件（`platform.claude.com` / `docs.claude.com` 導向同一站台）。未登入、未使用 API key、未打任何真實 API。

---

## 0. 結論摘要

- Anthropic Messages API 有官方 server-side web search tool，型別為版本化字串 `web_search_YYYYMMDD`，目前三個版本：`web_search_20250305`、`web_search_20260209`、`web_search_20260318`。
- **現行官方文件標示 web search 三個版本都不需要任何 beta header**（tool reference 的 "Beta header" 欄位為 `None`），屬已 GA 功能；只需要標準的 `anthropic-version: 2023-06-01`。
- 可與自訂 client tool（`tools[].input_schema`）放在同一個 `tools` 陣列。名稱衝突（自訂工具也叫 `web_search`）官方文件**沒有**明確規定行為。
- 多輪對話必須把 `server_tool_use` 與 `web_search_tool_result`（含 `encrypted_content`）原樣回傳，否則 400 validation error。

---

## 1. 是否支援 server-side web search tool、官方文件 URL

支援。官方文件：

- Web search tool: <https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool>（實際導向 <https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool>）
- Web fetch tool（對照）: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool>
- Server tools（共用機制）: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools>
- Tool reference（type / beta header 一覽表）: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference>
- Pricing（$10 / 1,000 searches）: <https://platform.claude.com/docs/en/about-claude/pricing>
- Versions（`anthropic-version`）: <https://platform.claude.com/docs/en/api/versioning>

原文（web search 頁）：

> "The web search tool gives Claude direct access to real-time web content... The response includes citations for sources drawn from search results."

> "Three versions of the web search tool are available: `web_search_20250305`: basic web search; `web_search_20260209`: adds dynamic filtering; `web_search_20260318`: adds response inclusion control for agentic workflows"

### Server tool vs client tool

| 面向 | web search（server tool） | 自訂工具（client tool） |
| --- | --- | --- |
| `tools[]` 內容 | `type`（版本化）+ `name`，**沒有** `input_schema` | `name` + `description` + `input_schema` |
| 執行者 | Anthropic 伺服器 | 客戶端 |
| 回應 block | `server_tool_use` / `web_search_tool_result` | `tool_use` |
| 客戶端是否要回 `tool_result` | 不需要（除非同輪同時呼叫 client tool） | 必須 |

（來源：server-tools 頁 "The `server_tool_use` block"：*"The API executes the tool internally... Unlike client `tool_use` blocks, you don't need to respond with a `tool_result`."*）

---

## 2. 確切 request body 欄位與 header

### 2.1 Beta header / API version

Tool reference 的 "Anthropic-provided tools" 表格：

| Tool | `type` | Execution | Beta header |
| --- | --- | --- | --- |
| Web search tool | `web_search_20260318` / `web_search_20260209` / `web_search_20250305` | Server | **None** |

→ 現行文件版本下 **web search 不需要 `anthropic-beta`**（三個版本皆為 None）＝已 GA。對照組：Advisor tool 需要 `advisor-tool-2026-03-01`、MCP connector 需要 `mcp-client-2025-11-20`。

標準 header（Messages API 必要）：

```
x-api-key: <API_KEY>
anthropic-version: 2023-06-01
content-type: application/json
```

> Versions 頁：*"When making API requests, you must send an `anthropic-version` request header. For example, `anthropic-version: 2023-06-01`."*

### 2.2 官方 tool definition（web search 頁原文 JSON）

```json
{
  "type": "web_search_20250305",
  "name": "web_search",

  // Optional: Limit the number of searches per request
  "max_uses": 5,

  // Optional: Only include results from these domains.
  // Use allowed_domains or blocked_domains, not both.
  "allowed_domains": ["example.com", "trusteddomain.org"],

  // Optional: Never include results from these domains
  "blocked_domains": ["untrustedsource.com"],

  // Optional: Localize search results
  "user_location": {
    "type": "approximate",
    "city": "San Francisco",
    "region": "California",
    "country": "US",
    "timezone": "America/Los_Angeles"
  }
}
```

欄位規則（同頁）：

- `max_uses`：限制本 request 的搜尋次數；超出時 `web_search_tool_result` 回 `max_uses_exceeded` 錯誤碼。文件未給預設值或上限。
- `allowed_domains` / `blocked_domains`：**只能二選一**，同時給會 400。條目是不含 scheme 的裸網域（可含 path，如 `example.com/blog`）。子網域自動包含；path 支援 web search（web fetch 只比對網域）。萬用字元只能用在 path（合法 `example.com/*`；不合法 `*.example.com`、`ex*.com`）。非法格式請求時 400 `invalid_request_error`。request 層 `allowed_domains` 必須是 Console 組織層允許清單的子集。
- `user_location`：`type` 必須是 `"approximate"`；`city` / `region` / `country`（ISO 3166-1 alpha-2）/ `timezone`（IANA）至少給一個；不支援的 `country` 會 400。**注意：web search 的工具定義沒有 `citations` 欄位**（對照 web fetch 才有 `"citations": {"enabled": true}`，且預設關閉）。
- 版本差異欄位：
  - `allowed_callers`：所有版本的 web search 都接受。`web_search_20250305` 預設 `["direct"]`；`web_search_20260209` 之後預設 `["code_execution_20260120"]`。合法值 `"direct"` 與 `"code_execution_20260120"`（`code_execution_20260521` 亦可，兩者互換）。不支援 programmatic tool calling 的模型必須顯式設 `allowed_callers: ["direct"]`，否則 400 並提示要設定。
  - `response_inclusion`：需 `web_search_20260318` 以上；`"full"`（預設）或 `"excluded"`（把已被完成的 code execution 消耗掉的 nested `server_tool_use` + result 對整組從回應移除）。
- 通用可選屬性（tool reference "Tool definition properties"）：`cache_control`、`strict`、`defer_loading`、`allowed_callers` 適用 "All tools"；`input_examples` **不支援 server tools**（define-tools 頁明文：*"Not supported for server-side tools or client toolsets"*）。

### 2.3 最小可送 request（範例）

```json
{
  "model": "claude-opus-5-5",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "What's the weather in NYC?" }
  ],
  "tools": [
    { "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }
  ]
}
```

### 2.4 動態過濾版本（不需自行加 code execution）

```json
{
  "tools": [
    { "type": "web_search_20260209", "name": "web_search" }
  ]
}
```

> *"Dynamic filtering runs web search from inside code execution: on `web_search_20260209` and later, the tool's `allowed_callers` field defaults to `["code_execution_20260120"]`, and when dynamic filtering runs, the API provisions the code execution it needs for the request automatically. You don't need to add the code execution tool to `tools` yourself."*

ZDR 相關：`web_search_20250305` 為 ZDR-eligible；`_20260209` 之後預設**不** ZDR-eligible，需 `"allowed_callers": ["direct"]` 停用動態過濾：

```json
{
  "type": "web_search_20260209",
  "name": "web_search",
  "allowed_callers": ["direct"]
}
```

---

## 3. 能否與一般 client tool 同時使用？名稱衝突？

### 3.1 可以同時使用

server-tools 頁 "Mixing server tools and client tools in one turn" 給了官方混合範例（web fetch + 自訂 `run_command`）：

```json
{
  "tools": [
    { "type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 5 },
    {
      "name": "run_command",
      "description": "Run a shell command on this computer and return its output.",
      "input_schema": {
        "type": "object",
        "properties": { "command": { "type": "string", "description": "The command to run" } },
        "required": ["command"]
      }
    }
  ]
}
```

規則（原文重點）：

- 同一組平行呼叫中若 Claude 同時呼叫 server tool 與 client tool，API **不會**先跑 server tool，而回 `stop_reason: "tool_use"`（不是 `pause_turn`），`content` 只有 `server_tool_use`（沒有結果 block）與 client `tool_use`。
- 判定方式：*"Detect the state by looking for a `server_tool_use` block whose `id` has no matching result block in the response."*
- 續傳時：user message **只能**包含 `tool_result` blocks，且 `tools` 陣列必須維持相同定義；否則 400，訊息結尾為 ``but no `web_fetch` tool was provided``（web search 同理）。web search 頁亦載明：*"If Claude calls web search and one of your client tools in the same group of parallel tool calls, the API returns `stop_reason: "tool_use"` instead and does not run the search yet."*
- `tool_choice` 亦可為 `auto` / `any` / `none`；若要強制特定工具（`{"type":"tool","name":...}`）需模型支援，部分模型（Claude Opus 5.5 / Sonnet 5.5 等）會回 400。

### 3.2 名稱衝突（client tool 也叫 `web_search`）

官方文件**沒有**定義此狀況的結果。最接近的官方敘述只有 troubleshooting 頁的症狀表：

> "Claude never calls your tool — Tool name collision or overly-generic schema — **Check for duplicate names across your tool list.**"

另有明確拒絕同名的一例，但只限 client toolsets：*"Two entries of the same toolset, or another tool that carries that toolset's name: a tool named `computer` alongside `computer_toolset_20260801`... The API rejects each of these with an `invalid_request_error`."* — 這是 computer/browser toolset 的規則，**不適用**於 web search。因此「自訂工具命名為 `web_search` 時是 400、覆蓋、或被跳過」屬**未能驗證**；實務上應避免重用 `web_search` 這個名稱。

---

## 4. 回應形狀、多輪規矩、citations

### 4.1 官方回應結構（web search 頁原文）

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "I'll search for when Claude Shannon was born." },
    {
      "type": "server_tool_use",
      "id": "srvtoolu_01WYG3ziw53XMcoyKL4XcZmE",
      "name": "web_search",
      "input": { "query": "claude shannon birth date" }
    },
    {
      "type": "web_search_tool_result",
      "tool_use_id": "srvtoolu_01WYG3ziw53XMcoyKL4XcZmE",
      "content": [
        {
          "type": "web_search_result",
          "url": "https://en.wikipedia.org/wiki/Claude_Shannon",
          "title": "Claude Shannon - Wikipedia",
          "encrypted_content": "EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y...",
          "page_age": "April 30, 2025"
        }
      ]
    },
    { "text": "Based on the search results, ", "type": "text" },
    {
      "text": "Claude Shannon was born on April 30, 1916, in Petoskey, Michigan",
      "type": "text",
      "citations": [
        {
          "type": "web_search_result_location",
          "url": "https://en.wikipedia.org/wiki/Claude_Shannon",
          "title": "Claude Shannon - Wikipedia",
          "encrypted_index": "Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNm..",
          "cited_text": "Claude Elwood Shannon (April 30, 1916 – February 24, 2001) was an American mathematician, electrical engineer, computer scientist, cryptographer and i..."
        }
      ]
    }
  ],
  "id": "msg_a930390d3a",
  "usage": {
    "input_tokens": 6039,
    "output_tokens": 931,
    "server_tool_use": { "web_search_requests": 1 }
  },
  "stop_reason": "end_turn"
}
```

要點：

- `server_tool_use.id` 前綴是 `srvtoolu_`（client tool 是 `toolu_`）；`input` 內容為 `{ "query": "..." }`。
- `web_search_tool_result.content` 為陣列，元素型別 `web_search_result`，欄位 `url`、`title`、`page_age`、`encrypted_content`。
- **citations 型別是 `web_search_result_location`，不是 `url_citation`**（`url_citation` 是 OpenAI 的形狀）。欄位：`url`、`title`、`encrypted_index`、`cited_text`（最多 150 字元）。
- *"Citations are always enabled for web search"*；web search 的 `cited_text`、`title`、`url` **不計入** input/output token。
- 錯誤時回應仍是 HTTP 200，`content` 變成單一物件：

```json
{
  "type": "web_search_tool_result",
  "tool_use_id": "srvtoolu_a93jad",
  "content": { "type": "web_search_tool_result_error", "error_code": "max_uses_exceeded" }
}
```

錯誤碼：`too_many_requests`、`invalid_tool_input`、`max_uses_exceeded`、`query_too_long`、`request_too_large`、`unavailable`。搜尋成功但零結果 → `content` 是空陣列，不是錯誤。

### 4.2 多輪：是否必須原樣回傳 server block

**必須**。原文：

> "To continue a conversation that contains search results, send the assistant's content blocks back exactly as you received them, including each result's `encrypted_content`. The API decrypts that content on later turns to restore the search results in Claude's context. **If `encrypted_content` is missing or modified, the request fails with a 400 validation error.**"

`encrypted_index`（citation 內）同樣是 *"A reference that must be passed back for multi-turn conversations"*。因此把 `server_tool_use` / `web_search_tool_result`（或 citations）剝除、摘要、改寫，會導致 400，或至少讓模型失去檢索上下文。

### 4.3 `pause_turn` 續傳

- 伺服器端 agentic loop 可能在長回合回 `stop_reason: "pause_turn"`。續傳方式：把 paused 的 assistant content **原樣**再送一次（新 request），並保持相同的 `tools`。
- *"A paused turn can end with a `server_tool_use` block whose tool has not run yet, and the API returns a validation error if that tool is missing from the continuation."*
- 可重複 pause，需自行設續傳次數上限。

### 4.4 Streaming

```
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_xyz789","name":"web_search"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"latest quantum computing breakthroughs 2025\"}"}}

// Pause while search executes

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_xyz789","content":[{"type":"web_search_result","title":"Quantum Computing Breakthroughs in 2025","url":"https://example.com"}]}}
```

### 4.5 Batch API

Web search 可用於 Messages Batches API，**計價與一般 Messages API 相同**；Batches 有 per-organization 的 web search throttle（可在 Console 的 Rate limits 頁看到，需更高上限要聯繫 sales）。

---

## 5. 模型清單、GA/preview、計價、`max_uses` 上限、區域差異

### 5.1 模型支援

- web search 頁**沒有**靜態支援模型清單，只寫：*"For model support, see the Tool reference."*；tool reference 則回指各工具頁：*"Supported models vary by tool and by tool version. To check from your code whether a model accepts web search or code execution, see Using the Models API."*
- Models API 的 `capabilities.server_tools.web_search.supported` 為權威查詢方式：*"`supported` is `true` when the model accepts at least one version of that tool, not necessarily every version."*（`server_tools` 只涵蓋 web search 與 code execution，**不含 web fetch**。）
- 版本層級的模型限制（文件明述）：
  - Dynamic filtering（`_20260209` / `_20260318`）需 **Claude 4.6 及之後模型**與 **Claude Mythos Preview**。
  - 不支援 programmatic tool calling 的模型用 `_20260209`+ 時必須設 `allowed_callers: ["direct"]`，否則 400。
- 官方範例使用的模型字串（研究時點）：`claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-4-20250514`(第三方)。→ 具體「哪些模型 ID 支援 web search」**未能從官方靜態文件取得**。

### 5.2 GA / preview

- Tool reference 的 Beta header 欄位對三個 web search 版本皆為 `None` → 不需 beta header，屬正式可用（GA）；文件未另外標示 "beta"/"preview" 字樣。
- 組織層面：*"Web search is enabled for your organization unless an administrator has disabled it in the Claude Console"*（Console 可限制可搜尋網域）。**若被停用，請求會 400 `invalid_request_error`**（不是回傳錯誤碼在結果內）。Console 設定只適用 Messages API，不適用 Claude Managed Agents（後者用 agent toolset 的 `allowed_domains`/`blocked_domains`）。

### 5.3 計價

- **$10 USD / 1,000 searches**，另加標準 token 費用（搜尋結果內容算 input tokens，包含同一回合內多次搜尋與後續回合）。
- *"Each web search counts as one use, regardless of the number of results returned. If an error occurs during web search, the web search will not be billed."*
- 計數出現在 `usage.server_tool_use.web_search_requests`。
- 對照：web fetch **無**額外費用；**code execution 在同時使用 `web_search_20260209`+ / `web_fetch_20260209`+ 時免費**（*"When `web_search_20260209` (or later) or `web_fetch_20260209` (or later) is included in your API request, there are no additional charges for code execution tool calls beyond the standard input and output token costs."*）。單獨用 code execution 則依執行時間計費（每組織每月 1,550 免費小時，超出 $0.05/hr/container，每次執行最少 5 分鐘）。
- Managed Agents 內觸發的 web search 同樣是 $10 / 1,000 searches。
- Model pricing 頁與 web search 頁敘述一致（<https://platform.claude.com/docs/en/about-claude/pricing#web-search-tool>）。

### 5.4 `max_uses` 上限

- 官方**未給** web search 的預設值與最大值；只說超出會回 `max_uses_exceeded`，並給「簡單事實查詢通常 1–3 次、比較型研究可能 10 次以上」的選值建議。
- 對照 web fetch 頁：*"There is currently no default limit."*
- → web search `max_uses` 的硬上限**未能驗證**。

### 5.5 平台 / endpoint / 區域差異

| 平台 | web search 可用性 |
| --- | --- |
| Claude API（first-party） | 全部版本可用（global endpoint；`inference_geo: "us"` 為 token 費率 1.1x，非 web search 專屬限制） |
| Claude Platform on AWS | 可用（動態過濾版本亦可用） |
| Microsoft Foundry | Anthropic-hosted deployment：全部版本；**Azure-hosted deployment：僅 `web_search_20250305`（basic）** |
| Google Cloud | **僅 basic web search（不含 dynamic filtering）** |
| Amazon Bedrock | **不支援 web search** |
| Claude Mythos Preview | Claude API、Google Cloud、Microsoft Foundry 支援；**Amazon Bedrock 與 Claude Platform on AWS 不支援** |
| Claude Managed Agents | 走 agent toolset 的 `web_search` 設定（`allowed_domains`/`blocked_domains`，每份清單最多 64 條；`max_uses`、`citations`、`cache_control` 不適用於 Messages API 的這些欄位） |

> *"Web search is not available on Amazon Bedrock."*

Endpoint：一般 Messages API endpoint（`POST /v1/messages`）；文件未列出 web search 專屬 endpoint 或區域路徑差異（**未能驗證**是否有區域限制清單）。

---

## 6. 未能驗證清單

1. **`web_search` 以外自訂 `name` 是否合法**：所有官方範例的 `name` 都是 `"web_search"`，文件未說可否改名或改名後是否 400。
2. **client tool 與 server tool 同名（`name: "web_search"`）的確切行為**：文件只給「檢查重複名稱」的通用建議；沒有 400／覆蓋／優先序的明文。僅 computer/browser toolset 有明文拒絕同名（不適用於 web search）。
3. **`strict` / `defer_loading` / `cache_control` 是否真的接受於 web search tool entry**：tool reference 以 "All tools" 泛述，但 web search 頁只示範 `allowed_callers` 與 `response_inclusion`；未見 web search 專屬範例。
4. **`max_uses` 的預設值與硬上限**。
5. **是否可對 web search 傳 `citations` 欄位**（web fetch 有 `citations.enabled`，web search 頁說 citations always enabled 且未列此欄位；是否被 400 拒絕或忽略未驗證）。
6. **歷史 beta header `web-search-2025-03-05`**：只在第三方 GitHub issue 看到（<https://github.com/anthropics/claude-code/issues/10446> 提及 Vertex 需 `anthropic-beta: web-search-2025-03-05`），**官方文件無此敘述**；現行官方表格為 `None`。無法確認此值現在是否仍被接受或已移除。
7. **靜態支援模型清單**：官方無表，只能查 Models API `capabilities.server_tools.web_search.supported`（研究時未呼叫 API）。
8. **Google Cloud / Bedrock / Foundry 上的 web search 計價**：官方只寫 first-party 與 Managed Agents 為 $10/1,000；partner 平台價格未在此頁列出。
9. **任何實際 API 行為驗證**（依任務限制未使用 key、未打真實 API）。

---

## 7. 來源清單

- <https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool>（= <https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool>）：tool definition、參數、response 形狀、citations、errors、pause_turn、streaming、batch、usage/pricing、平台可用性。
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool>：對照（`citations.enabled`、`max_content_tokens`、`use_cache`、`response_inclusion`、"no default limit"、URL 驗證）。
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools>：`server_tool_use`、pause_turn、混合 server/client tool 回合、ZDR 與 `allowed_callers`、domain filtering。
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference>：type 清單、beta header（web search = None）、通用 tool 屬性、`allowed_callers` 值、client toolset 同名拒絕規則。
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>：client tool 欄位、`input_examples` 不支援 server tools、tool_choice 限制。
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use>：重複名稱建議、`<name>_tool_result` 缺少的錯誤與修法。
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-combinations>：web_search + web_fetch / code_execution 組合範例。
- <https://platform.claude.com/docs/en/about-claude/pricing>：$10 per 1,000 searches、code execution 與 web search 併用免費、Managed Agents 計價。
- <https://platform.claude.com/docs/en/models/overview>：Models API `capabilities.server_tools.web_search.supported` 說明。
- <https://platform.claude.com/docs/en/api/versioning>：`anthropic-version: 2023-06-01`。
