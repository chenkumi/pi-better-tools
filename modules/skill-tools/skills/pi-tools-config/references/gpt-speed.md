# GPT Speed：服務速度層級（prompt cache 保留時間目前停用）

## 指令與工具

- `/normal`：一般速度，不修改 service_tier，預設模式。
- `/fast`：請求 `service_tier: "priority"`。
- `/ultrafast`：請求 `service_tier: "ultrafast"`；不適用時不強行套用。
- `/cache-ttl-short`／`/cache-ttl-long` 目前**停用**（`CACHE_TTL_ENABLED = false`）：不註冊指令、狀態列不顯示 `Cache:`、請求不送 `prompt_cache_options.ttl`；不要建議使用者用這兩個指令。
- 無額外模型工具。TUI 狀態列顯示目前模式與 inactive／降級原因。

## Config 與作用範圍

```json
{ "pi-gpt-speed": { "mode": "fast" } }
```

- 全域 `<agentDir>/settings.json`；上述指令立即切換並寫入這個檔案，保留其他設定。
- 受信任專案 `<cwd>/.pi/settings.json` 的同名鍵覆蓋全域；指令不寫專案檔，所以專案值會在下次 session 開始重新覆蓋全域選擇。
- `mode` 未設定／值無效為 normal。`cache` （short／long）仍會被讀取，但停用期間不影響請求或狀態列，也沒有指令寫入它。手改設定後 `/reload` 或重開 session；指令切換即時生效。
- 如果指令改完又恢復，先查專案覆蓋，不反覆寫全域設定。

生效條件為非虛擬模型、OpenAI／OpenAI Codex provider，且模型 ID 符合版本至少5.6的 `gpt-<版本>-<luna|terra|sol|astra>`；luna／terra 的 ultrafast 會降為 fast。虛擬路由不猜實體模型，顯示 Normal。服務層級可能影響帳務／供應商支援；只依使用者選擇設定，不自動更換模型或測試付費請求。
