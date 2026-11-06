# Pi Custom Panel

自製 TUI 模組，取代已移除的 npm `pi-open-tui`。設計依據是根目錄的 `TUI_DESIGN.md`。目前完成階段 1（主畫面）；背景任務面板、Settings／詢問框樣式、Tool call 兩行收合、Thinking 預設收合是後續階段。

## 階段 1：主畫面

- **輸入框**：沿用 Pi 的 `CustomEditor`，只在第一個文字列前加 `❯ ` 提示符（用 editor padding 留位）。邊框、捲動指示、自動完成、滑鼠與游標全部由宿主負責。
- **Footer**（兩列，另有其他 extension status 時多一列）。兩列都填滿整個寬度，沒有左右縮排；每個圖示是 Nerd Font 字元（U+F07C 資料夾、U+F0C9 context、U+F121 模型、U+F0EB 燈泡、U+F1E6 速度、U+F093 上傳、U+F019 下載），後接兩個空格，與 `TUI_DESIGN.md` 逐字元一致。需要終端機使用 Nerd Font；沒有圖示模式切換。
  1. `<資料夾>  ~\專案 · 分支`（分支名用主題主色 accent，其餘為灰），右側 `<context>  [▓▓▓░░░░░░░░░] 12.5% 34k/272k (auto)`；超過 70%／90% 改用 warning／error 色，壓縮後用量未知顯示 `?`。
  2. `<模型>  provider · model · <燈泡>  thinking`，右側 `<插頭>  Normal | <上傳>  35k | <下載>  8.9k | 🗲 98.0% | $0.011`。速度模式（`Normal`／`Fast`／`Ultrafast`）來自 GPT Speed 以 `setStatus("gpt-speed")` 發布的標籤並去掉 `Speed: ` 前綴，GPT Speed 未載入則不顯示該段；`上傳／下載／成本` 新 session 也顯示零值，`W`／`🗲`（最近一次回應的快取命中率）只在供應商回報快取時出現；快取讀取累計（`R`）不顯示。用量與 Pi 內建 footer 同一套算法（全 session 所有 entry，含工具結果、壓縮、分支摘要）。
  3. 其他 extension 的狀態（`gpt-speed` 以外）依 key 排序放在第三列。
- **顏色**：所有文字一律主題的 `dim`（同一種灰，包含 GPT Speed 的速度標籤，不沿用它自己的顏色）；只有圖示上色（資料夾／模型／下載 accent、燈泡與快取命中閃電 warning（黃）、速度與上傳 success）；金額的 `$` 用主題的 `text`（白），與數字之間一個空格，數字仍是灰。context 條的已填格依位置著色，truecolor 終端為綠→黃→紅漸層，其他終端退為主題的 success／warning／error 三段；未填格與括號為灰，百分比文字與圖示在 70%／90% 以上轉 warning／error。
- 視窗太窄時右側先被截斷，任何寬度都不會超出。

## 游標

不設定任何游標樣式：沿用 Pi 的反白假游標與 `PI_HARDWARE_CURSOR`／`showHardwareCursor` 設定（硬體游標預設關閉，聚焦時輸出 IME 定位標記）。本模組不寫 DECSCUSR、不呼叫 `setShowHardwareCursor`。

## 行為與限制

- 只在 `ctx.mode === "tui"` 安裝；載入時只註冊 hook，不寫任何 settings。`session_shutdown` 還原內建 footer 與 editor。
- 宿主會在建立 editor 後重新套用使用者的 `editorPaddingX`，因此 `PanelEditor` 覆寫 `setPaddingX`，保證至少留出提示符寬度。
- 與其他取代 footer／editor 的 extension 互斥（後載入者勝出）。
- 已移除項目：`/open-tui` 設定指令、turn telemetry（TPS／TTFT）、thinking peek、Nerd Font 圖示模式、50+ runtime 偵測、header 動畫 logo。`~/.pi/agent/open-tui.json` 不再被讀取。
- Header 沿用 Pi 內建（設計圖中的 logo 與提示列即宿主預設）。

## 測試

`npm run test:module -- pi-custom-panel`（型別檢查加單元測試）。真實 Pi TUI 的畫面以 PTY + xterm 手動確認過（見交付說明），沒有納入自動化。
