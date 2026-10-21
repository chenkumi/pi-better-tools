# Pi Runtime

原生 Pi 1.1.0 extension：提供有上限的 **error-aware recovery**，讓 agent 在下一次模型請求看見 API 失敗診斷；不是將所有錯誤加入宿主 retry 白名單。

## 行為

- 預設啟用，每個頂層使用者任務最多 **2 次**恢復，automatic／manual 共用額度。以 Pi 1.1.0 的 idle 非 extension `input` → `before_agent_start` → `agent_start` → 首個非 system 的實際 `message_end(user)` admission，消耗一次性 phase token 後才建立新 task；不是 raw input、preflight 或文字相等就補額度。被其他 handler 消耗、串流排隊或 preflight 失敗不補額度。template／transform／image hints 改變文字不阻止真正新 user task 重置；extension 發出的 prompt、內部 continuation、重試、壓縮、tree 及 reload 不補額度。排隊 steering 屬於目前頂層任務。
- 若宿主在 `before_agent_start` 提供 `messageType`，明確非 `user` 的 run 會清除 admission 候選；沒有此欄位的 Pi 1.1.0 維持既有證據鏈。`user` 亦可能來自 extension，仍須核對非 extension input 與實際 user message，不能僅憑 trigger 類型重補額度。此分類有單元防護，不代表已完成 Pi 1.2.0 host／production 相容性驗證。
- 明確 invalid arguments／tool JSON 類錯誤（泛用 invalid_request_error 不足以自動恢復）：在 `agent_before_settle` 追加診斷 `custom_message` draft 並要求一次 continuation，保留其他 extension 的 drafts。相同診斷自動恢復一次後再次出現，就暫停，不盲目重送。
- 網路／transient、context overflow、auth／billing／quota：維持宿主處理，不增加另一層 retry，也不更換 provider/model。
- **cyber／policy 及未知錯誤不自動恢復或改寫**。保留待人工 review 診斷；合法用途／授權範圍澄清及明確確認後，才允許有限次診斷回饋。確認不代表解除 OpenAI safeguard、取得 Daybreak 或授予工具權限；禁止為放行而隱藏、拆分或改寫受禁止請求。
- 需要持久化 session；`--no-session`／in-memory session 不自動恢復。當前 session 已選模型須與失敗模型相同；虛擬／已變更模型無法確認相同時保守暫停。
- 保留原始失敗 assistant 訊息及權威 usage；不替換 error 為 success、不執行 error response 裡的 partial tool calls、不啟用任何工具。API safeguard 可能仍攔截下一次請求，不能保證 agent 一定收到診斷或修復成功。

## 指令

```text
/runtime-recovery status
/runtime-recovery off
/runtime-recovery on
/runtime-recover 我正在測試自己擁有的本機程式，範圍是唯讀分析……
```

`on/off` 只改目前 session／branch 的偏好，不寫個人設定，也不重置當前 task 額度。

`runtime-recover` 要求 8–4096 字元澄清、**idle TUI**、未耗盡額度、同模型／owner，以及 UI confirmation。**RPC（即使提供 confirm UI）、JSON／print 一律拒絕手動恢復**，不開 dialog、不保留額度、不提交；Pi 1.1.0 沒有公開 extension 事件／signal 可觀測 idle host `abort()`，不能承諾 RPC 過期 approval 會被 host abort 撤銷，亦不將 RPC 改標 TUI 繞過此限制。

TUI dialog 的拒絕／Escape 取消不提交；確認期間若 session／tree／model 改變（即使切回）、新 input、啟動其他 run 或可觀測 operation signal 取消則失效，並透過 dialog AbortSignal 關閉 UI；仍須重新核對 leaf、同模型及 pending error。TUI-only **不代表可觀測任何 idle SDK host abort**。簡單 retry 重複文字會拒絕，但文字與確認不構成授權證明；不允許以手動 cyber 改寫來繞過 policy。

## 狀態與失敗語意

以 active branch 的 `pi-runtime-state` custom entries 保存 task ID、已保留額度、handled error IDs、fingerprints 與最後診斷；它們不進入模型 context。選取當前 branch 的 task，再核對 session 全部同 task reservations；tree／reload 不回補其他分支已保留額度。超過 100000 entries 停止恢復。新 task ID 使用 uppercase ULID。Reload 從目前 branch 還原；最新 state 損毀時 fail closed，不退回舊 snapshot 重補額度。

診斷使用 `pi-runtime-recovery` custom message，清楚標記錯誤／澄清為不可信資料。錯誤診斷及澄清各限制 2048 字元（完整 feedback 包含固定安全說明與 JSON envelope，並非總長 2048），遮罩常見 Bearer／sk-key／api_key／access_token／authorization 格式，包括 quoted JSON 值的 escaped quote／backslash；不是完整 DLP，原始錯誤仍由宿主保留。

恢復額度先記錄再提交，保守保留不確定送達的費用／嘗試額度。手動 `pi.sendMessage` 是 submission，不是送達／成功確認，不提供 exactly-once 或自動補送。Session state 寫入失敗會停止恢復。取消、shutdown、owner/runtime 換代優先；沒有 polling／sleep／factory timer。

## Deferred 工具（本專案各模組共用）

本專案的模組要延遲載入工具時，只需在 `registerTool` 加 `exposure: "deferred"` 與 `namespace: { name, description }`，不必自帶任何啟用或提示程式；目前使用者為 `pty-terminal`（`pty`）、`schedule-prompt`（`schedule`）、`sqlite-tools`（`sqlite`，讀取資料庫前以 `tool_search` 尋找 SQLite tools）與 `sql-connector`（已配置的 `mysql`／`mssql`／`pgsql`）。Pi Runtime 的 `deferred-tools.ts` 統一處理：

- **全新 session（`startup`／`new`）**：若已登記但未啟用 `tool_search`，以 `setActiveTools` 加入它，因此不需要 `defaultTools: "+tool_search"`。`resume`／`fork` 還原已記錄的工具集，`reload` 保留當前工具集，皆不變更。
- **沒有登記的 `tool_search`**（例如 `--tools` allowlist 排除）：直接宣告本專案的 deferred 工具，與未延遲前相同；被 allowlist 排除的工具本來就不會註冊。
- **提示**：`tool_search` 啟用時，系統提示加一段 `### Deferred tools`，每個仍未載入的 namespace 一行（含查詢字串）；全部載入後消失，並處理 `forceSystemPrompt`。
- 只管理來源檔案位於本專案 `modules/` 的工具；第三方（如 MCP）的 deferred 工具不受影響，也不列入提示。
- 這是有意的例外：Pi Runtime 會替使用者啟用 `tool_search`（不改使用者 settings 檔）。不要在各模組內重複這段程式。

## 跨模組工具規則

`cross-tool-guidance.ts` 注入 system prompt section `pi_better_tools_cross_tool_rules`（約 320 tokens）。只放跨模組規則：檔案修改走 `edit`／`write`，不經 shell 重導向、`sed` 或一次性腳本（`node -e`、`perl -i`）——從 shell 改檔會繞過 edit/write 的 version token 保護，並明文標示為規則違規（file-tools 與 shell）；`subagent`／`fork` 的分工與委派原則；完成前先驗證；失敗處理與破壞性動作先確認。

- 各區塊只在其提到的工具已啟用時出現（例如沒有 `subagent`／`fork` 就沒有委派區塊，只有 `fork` 時不提 `subagent`）。
- 單一模組的工具用法（`note`、web、SQLite、`monitor`、`recall` 等）由該模組自己注入，不放這裡；Pi 內建 prompt 已有或工具描述已涵蓋的內容也不重複。
- 與背景工作生命週期段落（Shell／Subagents 共用）分開，不重複其取消與通知規則；處理 `forceSystemPrompt` 的方式與其相同。

## 重構清理

2026-10-16 移除未被入口或 recovery 流程引用的 `src/debug-log.ts` 及僅驗證該孤立 helper 的測試；沒有接入或新增 failure logging，沒有新增 `pi-runtime.debugLog` 設定。現有 `policy.ts` 診斷遮罩、session reservation、恢復與人工確認流程不變。

## 整合與驗證

入口 `./modules/pi-runtime/src/index.ts`；runtime helpers 僅使用 root 既有 ulid 與 host-provided Pi peers，無模組獨立安裝／bundle。

```bash
npm run test:module -- pi-runtime
```

Boundary 後續 handler 撤稿或取消仍保留已記錄額度；此為 fail-closed reservation，不宣稱模型確實被呼叫。

純單元測試放 `tests/recovery.test.ts`；實際 Pi 1.1.0 隔離 offline host 放 `tests/runtime.integration.test.mjs`／`tests/fixtures/runtime-host.mjs`。Fixture 使用非秘密 synthetic provider、禁止 network fetch，不讀取真實 credentials；14 modes 驗證正常恢復、2 次上限、重複停止、真正 transformed／template 新 user task reset、政策 RPC refusal、TUI 確認拒絕／接受、model／tree 往返撤銷過期確認、reservation-before-feedback、取消、withdrawn 不退款、reload、no-session 及 JSON credential 診斷遮罩。

TUI probe 使用官方 SDK `InteractiveMode` 與可注入的離線 Terminal，透過真實 `showExtensionConfirm`／`ExtensionSelectorComponent` 的 render 與 keyboard path，在 dialog-open 事件 barrier 驅動 Escape／Enter；不是 fake `confirm:true` 或把 RPC 改標 TUI。這是 host-supported UI integration，**不是人工 fullscreen／實體終端測試**。Root production tarball acceptance 由根 owner 另跑，不以 workspace green 代替。

Host admission 沒有公開 run/task ID；Runtime 的一次性 phase token 與 user message 物件 identity 只針對已核對的 Pi 1.1.0 event ordering。`message_end` 在 native user entry 寫入前，不能宣稱此事件已收到 durable entry ID；真實 host 測試在 prompt 完成後核對同一 admitted user 物件的 persisted entry。

授權：根 MIT LICENSE；此模組是使用者要求的新原生實作，不是來源快照。
