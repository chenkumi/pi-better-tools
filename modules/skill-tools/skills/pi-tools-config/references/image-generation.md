# Image Generation：文字生圖（OpenAI／Gemini／Codex CLI）

## 工具與載入

單一工具 `image_generate`，deferred：先 `tool_search` 搜尋 `image` 載入。不是預設啟用。Subagent 內沒有此工具；Fork 內有，但沒有互動 UI 時需 `confirm: "never"` 才能執行（否則回 `IMAGE_CONFIRM_UNAVAILABLE`）。

參數：`prompt`（必填）、`backend`（`openai`／`gemini`／`codex`）、`aspectRatio`（如 `16:9`）、`resolution`（`1K`／`2K`／`4K`）、`quality`（只有 OpenAI）、`format`（`png`／`jpeg`／`webp`）、`transparentBackground`、`count`（1–10，受 `maxImages` 限制）。後端無法套用的選項會列在結果的 `ignored`。圖片存成專案內的新檔案（預設 `.pi/generated-images/IMG-<UTC 時間戳>-<序號>.<副檔名>`），只新增、不覆寫，不接受參考圖或指定路徑。

## 設定檔與面板

`~/.pi/agent/image-generation.json`（使用者層，不讀專案層）；面板 `/settings:image-generation`（General／OpenAI／Gemini／Codex 四頁，存檔後立即生效、不需 `/reload`）。沒有金鑰欄位。

```json
{ "version": 1, "enabled": false, "backend": "openai", "confirm": "first", "outputDir": ".pi/generated-images", "maxImages": 4, "inlinePreview": false, "timeoutMs": 180000,
  "openai": { "enabled": true, "model": "gpt-image-2.6-sunburst", "quality": "auto", "format": "png" },
  "gemini": { "enabled": true, "model": "gemini-nano-banana-2.1", "resolution": "1K" },
  "codex": { "enabled": true, "path": "codex", "timeoutMs": 300000 } }
```

- `enabled`：總開關，**預設 `false`**（先在面板或檔案設為 `true` 再 `/reload`）。`false` 時不註冊工具（需 `/reload` 生效；執行中改為 false 則呼叫被拒絕），改回 `true` 也需 `/reload`。各後端另有自己的 `enabled`。
- `backend`：預設後端；後端之間不自動備援。
- `confirm`：`first`（每個 session、每個後端第一次詢問）、`always`、`never`。付費請求才需要。
- `outputDir`：專案內相對路徑，不可含 `..`、不可經過連結。
- `openai.model`／`gemini.model`：任何模型 ID（符合 `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`）。`inlinePreview: true` 才把第一張圖附給模型。
- `codex.path`：codex 執行檔本身，不可是 `.cmd`／`.bat`。`codex.model` 省略＝Codex 預設。

## 憑證

- OpenAI：Pi 內 provider `openai` 的 **API key**（ChatGPT／OAuth 登入不行）。
- Gemini：Pi 內 provider `google` 的 API key。
- Codex：先在終端機執行 `codex login`（ChatGPT 登入）。用量算在 ChatGPT 方案。

面板每個後端頁的「檢查」只回報有沒有登入，不顯示金鑰。

## 已知限制

- Gemini 輸出只有 JPEG（API 的 `mime_type` 只接受 `image/jpeg`）。
- Codex 無法精確控制尺寸、品質與格式（只當 prompt 提示）。
- 不自動重試：逾時或 5xx 時供應商可能已處理（並計費）。取消不代表供應商端已停止。
- 內容政策封鎖的實際形狀未實測。
