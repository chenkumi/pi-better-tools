# FUTURE_PANEL

在 Pi 的 fullscreen TUI 右側讓出一欄放面板，並把 Subagent／Fork 的即時對話串流進去。本檔是調查結果與設計草案，**尚未實作成正式功能**。實驗碼在 `tools/side-panel-spike/`（未提交）。依據為 Pi 1.5.0（`node_modules/@earendil-works/*` 與 `C:\GitHub\pi` 原始碼）與 Windows 上的實測；離線 provider，未呼叫真實模型。

## 1. 結論

- **可行，但只能靠非正式做法，且只限 fullscreen 模式。** Pi 沒有正式的側欄 API。
- **不需要 mux、PTY 或側通道。** 父代本來就透過 RPC 收到子代的事件，專案已有 `LiveTranscript`／`TranscriptView`／`BackgroundPanel`，只差把它們接到右欄。
- 調查中發現並修復一個既有 bug：`LiveTranscript` 丟掉 Pi 1.5.0 RPC 的串流 delta（見第 5 節）。

## 2. 官方入口都不夠用

| 入口 | 限制 |
|---|---|
| `ctx.ui.setWidget` | `placement` 只有 `aboveEditor`／`belowEditor` |
| Overlay（`ctx.ui.custom({overlay:true})`） | `OverlayOptions` 可錨定右側、設寬度與 `visible(termW, termH)`，但是**畫在內容上方**，沒有保留空間的選項，會蓋住對話 |
| 根版面 | 由 `createChatViewport`（`interactive-mode.ts` 約 990 行）內部組好，`fullscreenLayoutRoot` 是私有欄位，extension 沒有掛載點 |

## 3. 可行做法：包住根版面

`tuiMode` 預設是 `fullscreen`，TUI 實作（`tui-alt-screen.ts`）有公開的 `setLayoutRoot(component)`（型別 `ViewportTUI`，以 `isViewportTUI` 判斷），`pi-tui` 匯出 `HStack`（水平分欄，子項為 `{component, basis, grow, shrink, minSize, maxSize, visible(viewport)}`）。

做法：
1. 在 `session_start` 呼叫 `ctx.ui.setHeader(factory)`，factory 會收到活的 `tui` 物件（只借它取得實例）。
2. 讀私有欄位 `tui.layoutRoot` 取得原根版面（`VStack`）。
3. `tui.setLayoutRoot(new HStack([{component: original, grow: 1, shrink: 1}, {component: panel, basis: 44, grow: 0, shrink: 0}]))`。

### 實測（100×28，面板 30 欄）

- 面板固定在右側；對話區、輸入框、頁尾都自動縮到 70 欄，長回覆在窄欄內正確換行。
- 送出訊息、輸入、送出都正常；縮小到 70 欄時重新排版，面板保持 30 欄。
- 面板有自己的 `render`，每次重繪更新（計數器遞增）。

### 限制與風險

1. **依賴私有欄位 `layoutRoot`**：Pi 升級可能壞掉。專案只支援單一 Pi 版本，風險可控，但必須有測試守著（升級時失敗要明確）。
2. **`/reload` 會疊兩層面板**：重載後新 extension 把「已包過的根」又包一次（實測 `originalRoot=HStack`）。正式實作要記住原始根並在 `session_shutdown` 還原，或偵測已包過就替換。
3. **regular 模式做不到**：`tuiMode: "regular"` 沒有 `setLayoutRoot`，只能回報「沒有可包的根版面」。該模式下只剩 overlay。
4. **面板是唯讀的**：輸入焦點仍在輸入框；面板是否接受按鍵／滑鼠未試。
5. `HStack` 子項的 `visible(viewport)` 理論上可在終端太窄時自動隱藏面板，未測。

## 4. 資料路徑（全是現成的）

```
子代 pi --mode rpc ──stdout 事件──▶ modules/fork/src/child.ts（spec.onEvent）
   ──▶ LiveTranscript（shared/src/background/live-transcript.ts，記憶體內的對話副本）
   ──▶ PanelJob.transcripts（BackgroundPanel 單例持有；Fork 在 manager.ts、Subagent 在 background.ts 餵入）
   ──▶ TranscriptView（同檔，用 Pi 自己的 AssistantMessageComponent／ToolExecutionComponent 渲染）
   ──▶ 右欄
```

- `BackgroundPanel` 是以事件 rendezvous（`acquireBackgroundPanel(pi)`）共用的單例，各模組以 `attach/update/detach` 提供 `PanelSnapshot`。
- `LiveTranscript` 在終態 `release()`：右欄只在任務執行中有即時內容，完成後只剩 metadata；最終結果仍由 `fork-result` 等既有訊息送達。這是現有設計，不要為了面板改成保留。
- 面板必須與 `LiveTranscript` 一樣只是顯示層：不寫檔、不進模型 context、不影響終態或 usage。

### 端到端實測（真實 Fork 模組 + 離線 provider，120×30，右欄 44 欄）

- 右欄標題「FORKS & SUBAGENTS (1 running)」，列出 `▶ fork offline fork — running`。
- 先出現子代收到的任務提示，接著 assistant 串流文字逐步長出，超過欄高時只留尾端。
- 約 20 秒後 Fork 完成，狀態變 `· fork … — completed`，即時內容清空。
- Subagent 走同一條路（`modules/subagents/extensions/subagent/background.ts` 也餵 `LiveTranscript`），**只實測了 Fork**。

## 5. 調查中發現的 bug（已修復）

**`LiveTranscript.ingest` 丟掉 Pi 1.5.0 RPC 的串流 delta。**
- Pi 1.5.0 的 RPC `message_update` 是 delta-only：只有 `usage` 與 `assistantMessageEvent`，**沒有 `message` 欄位，也沒有 `partial`**（`docs/json.md` 的 Reconstruct streaming messages 一節明載；實測原始行也如此）。
- 修復前 `ingest` 對 `message_update` 要求 `event.message.role === "assistant"`，不符合就略過，所以每個 delta 都被丟掉。實測父代收到 40 個 `text_delta`，`LiveTranscript` 只通知 3 次（使用者訊息、assistant 開始、assistant 結束）。
- 影響：不只側欄，**現有 Jobs 面板的即時檢視**也要等每則 assistant 訊息結束才看得到內容。舊單元測試用的是帶 `message` 的舊事件形狀，所以沒抓到。
- 修法：`message_update` 沒有 `message` 時，依 `assistantMessageEvent` 把 `text_*`／`thinking_*` 折進正在串流的 assistant 項目，`toolcall_end` 以其 `toolCall` 為準；有 `message` 的舊形狀維持原行為。`toolcall_start`／`toolcall_delta` 在 RPC 上沒有 id／name，無法渲染，略過。

## 6. 尚未驗證

- **游標位置**：xterm headless 讀到的硬體游標在有、無面板兩種情況都停在最右（Pi 似乎用模擬游標），所以**無法判斷面板是否影響中文輸入法的游標定位**。
- 滑鼠滾輪、選取複製（`copy-on-select` 可能把面板文字一起選進去）。
- 各種對話框／overlay 的寬度以整個終端還是左欄為準。
- 視窗很窄時的表現、面板高頻更新的效能。
- 面板的選取與切換（目前實驗只顯示「第一個執行中的 transcript」）、捲動回看。
- 面板讀的是 `BackgroundPanel` 的私有方法 `jobs()`，正式做法需要公開的唯讀快照 API。
- Subagent 多 task 批次、`thinking`、工具串流在側欄的呈現。

## 7. 正式實作時的建議

1. 新增獨立模組或放進既有背景共用層，**不使用 `defaultActive` 以外的方式啟用**，並可由使用者停用（掛載即啟用，沿用「是否啟用由 extension 入口是否掛載決定」的慣例）。
2. 只在 `isViewportTUI(tui)` 為真時安裝，否則什麼都不做並不報錯；`session_shutdown` 一定還原根版面，`/reload` 後不得疊層。
3. `BackgroundPanel` 加公開的唯讀訂閱／快照 API，面板不碰私有欄位（`tui.layoutRoot` 是唯一例外，集中在一處並有測試）。
4. 面板內容一律當不受信任資料：沿用 `safeOutputText`／`safeJobText`，不原樣輸出控制字元。
5. 加測試：`HStack` 安裝與還原、reload 不疊層、regular 模式安全退出、窄終端隱藏、面板高度等於終端列數。
6. 升級 Pi 版本時，這條依賴私有欄位的路徑要重跑（`tui.layoutRoot` 是否仍存在、`setLayoutRoot` 行為）。

## 8. 實驗檔案（`tools/side-panel-spike/`，未提交）

| 檔案 | 用途 |
|---|---|
| `panel-ext.ts`／`run.mjs` | 最小面板：包住根版面、回聲 provider、縮放與 `/reload` 測試（環境變數 `SPIKE_REGULAR`、`SPIKE_RELOAD`、`SPIKE_NOPANEL`、`SPIKE_PANEL_WIDTH`） |
| `fork-panel-ext.ts`／`run-fork.mjs` | 真實 Fork 模組 + 慢速離線 provider，右欄顯示 Fork 即時對話（`SPIKE_CHILD_CHUNKS`、`SPIKE_CHILD_CHUNK_MS`、`SPIKE_TEE`、`SPIKE_NO_DELTA_FIX`） |
| `rpc-events.mjs` | 直接起一個 `--mode rpc` 子行程，列出事件類型與時間，確認 delta-only 形狀 |

執行需 `node --import tsx`（解析 `.js`→`.ts`），終端模擬用 `tools/pty-mcp` 的 `@xterm/headless`。`fork-panel-ext.ts` 內的 `applyDeltaFix` 是修復前用來證明串流可顯示的實例層包裝；正式修復在 `LiveTranscript` 本身，實驗檔之後可移除。

## 9. 與先前 mux 方案的關係

先前的 mux 方案（見 `FUTURE.md` 第 3、5、6、7 節）解決的是「在另一個終端窗格看到子代的畫面」。本方案不需要另一個窗格或雙通道，面板跑在 Pi 行程內，代價是只能顯示主代理這邊已經持有的資料（Subagent／Fork／Shell／Monitor／PTY 的狀態與子代對話副本），且只限 fullscreen。兩者不互斥。
