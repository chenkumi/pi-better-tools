# GPT Speed

切換 GPT 模型的服務速度層級（`service_tier`），並在 TUI 狀態列顯示目前模式。prompt cache 保留時間（`/cache-ttl-*`）目前停用。

## 指令

| 指令 | 效果 |
| --- | --- |
| `/normal` | 一般速度（預設，不修改請求） |
| `/fast` | 請求加入 `service_tier: "priority"` |
| `/ultrafast` | 請求加入 `service_tier: "ultrafast"` |

`/cache-ttl-short` 與 `/cache-ttl-long` 目前**停用**（原始碼 `CACHE_TTL_ENABLED = false`）：不註冊指令、不寫入設定、狀態列不顯示 `Cache:`、請求不加入 `prompt_cache_options`。實測目前尚不可用，待驗證後再開啟；下面 prompt cache 章節保留為重新啟用時的規格。

速度指令切換後立即生效並寫入設定；寫入失敗時目前模式仍有效，並顯示警告。

## 生效條件

模式僅在同時符合下列條件時套用，否則實際行為為 Normal：

- 選取的模型不是虛擬模型（`api` 不為 `pi-virtual`）。Pi 不向擴充揭露虛擬模型實際路由到的實體模型，因此虛擬模型一律視為 Normal（不論名稱），也不會對路由到 GPT 的虛擬模型注入 tier。
- provider 為 `openai` 或 `openai-codex`。
- 模型 ID 符合 `gpt-<主>[.<次>]-<luna|terra|sol|astra>`，且版本 ≥ 5.6（版本以主／次數字比較，`5.10` 大於 `5.6`，`6` 視為 `6.0`）。
- `luna`、`terra` 不支援 `ultrafast`，會降為 `fast`。

狀態列（TUI）顯示如 `Speed: Fast`、`Speed: Normal (Fast inactive)`、`Speed: Fast (Ultrafast → Fast)`；切換模型時即時更新。

## Prompt cache 保留時間（目前停用）

本節描述重新啟用（`CACHE_TTL_ENABLED = true`）時的規格；停用期間不會送出，也不會寫入或顯示任何 cache 設定。

OpenAI 文件（<https://developers.openai.com/api/docs/guides/prompt-caching>）對 GPT-5.6 以後的模型，只接受 Responses API 的 `prompt_cache_options.ttl` 為 `"30m"`（預設）或 `"12h"`，其他值回傳 `400 invalid_request_error`。因此本設定只提供兩個值，不接受自訂時間：

| 值 | 實際 TTL | 對請求的影響 |
| --- | --- | --- |
| `short`（預設） | 30m | 不修改請求（即 API 預設） |
| `long` | 12h | 以 `{ ...原有 prompt_cache_options, ttl: "12h" }` 取代該欄位，保留 Pi 已送的 `mode` 等欄位 |

`long` 僅在同時符合下列條件時送出，否則請求保持原樣（狀態列顯示 `inactive`）：provider 為 `openai`、模型 `api` 為 `openai-responses`、非虛擬模型，且模型 ID 與上面的速度模式相同（`gpt-<主>[.<次>]-<luna|terra|sol|astra>`、版本 ≥ 5.6）。`openai-codex`（ChatGPT 後端）文件未記載此參數，因此不送出。

注意（來自 OpenAI 文件）：`12h` 的 cache 寫入費用為未快取輸入的 2.5 倍（`30m` 為 1.25 倍），讀取費用不變；`12h` 是最短保留時間而非保證，也不保證命中或較低延遲。本擴充只依使用者選擇設定，不評估是否划算。

重新啟用後狀態列另有一項 `Cache: Short (30m)`、`Cache: Long (12h)` 或 `Cache: Long (12h, inactive)`，切換模型時即時更新。

## 設定

設定鍵為 `pi-gpt-speed.mode`（`normal`、`fast` 或 `ultrafast`）。`pi-gpt-speed.cache`（`short` 或 `long`）仍會被讀取，但停用期間不影響請求或狀態列，也沒有指令會寫入它。

```json
{ "pi-gpt-speed": { "mode": "fast" } }
```

兩個鍵獨立：各自載入、各自被受信任專案值覆蓋、各自寫入（寫入時保留另一個鍵與其他設定）。

- 全域：`<agentDir>/settings.json`；`/normal`、`/fast`、`/ultrafast` 會寫入此檔（保留其他設定，使用與 Pi 共用的檔案鎖與原子替換）。既有檔案先以 realpath 解析，保留 settings symlink 並替換其實際目標；沿用原 Unix 權限，新檔使用 `0600`。realpath／stat 的非 ENOENT 錯誤與 dangling symlink 一律拒絕寫入，避免破壞連結。鎖以宿主 `FileSettingsStorage` 相同的 lock identity（字面 settings 路徑、`realpath: false`）取得，取得鎖後才解析 symlink 目標；鎖內同步 read／merge／write，不在持鎖時 await；只對 `ELOCKED` 最多嘗試 10 次、每次間隔 20ms（最多同步等待 180ms），重試耗盡不會無鎖寫入或刪除其他持有者的鎖。Windows 暫時 rename 鎖定亦有限次重試。
- 專案：`<cwd>/.pi/settings.json`；僅在專案受信任時讀取，並覆蓋全域值。專案檔不會被指令寫入。因此若受信任專案的 `.pi/settings.json` 已設定 `pi-gpt-speed.mode`，指令寫入的全域值會在下次 session 啟動時被專案值覆蓋；指令在這種情況下會警告一次（每個 session），請直接改專案檔或移除其 `pi-gpt-speed`。
- 工作階段開始時載入；`mode` 未設定或值無效時為 `normal`。`cache` 仍會被解析（預設 `short`），但停用期間不使用。專案值無效時退回全域值。
