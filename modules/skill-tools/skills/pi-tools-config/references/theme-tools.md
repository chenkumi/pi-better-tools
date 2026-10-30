# Theme Tools：配色主題與 `/theme:<id>` 切換

## 指令與工具

- `/theme:deep-sea`、`/theme:warm-charcoal`、`/theme:moss`、`/theme:quiet`、`/theme:signal`、`/theme:paper`：切換到對應的 `pi-better-<id>` 主題；`paper` 是淺色主題，其餘為深色。
- `/theme:dark`、`/theme:light`：回到 Pi 內建主題，保證有退路。
- `/theme:menu`：開選單，目前主題標 `(current)`。
- 不註冊無後綴的 `/theme`（與 Pi 原生指令衝突），也沒有 `/theme <名稱>` 形式，不要建議使用者這樣輸入。
- 無額外模型工具。

## Config 與作用範圍

沒有專屬設定檔。主題檔由套件的 `pi.themes` 宣告為資源，啟動前即可解析，所以持久化的選擇下次啟動仍有效；主題檔的 `name` 必須等於檔名。

- 切換呼叫 Pi 的 `setTheme`，與 `/settings` 相同：**會寫入使用者 settings 並持久化**（使用者明確要求）。只有輸入指令時才寫；載入 extension 不會改 settings。
- 無 UI（print／rpc）時指令不做任何事。找不到主題等失敗以 warning 通知並列出可用名稱，不丟例外。
- 所有 extension 的畫面（背景面板、Shell／Subagent／Fork／Monitor 卡片）都使用 Pi 主題色票，換主題即全部跟著換；本模組不指定 extension 專屬顏色。

## 診斷

- 切換後下次啟動又變回去：檢查專案層 settings 是否覆蓋 `theme`，不要反覆寫全域設定。
- 主題名稱找不到：確認套件已載入（`/theme:menu` 能開啟即表示 extension 已載入），並以 warning 列出的名稱為準。
- 想停用：從 Pi 的套件／extension 設定排除 Theme Tools，主題檔資源也會隨之不提供。
