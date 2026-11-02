# Pi Auto Compact

原生模組：以**確定性純函式**壓縮歷史，**不呼叫任何模型**。把歷史由新到舊分成 L1（原樣）、L2（工具呼叫折成一行並附 recallId）、L3（只留對話）三層，各有字元預算，溢出者滑動丟棄。完整設計見本機計畫 `plan/pi-auto-compact-plan.md`（`plan/` 不進版控）。

## 目前狀態：M1 骨架

- 已註冊 `session_before_compact` hook 並驗證設定檔，**尚未產生任何摘要**：hook 一律回傳 `undefined`，壓縮完全交還 Pi。
- 不註冊工具、命令或訊息。
- L1/L2/L3 投影、折疊規則、固定狀態區塊、系統狀態移植依序為 M2～M4，尚未實作。

## 只掛其一

本模組與 Blackhole **只掛其一**。兩者都掛在 `session_before_compact`，同時掛載時**不做任何協調**，行為未定義。切換方式是在 Pi package 設定中啟用／停用對應的 extension 入口（`./modules/pi-auto-compact/src/index.ts` 或 `./modules/blackhole/src/index.ts`），不是設定鍵；也不修改 Blackhole 的任何設定。

## 設定

使用者層 `<agentDir>/auto-compact.json`（預設 `~/.pi/agent/auto-compact.json`，路徑由 Pi 的 agentDir 解析）。檔案可省略；省略的鍵使用預設值。本模組只讀不寫，載入 extension 不改任何 settings。**沒有開關鍵**，也沒有專案層設定。

| 鍵 | 預設 | 範圍 | 說明 |
|---|---|---|---|
| `l1Ratio`／`l1MinChars` | 0.3／30000 | 比例 (0,1]；正整數 | L1 預算 = `max(ctx × 比例, 最小值)` 字元，`ctx` 為模型 context window 的 token 數 |
| `l2Ratio`／`l2MinChars` | 0.2／20000 | 同上 | L2 預算 |
| `l3Ratio`／`l3MinChars` | 0.1／10000 | 同上 | L3 預算 |
| `charsPerToken` | 2.2 | 1～8 | 估算 token 用；Pi 內建為 4，中文為主的 session 實測約 2.2 |
| `maxTotalRatio` | 0.5 | (0,1] | 估算總量占 context window 的硬上限；超過時先縮 L3、再縮 L2，不縮 L1 |

- 未知鍵、型別錯誤或超出範圍都是**錯誤**，不退回其他值；hook 會以 warning 通知一次（有 UI 時），並把壓縮交還 Pi。
- 檔案不存在視為全部預設。

## 驗證

`npm run test:module -- pi-auto-compact`：設定預設值／覆寫／嚴格驗證／唯讀、hook 註冊與交還 Pi 的行為。尚未做真實 Pi host 的整合測試（M5）。
