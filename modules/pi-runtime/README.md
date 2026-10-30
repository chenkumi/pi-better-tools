# Pi Runtime

原生 Pi extension，只提供本專案模組共用的基礎設施：設定面板共用層、deferred 工具統一處理、跨模組工具規則。本身不註冊工具或指令，也沒有設定鍵。

> 原 error-aware recovery（`/runtime-recovery`、`/runtime-recover`、`pi-runtime-state`／`pi-runtime-recovery`）經測試沒有實際作用，已整個移除。舊 session 內殘留的這些 entries 無作用；Blackhole 仍可唯讀投影舊的 `pi-runtime-recovery` custom message。

## 設定面板共用層

`src/settings-panel/` 供各模組宣告 `SettingsSchema`（欄位、`visibleWhen`、`toValues`／`toPatch`，驗證沿用模組自己的 parser）並呼叫 `registerSettingsCommand` 註冊 `/settings:<id>`。面板（`ctx.ui.custom` overlay）、保留未改欄位的 patch 合併、原子寫入與 secret 遮罩都在此集中；只有按存檔才寫檔，載入 extension 不寫。secret 欄位的既有值不載入面板，輸入值只經 `onSave` 傳出。`code` 欄位顯示一組產生的值（Enter 以 `generate()` 即時換新、存檔才寫入、Esc 放棄）；`SettingsSchema.unsaved` 列出尚未儲存的初始值（視為已變更，存檔才會寫出）。`SettingsSchema.afterWrite` 供檔案以外的效果（如另存於使用者層的憑證）：在檔案寫入成功後執行，回傳字串即為存檔錯誤；沒有 patch（只改了檔外項目）時不改動檔案。存檔流程為匯出的 `saveSettings`（可單獨測試）；`SchemaSource` 可為 async。欄位類型含 `action`（一次性操作，例如下載：Enter 兩次確認、背景執行並回報進度、`Esc` 或關閉面板即中止，不屬於存檔內容）。面板樣式固定：圓角框、標題在上邊框、說明行與按鍵提示行各固定一行（過長以 `…` 截斷）、高度固定。欄位可用 `tab`（預設為 `group`）分頁，`Tab`／`Shift+Tab` 切頁，所有分頁共用同一個高度（取各頁在單一 enum／boolean 切換下可達的最高值，只增不減）。目前使用者：web-tools（`/settings:web-tools`，Search／Fetch 兩頁）、sqlite-tools（`/settings:sqlite-tools`）、sql-connector（`/settings:sql-connector`，每種資料庫一頁）。

## Deferred 工具（本專案各模組共用）

本專案的模組要延遲載入工具時，只需在 `registerTool` 加 `exposure: "deferred"` 與 `namespace: { name, description }`，不必自帶任何啟用或提示程式；目前使用者為 `pty-terminal`（`pty`）、`sqlite-tools`（`sqlite`，讀取資料庫前以 `tool_search` 尋找 SQLite tools）與 `sql-connector`（已配置的 `mysql`／`mssql`／`pgsql`）。`schedule-prompt` 依使用者要求改為直接宣告，不再有 deferred namespace。Pi Runtime 的 `deferred-tools.ts` 統一處理：

- **全新 session（`startup`／`new`）**：若已登記但未啟用 `tool_search`，以 `setActiveTools` 加入它，因此不需要 `defaultTools: "+tool_search"`。`resume`／`fork` 還原已記錄的工具集，`reload` 保留當前工具集，皆不變更。
- **沒有登記的 `tool_search`**（例如 `--tools` allowlist 排除）：直接宣告本專案的 deferred 工具，與未延遲前相同；被 allowlist 排除的工具本來就不會註冊。
- **提示**：`tool_search` 啟用時，系統提示加一段 `### Deferred tools`，每個仍未載入的 namespace 一行（含查詢字串）；全部載入後消失，並處理 `forceSystemPrompt`。
- 只管理來源檔案位於本專案 `modules/` 的工具；第三方（如 MCP）的 deferred 工具不受影響，也不列入提示。
- 這是有意的例外：Pi Runtime 會替使用者啟用 `tool_search`（不改使用者 settings 檔）。不要在各模組內重複這段程式。

## 跨模組工具規則

`cross-tool-guidance.ts` 注入 system prompt section `pi_better_tools_cross_tool_rules`（全部工具啟用時約 490 tokens，一般更少）。只放跨模組規則：

- **並行**：獨立的工具呼叫在同一回合送出。
- **專用工具優先於 shell**（需 `bash`／`powershell` 啟用）：用已啟用的 `read`／`grep`／`find`／`ls` 代替 shell 的 `cat`／`rg`／`find`／`ls`；用 `web_fetch`／`web_search` 代替 `curl`／`wget`；有 SQLite／SQL Connector 工具時不用資料庫 CLI 或驅動腳本；不得用 shell 繞過專用工具拒絕的事（確認、allowlist、私有位址、大小上限）。只列出實際啟用的工具名。
- **檔案修改**走 `edit`／`write`，不經 shell 重導向、`sed` 或一次性腳本（`node -e`、`perl -i`）——從 shell 改檔會繞過 edit/write 的 version token 保護，並明文標示為規則違規。
- **委派**：`subagent`／`fork` 的分工；獨立的 subagent 同一回合啟動以並行；委派結果是主張不是證明。
- 完成前先驗證；失敗處理與破壞性動作先確認。

- 各區塊只在其提到的工具已啟用時出現（例如沒有 `subagent`／`fork` 就沒有委派區塊，只有 `fork` 時不提 `subagent`）。
- 單一模組的工具用法（`note`、web、SQLite、`monitor`、`recall` 等）由該模組自己注入，不放這裡；Pi 內建 prompt 已有或工具描述已涵蓋的內容也不重複。
- 與背景工作生命週期段落（Shell／Subagents 共用）分開，不重複其取消與通知規則；處理 `forceSystemPrompt` 的方式與其相同。

## 整合與驗證

入口 `./modules/pi-runtime/src/index.ts`，只呼叫 `registerDeferredTools` 與 `registerCrossToolGuidance`；僅使用 host-provided Pi peers，無模組獨立安裝／bundle。設定面板層由各模組直接 import `src/settings-panel/`。

```bash
npm run test:module -- pi-runtime
```

測試：`cross-tool-guidance`、`deferred-tools`（單元與整合）、`settings-panel`、`settings-save`。

授權：根 MIT LICENSE；此模組是使用者要求的新原生實作，不是來源快照。
