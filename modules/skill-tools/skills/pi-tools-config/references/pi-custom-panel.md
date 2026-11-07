# Pi Custom Panel：輸入框、footer 與工具外觀

## 指令與工具

- 沒有模型工具，也沒有設定指令。已移除的 `/open-tui` 與其 telemetry／peek／圖示設定不存在，不要建議使用者輸入。
- 只在互動 TUI 安裝：輸入框 `❯` 提示符、兩行 footer，以及所有工具的兩行收合外觀（`subagent`、`subagent_message`、`fork` 保留自己的 renderer）。
- 游標沿用 Pi 預設（`PI_HARDWARE_CURSOR`／`showHardwareCursor`），本模組不設樣式。

## Config 與作用範圍

**沒有專屬設定檔。** 載入時只註冊 hook，不寫任何 settings；舊的 `~/.pi/agent/open-tui.json` 不再被讀取。想關閉此外觀，在 package 的 `extensions` filters 排除 `modules/pi-custom-panel/src/index.ts`，`/reload` 後還原 Pi 內建的 footer 與 editor。

外觀問題（排版、顏色、收合）屬於實作而非設定，不要為此改使用者的 settings；需要修改請走該模組的設計文件。
