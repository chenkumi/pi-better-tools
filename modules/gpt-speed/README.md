# GPT Speed

切換 GPT 模型的服務速度層級（`service_tier`），並在 TUI 狀態列顯示目前模式。

## 指令

| 指令 | 效果 |
| --- | --- |
| `/normal` | 一般速度（預設，不修改請求） |
| `/fast` | 請求加入 `service_tier: "priority"` |
| `/ultrafast` | 請求加入 `service_tier: "ultrafast"` |

切換後立即生效並寫入設定；寫入失敗時目前模式仍有效，並顯示警告。

## 生效條件

模式僅在同時符合下列條件時套用，否則實際行為為 Normal：

- provider 為 `openai` 或 `openai-codex`。
- 模型 ID 符合 `gpt-<主>[.<次>]-<luna|terra|sol|astra>`，且版本 ≥ 5.6（版本以主／次數字比較，`5.10` 大於 `5.6`，`6` 視為 `6.0`）。
- `luna`、`terra` 不支援 `ultrafast`，會降為 `fast`。

狀態列（TUI）顯示如 `Speed: Fast`、`Speed: Normal (Fast inactive)`、`Speed: Fast (Ultrafast → Fast)`；切換模型時即時更新。

## 設定

設定鍵為 `pi-gpt-speed.mode`，值為 `normal`、`fast` 或 `ultrafast`：

```json
{ "pi-gpt-speed": { "mode": "fast" } }
```

- 全域：`<agentDir>/settings.json`；`/normal`、`/fast`、`/ultrafast` 會寫入此檔（保留其他設定，使用與 Pi 共用的檔案鎖與原子替換）。既有檔案先以 realpath 解析，保留 settings symlink 並替換其實際目標；沿用原 Unix 權限，新檔使用 `0600`。realpath／stat 的非 ENOENT 錯誤與 dangling symlink 一律拒絕寫入，避免破壞連結。鎖內同步 read／merge／write，不在持鎖時 await；只對 `ELOCKED` 最多嘗試 10 次、每次間隔 20ms（最多同步等待 180ms），重試耗盡不會無鎖寫入或刪除其他持有者的鎖。Windows 暫時 rename 鎖定亦有限次重試。
- 專案：`<cwd>/.pi/settings.json`；僅在專案受信任時讀取，並覆蓋全域值。專案檔不會被指令寫入。因此若受信任專案的 `.pi/settings.json` 已設定 `pi-gpt-speed.mode`，指令寫入的全域值會在下次 session 啟動時被專案值覆蓋；指令在這種情況下會警告一次（每個 session），請直接改專案檔或移除其 `pi-gpt-speed`。
- 工作階段開始時載入；未設定或值無效時為 `normal`。
