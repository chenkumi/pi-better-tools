# Theme Tools

原生模組：提供六組 Pi 配色主題與 `/theme:<id>` 切換指令。

## 指令

| 指令 | 作用 |
|---|---|
| `/theme:deep-sea`、`warm-charcoal`、`moss`、`quiet`、`signal`、`paper` | 切換到對應的 `pi-better-<id>` 主題 |
| `/theme:dark`、`/theme:light` | 回到 Pi 內建主題（保證有退路） |
| `/theme:menu` | 開選單，目前主題標 `(current)` |

## 行為

- 不註冊無後綴的 `/theme`（與 Pi 原生指令衝突），也沒有 `/theme <名稱>` 形式。

- 主題檔在 `themes/`，由根 `package.json` 的 `pi.themes` 宣告為套件資源，啟動前即可解析，所以持久化的選擇下次啟動仍有效。`paper` 是淺色主題，其餘為深色。
- 切換呼叫 Pi 的 `ctx.ui.setTheme(name)`，與 `/settings` 相同：**會寫入使用者的 settings 並持久化**（使用者明確要求）。只有輸入指令時才寫；載入 extension 不碰 settings。
- 無 UI（print／rpc）時不做任何事。失敗（找不到主題等）以 warning 通知並列出可用名稱，不丟例外。
- 所有 extension 的畫面（背景面板、Shell／Subagent／Fork／Monitor 卡片）使用的都是 Pi 主題色票，換主題即全部跟著換；本模組不指定任何 extension 專屬顏色。
- 主題檔的 `name` 必須等於檔名（Pi 以此熱重載目前主題）。新增主題時同步 `src/index.ts` 的 `THEMES` 與 `themes/`，測試會核對。

## 驗證

`npm run test:module -- theme-tools`：指令表、主題檔一致性、切換／失敗／無 UI／選單／補全。尚未做真實終端機的目視確認。
