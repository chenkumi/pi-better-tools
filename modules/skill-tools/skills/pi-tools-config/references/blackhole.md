# Blackhole：摘要、記憶、recall 與設定

## 指令與工具

- `/blackhole`：請求 Pi 原生 compact 並使用 Blackhole 摘要；不是自行選擇 cut。
- `/blackhole settings`（alias configure）開 TUI 設定；非 TUI 回支援的文字摘要。
- `/blackhole changelog`、`cleanup`、`om-on`、`om-off`。
- `/blackhole-memory status`、`view`、`full` 檢視記憶；view/full 可能複製到剪貼簿。
- `/blackhole-recall <query>` 與工具 `recall` 搜尋歷史；`/blackhole-export` 匯出記憶（可有 `out:<path>`，寫檔需符合使用者請求）。

## Config 與作用範圍

- 全域 `<agentDir>/pi-blackhole/pi-blackhole-config.json`，預設位於 `~/.pi/agent/pi-blackhole/`，支援 PI_CODING_AGENT_DIR。
- 專案 `<cwd>/.pi/pi-blackhole-config.json`；legacy 專案 settings 仍有讀取相容。未信任專案不採用專案層。
- 設定 UI 可選 global／project／session；session override 存在當前對話 JSONL／branch，不是獨立檔案。不擅自改寫歷史。
- 大致優先序：全域／legacy → trusted project → defaults／migration → PASSIVE defaults 一次 → explicit environment → current session override → validation。先查目前 scope／env／branch，不只看檔案猜有效值。

不啟動背景記憶模型的最小示例：

```json
{ "compaction": "auto", "compactionEngine": "blackhole", "memory": false, "statusBar": true }
```

- `memory: true` 才使用 Observer／Reflector／Dropper 記憶 pipeline，可能有真實模型費用；不要自行開啟。
- `model` 或各階段 observerModel／reflectorModel／dropperModel 使用 `{ provider, id }`；對應 FallbackModels 為此物件的陣列。只填實際可用且使用者選定的模型，`sessionFallback` true 時可能落到昂貴的主模型。
- 常用非模型鍵：showPreCompactionMessage、compactionSummaryMode（default／append）、recallResponseMaxChars（預設48000，0只取消回傳文字 cap）、workerAttemptTimeoutMs、debug／debugLog。
- 常用 env：PI_BLACKHOLE_MEMORY、PI_BLACKHOLE_SESSION_FALLBACK、PI_BLACKHOLE_PASSIVE、PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS。環境變數覆寫可能高於檔案設定；未列出的映射不自行推測。

## 現行 ownership 與驗證

**Pi 管理 compaction 的時點／threshold／reserve／keepRecentTokens；Blackhole 只參與摘要。** Blackhole 的 compaction off／manual 或 memory false 都不能停用 Pi auto。若要改觸發預算，使用 Pi 的 compaction.enabled／reserveTokens／keepRecentTokens，而非 legacy compactAfterTokens／midRunCompaction 等 ignored controls。

UI 明確 Save 後 runtime 即重讀；手改檔案後可 `/reload`，先處理背景工作。檔案 JSON 損壞時先修語法／備份，不用 UI defaults 直接覆寫未知舊內容。Cleanup／export／開啟 memory 不是純讀設定操作；先確認授權。Recall 不恢復舊 jobs，也不代表原始歷史全可無限掃描。
