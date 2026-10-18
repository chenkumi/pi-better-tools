# Gemini API 原生（server-side）Web Search / Grounding 研究

研究日期：取自我在本次 session 讀到的官方文件快照。注意：ai.google.dev 文件頁面標示 Last updated **2026-10-13 UTC**，且系列已到 Gemini 4 Argon / Gemini 3.8 Flash，與較早的 Gemini 2.x 訓練記憶不同，以下一律以本次實際抓到的頁面內容為準。

**結論（一句話）**：支援。Gemini API（`generativelanguage.googleapis.com`，Pi 的 `google-generative-ai` api）**有**伺服器端內建 Google Search grounding；在 `generateContent` 只要在 `tools` 陣列放 `{"google_search": {}}`，模型自行搜尋、閱讀並在回應帶回可引用的來源。

驗證方式：只用 `web_search` 找官方頁面 + `web_fetch` 讀頁面內容；**沒有登入、沒有付費 API、沒有對真實 API 發 curl**，因此所有「實際回應格式」「錯誤碼」都是文件記載而非實測。

---

## 1. 是否支援 hosted/server-side web search

**是。** Gemini API 有內建（fully managed、server-side execution）工具，官方稱為 **Grounding with Google Search**，工具名稱 `google_search`。

- 官方文件（目前主推的 Interactions API）：<https://ai.google.dev/gemini-api/docs/google-search>
- 官方文件（仍然是 legacy 但「fully supported」的 `generateContent`）：<https://ai.google.dev/gemini-api/docs/generate-content/google-search>
- 工具總覽（明列 Google Search 是 built-in tool，整個流程在一次 API call 內完成）：<https://ai.google.dev/gemini-api/docs/tools>
- REST 參考（`models.generateContent` endpoint 是 `/v1beta/{model=models/*}:generateContent`）：<https://ai.google.dev/api/generate-content>

文件原文（tools 頁）："For built-in tools (Google Search, ...), the entire process happens within one API call"。

---

## 2. 確切的 request body 欄位與 JSON

### 2a. 舊版 `generateContent`（Pi 這類 REST client 最相關）

Endpoint：`POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent`
Header：`x-goog-api-key: $GEMINI_API_KEY`、`Content-Type: application/json`

```json
{
  "contents": [
    {
      "parts": [
        { "text": "Who won the euro 2024?" }
      ]
    }
  ],
  "tools": [
    {
      "google_search": {}
    }
  ]
}
```

（來源：<https://ai.google.dev/gemini-api/docs/generate-content/google-search> 的 REST 範例。SDK 端寫法是 `tools=[types.Tool(google_search=types.GoogleSearch())]`。）

### 2b. Interactions API（官方目前推薦的新 API）

```json
{
  "model": "gemini-3.8-flash",
  "input": "Who won the euro 2024?",
  "tools": [{ "type": "google_search" }]
}
```

Endpoint 在 `google-search` 頁寫 `POST https://generativelanguage.googleapis.com/v1beta/interactions`（<https://ai.google.dev/gemini-api/docs/google-search>）；但 migration 頁有一處寫 `/v1beta2/interactions`，同一頁的 generateContent 範例又寫 `/v1beta`，文件本身不一致（見「未能驗證」）。

### 2c. Vertex AI 寫法（對照）

`POST https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{LOCATION}/publishers/google/models/{MODEL_ID}:generateContent`，用 `Authorization: Bearer $(gcloud auth print-access-token)`：

```json
{
  "contents": [{
    "role": "user",
    "parts": [{ "text": "TEXT" }]
  }],
  "tools": [{
    "googleSearch": {
      "exclude_domains": ["domain.com", "domain2.com"]
    }
  }],
  "toolConfig": {
    "retrievalConfig": {
      "latLng": { "latitude": 37.7749, "longitude": -122.4194 }
    }
  },
  "model": "projects/PROJECT_ID/locations/LOCATION/publishers/google/models/MODEL_ID"
}
```

（來源：<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search>，原 Vertex URL <https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/grounding-with-google-search> 會轉址。）

### 2d. 欄位命名與版本注意

- Gemini API 文件全部用 snake_case `google_search`；Vertex 文件用 camelCase `googleSearch`。protobuf JSON 一般兩種拼法都接受，**但我沒有實測 generativelanguage 是否接受 `googleSearch`**。
- **沒有**任何 beta header 需求；文件只要求 API key header，endpoint 一律 `/v1beta`。
- **舊欄位 `google_search_retrieval` 已被取代**：API 會回 `400 Bad Request ... Please use google_search field instead of google_search_retrieval field.`（社群證據：<https://github.com/google-gemini/deprecated-generative-ai-js/issues/330>、<https://github.com/google-gemini/deprecated-generative-ai-js/issues/435>）。搜尋結果也有一條官方頁面 snippet 寫 "Note: Older models use a `google_search_retrieval` tool."，但該註記**不在**我抓到的 `google-search` 頁面快照中，故僅列為 snippet 級證據。

---

## 3. 能否和一般 function declarations 同時放在同一個 request

**Gemini 3 系列可以**，機制叫 **tool context circulation**，但需要額外開 flag 並遵守回傳規矩。來源：<https://ai.google.dev/gemini-api/docs/generate-content/tool-combination>（legacy）與 <https://ai.google.dev/gemini-api/docs/tool-combination>（Interactions API）。

```json
{
  "contents": [{
    "role": "user",
    "parts": [{ "text": "What is the northernmost city in the United States? What's the weather like there today?" }]
  }],
  "tools": [{
    "googleSearch": {}
  }, {
    "functionDeclarations": [{
      "name": "getWeather",
      "description": "Get the weather in a given location",
      "parameters": {
        "type": "OBJECT",
        "properties": { "location": { "type": "STRING", "description": "The city and state, e.g. San Francisco, CA" } },
        "required": ["location"]
      }
    }]
  }],
  "toolConfig": {
    "includeServerSideToolInvocations": true
  }
}
```

限制與條件（同頁 "Limitations"／"How it works"）：

- 必須設 `toolConfig.include_server_side_tool_invocations: true` 才會啟用 tool context circulation；只放 built-in 而不放 `functionDeclarations` 時，只要 flag 有設，circulation 仍會作用在 built-in tool 上。
- 也可寫在同一個 tool 物件內（`tools:[{googleSearch:{}, functionDeclarations:[...]}]`），文件兩種寫法都出現。
- flag 開啟時 `tool_config` 只支援 `VALIDATED` 模式（`AUTO` 不支援）。
- 必須把回應中的 parts **原樣**帶回下一輪，含 `id`、`tool_type`、`thought_signature`；不帶回會 error（文件寫 "if you don't return the thought signatures for all parts in every turn, the model will error out"，Vertex 版說 Gemini 3 會回 `400`）。
- `google_search` 依賴 location/current time，若 `system_instruction` 或 function description 有衝突的地點/時間資訊，組合效果可能變差。
- 適用範圍：文件寫 "Gemini 3 models use tool context circulation"／"Gemini 3 models also support combining these built-in tools with custom tools"；2.5/2.0 沒有這個保證。
- **文件互相衝突**：Vertex/Agent Platform 的 grounding 頁寫 "The Gemini API doesn't support combining search tools (such as `googleSearch`) with non-search tools (such as function calling ...) in the same `generateContent` request. Multiple tools are supported only when they are all search tools."（<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search>）。這與 ai.google.dev 的 tool-combination 頁明顯矛盾；合理解讀是「Vertex 舊路徑／舊模型限制」，但**我無法只憑文件判定哪個對哪個 surface 生效**。
- 另外 `google_search` 可與其他 built-in 工具（code execution、URL context、Google Maps）併用；Google Maps 只在 Gemini 3.5 Flash-Lite 之後支援。

---

## 4. 回應長相與多輪規矩

### 4a. `generateContent`：`candidates[].groundingMetadata`

來源：<https://ai.google.dev/gemini-api/docs/generate-content/google-search>

```json
{
  "candidates": [
    {
      "content": {
        "parts": [{ "text": "Spain won Euro 2024, defeating England 2-1 in the final. ..." }],
        "role": "model"
      },
      "groundingMetadata": {
        "webSearchQueries": ["UEFA Euro 2024 winner", "who won euro 2024"],
        "searchEntryPoint": { "renderedContent": "<!-- HTML and CSS for the search widget -->" },
        "groundingChunks": [
          { "web": { "uri": "https://vertexaisearch.cloud.google.com.....", "title": "aljazeera.com" } },
          { "web": { "uri": "https://vertexaisearch.cloud.google.com.....", "title": "uefa.com" } }
        ],
        "groundingSupports": [
          {
            "segment": { "startIndex": 0, "endIndex": 85, "text": "Spain won Euro 2024, defeatin..." },
            "groundingChunkIndices": [0]
          },
          {
            "segment": { "startIndex": 86, "endIndex": 210, "text": "This victory marks Spain's..." },
            "groundingChunkIndices": [0, 1]
          }
        ]
      }
    }
  ]
}
```

欄位語意（同頁）：

- `webSearchQueries`：模型實際執行的查詢字串，可做 debug 與計費。
- `searchEntryPoint.renderedContent`：**必須顯示**的 Search Suggestions HTML/CSS（ToS／display requirements 要求）。
- `groundingChunks[].web`：來源 `uri` + `title`。Gemini API 範例的 uri 是 `vertexaisearch.cloud.google.com` 轉址；Vertex 範例則直接是原始 URL 並多一個 `domain` 欄位。
- `groundingSupports[]`：把回覆文字的 `segment.startIndex/endIndex` 對應到 `groundingChunkIndices`（可多個）；Vertex 版另有 `confidenceScores`、`retrievalMetadata`。
- 客戶端要自己把 chunk 索引轉成 inline citation；文件附 Python/JS 範例（依 `endIndex` 由大到小插入連結，避免 index 位移）。

### 4b. Interactions API：`steps[]` + `annotations[]`

來源：<https://ai.google.dev/gemini-api/docs/google-search>

```json
{
  "steps": [
    { "type": "thought", "summary": [{ "type": "text", "text": "..." }], "signature": "CoMDAXLI2nynRYojJIy6B1Jh9os2crpWLfB0..." },
    { "type": "google_search_call", "arguments": { "queries": ["UEFA Euro 2024 winner"] } },
    { "type": "google_search_result", "call_id": "search_001", "result": [{ "search_suggestions": "<!-- HTML and CSS for the search widget -->" }] },
    {
      "type": "model_output",
      "content": [{
        "type": "text",
        "text": "Spain won Euro 2024, defeating England 2-1 in the final. ...",
        "annotations": [
          { "type": "url_citation", "url": "https://www.aljazeera.com/sports/euro-2024-final", "title": "aljazeera.com", "start_index": 0, "end_index": 56 }
        ]
      }]
    }
  ]
}
```

- `url_citation`（url/title/start_index/end_index）是 inline citation 的來源；`google_search_result.result[].search_suggestions` 是必顯示的 search widget。
- Interactions API 預設 `store=true`，多輪用 `previous_interaction_id`，server 自己管 history 與 signature；`store=false` 則是 stateless，**必須**把 `id` 與 `signature` 一起帶回。

### 4c. 多輪對話規矩

- `generateContent` 是 stateless：每輪要自己送整個 `contents`（<https://ai.google.dev/gemini-api/docs/migrate-to-interactions>）。
- Gemini 3 的 `thoughtSignature` 屬於 response parts，stateless 模式下「必須」連同有簽章的部分原樣回送，否則 400（<https://ai.google.dev/gemini-api/docs/gemini-3> 的 Thought signatures 段；細節 <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures>）。
- **開了 `include_server_side_tool_invocations` 時**，`toolCall`/`toolResponse`（built-in 搜尋步驟）連同 `id`、`tool_type`、`thought_signature` 都必須整段回送，這是工具組合能運作的必要條件（<https://ai.google.dev/gemini-api/docs/generate-content/tool-combination>）。
- **沒有開該 flag 的純 grounding 情境**：官方文件**沒有**明文要求把 `groundingMetadata` 回傳到下一輪；`groundingMetadata` 不在 `content.parts` 內，且文件把它描述成 output metadata。→ 列入「未能驗證」。

---

## 5. 支援模型、GA/preview、Gemini API vs Vertex AI、配額與計價

### 5a. 支援模型（Gemini API 表，來源 <https://ai.google.dev/gemini-api/docs/google-search>）

Gemini 4 Argon；Gemini 3.8 Flash；Gemini 3.6 Flash；Gemini 3.5 Flash-Lite；Gemini 3.1 Flash-Lite；Gemini 3.1 Flash Image Preview；Gemini 3.1 Pro Preview；Gemini 3 Pro Image Preview；Gemini 3 Flash Preview；Gemini 3.1 Flash-Lite Preview；Gemini 2.5 Pro / Flash / Flash-Lite；Gemini 2.0 Flash。

Vertex/Agent Platform 清單略有出入（多出 Gemini 3.8 Live、Gemini 3.7 Flash、Gemini 3.5 Flash、Nano Banana 2.1、Gemini 3.1 Pro preview 標記等）：<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search>

### 5b. GA / preview 狀態

- Grounding with Google Search 本身是既有 GA 功能（2.5/2.0 世代即存在）。
- **Gemini 3 全系列目前是 preview**：Gemini 3 guide 寫 "All Gemini 3 models are currently in preview."（<https://ai.google.dev/gemini-api/docs/gemini-3>，該頁已標 deprecated，導向 <https://ai.google.dev/gemini-api/docs/latest-model>）。
- Gemini 4 Argon 另有 free tier 限制：pricing 頁寫 "Gemini 4 Argon is not available on the Free tier."（<https://ai.google.dev/gemini-api/docs/pricing>）。

### 5c. Gemini API vs Vertex AI 差異

| 項目 | Gemini API（generativelanguage） | Vertex AI（aiplatform） |
| --- | --- | --- |
| Endpoint | `/v1beta/models/{model}:generateContent` | `{LOCATION}-aiplatform.googleapis.com/v1/projects/.../publishers/google/models/{model}:generateContent` |
| 認證 | `x-goog-api-key` | OAuth / `gcloud auth print-access-token` |
| 工具欄位 | `google_search`（文件拼法） | `googleSearch`（文件拼法），支援 `exclude_domains`、`searchTypes.imageSearch/webSearch` |
| 位置 / 檢索設定 | 文件未記載 | `toolConfig.retrievalConfig.latLng` |
| 來源 URL | 範例是 `vertexaisearch.cloud.google.com` 轉址；`groundingChunks[].web` 為 uri+title | 範例為原始 URL，另有 `domain`、`confidenceScores`、`retrievalMetadata` |
| 配額 | 文件只提計價與 free-tier 資格 | 「Grounding with Google Search has a limit of one million queries per day」 |
| built-in + function calling 併用 | ai.google.dev 說 Gemini 3 支援（需 flag） | 文件說同一個 generateContent request 不支援混用搜尋與非搜尋工具 |
| 其他 | — | 另有 Grounding API、Grounding with your own search API、Google Image Search（Preview）等 |

### 5d. 配額 / 計價

來源：<https://ai.google.dev/gemini-api/docs/pricing>、<https://ai.google.dev/gemini-api/docs/google-search>

- Gemini 3 及更新模型：**每個模型實際執行的 search query 各計費一次**；每月 5,000 次免費（Gemini 3 及更新模型共用），之後 **$14 / 1,000 次 search request**。空查詢不計。一個 prompt 觸發兩個 query = 計兩次。
- Gemini 2.5 及更舊：以 **prompt** 為單位計費。
- Free tier：多數模型（3.8 Flash、3.6 Flash、3.5 Flash-Lite、4 Argon 等）標示 **"Not available"**，註腳 `**` 表示「Can be tested in Google AI Studio」；例外是 Gemini 3.8 Live 系列表格標 "Supported"。→ 開發階段若用免費 key，grounding **很可能直接不可用**（實務影響大）。
- Vertex 側另有每日 1,000,000 queries 上限（超過需聯絡 Google Cloud support）。
- Token 計價：`toolCall`/`toolResponse` parts 在 **request** 中會算入 `prompt_token_count`；但 Google Search 例外，不重複計 token（<https://ai.google.dev/gemini-api/docs/generate-content/tool-combination>）。
- 顯示義務：`searchEntryPoint.renderedContent` / `search_suggestions` 與 grounding support 必須照規定顯示，不可修改樣式、不可延遲跳轉（AI Studio ToS 連結 <https://ai.google.dev/gemini-api/terms#grounding-with-google-search>；實作細節與 mocks 見 Vertex 頁 "Use Google Search suggestions"）。這對終端產品是硬性要求。

---

## 未能驗證清單

1. **未實測任何真實 API 呼叫**（依任務限制），因此無法確認實際錯誤碼、回應欄位是否與文件完全一致、舊模型是否真的回 `400`。
2. `generativelanguage.googleapis.com` 是否也接受 `googleSearch`（camelCase）、`exclude_domains`、`toolConfig.retrievalConfig.latLng`：這些只出現在 Vertex 文件，Gemini API 文件未記載。
3. 純 grounding（未開 `include_server_side_tool_invocations`）時，**是否/何時必須把 `groundingMetadata` 回傳下一輪**：官方文件未明文要求，也找不到明文禁止。
4. `v1`（非 beta）是否支援 `google_search`：所有範例都用 `/v1beta`；Interactions API 的文件本身在 `/v1beta` 與 `/v1beta2` 之間不一致。
5. 「Older models use a `google_search_retrieval` tool」這句只在搜尋 snippet 看到，未在我抓取的官方頁面快照中出現；舊模型實際可用欄位未驗證。
6. Gemini API 與 Vertex 關於「built-in + function calling 能否併用」的文件矛盾，未能在文件中判定哪個 surface 生效（推測為模型世代差異）。
7. 各模型的 free tier grounding 資格只看 pricing 表格；未驗證 API key 實際被拒的行為與錯誤訊息。
8. `gemini-3.1-flash-lite-*` 等 preview 模型 ID 的精確名稱，兩份文件表格略有出入，未逐一向 models 頁核對。
9. Pi 目前 `google-generative-ai` provider 的 request builder 是否已支援 `tools[].google_search`（本任務只做文件研究，未讀 Pi 原始碼）。
