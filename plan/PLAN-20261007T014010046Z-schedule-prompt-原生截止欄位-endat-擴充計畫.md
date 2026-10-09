# Schedule Prompt 原生截止欄位 endAt 擴充計畫

## 範圍與狀態

- 原為規劃文件；使用者已授權依計畫實作。2026-10-07 實作與範圍內驗證完成：截止驗證、timer／執行防線、條件式 storage 停用、工具與 UI 已接上。實際載入中的舊 extension 需 /reload 或重啟後才有新 schema／防線。
- 初次模組 TS 型別與原有 vitest 122 tests 通過。新增核心 62 tests 初跑 61 通過、1 失敗（測試替身不能 spy ESM fs export）；已改為可控 performance 時鐘驗證鎖預算耗盡，不削弱禁止無鎖 mutation 斷言，後續重跑已通過。
- 中途一輪 195 vitest tests 已通過；含兩輪 review 修正的最終模組驗證（截至 02:04:17Z）：206 vitest tests／13 files（原 122 + 新增 84）、TS typecheck、專屬真實 Pi 1.0.0 host probe 全通過，零 skip。證據 `plan/evidence/module-schedule-prompt.json` 與 `schedule-prompt-*.log`。
- 最終 `npm run test:cross`（截至 02:04:56Z）三階段通過（SDK hooks／provenance fixture／九入口七種 loader 模式），sources:verify 通過；5 筆既有 historical delta 警告未消失，不能冒稱歷史 diff 等價。
- 根第一次 `npm test` 已完成：Subagents 階段 223 tests 中 215 通過、8 個 runner-io 故障注入案例失敗，在注入預期 I/O 前即遇 300ms setup 期限。其餘階段未失敗，File Tools 有 1 個既有 skip，不能算通過。原始紀錄保留於 `plan/evidence/schedule-deadline-unit-initial.json`、`schedule-deadline-subagents-initial.log`。其他模組未修改，未放寬期限／斷言。
- 停止其他重度驗證後隔離重跑 `runner-io.test.ts`，17/17 通過、零 skip（`plan/evidence/schedule-deadline-runner-io-recheck.log`）；資源競爭造成早期 setup 到期是推論，不能用此結果抹除第一次根測試失敗。第二次根 `npm test` 10/10 階段完成、零失敗（Subagents 223/223 通過）；File Tools 的 Windows 平台既有 1 skip 仍未驗證，不算通過。先完成 Subagents 的敏感 setup 階段才啟動其他重度驗證。最終根 `npm run typecheck` 9/9 通過（截至 02:06:19Z），`npm run build` 通過且按 manifest 為 no-op。
- 獨立 reviewer 唯讀指出非同步初始化可能跨過截止後才呼叫 prompt。已採納修正：`src/subagent.ts` 增加內部 prompt-admission guard，在所有初始化 await 完成後再查最新期限；scheduler 對 skipped setup 不計 execution／lastRun、不 notify，恢復先前 status，原 finally 釋放 session／subscription／timer。截止前已開始的 prompt 仍可完成；once admission 後自動停用不誤擋。
- 新 `test/deadline-subagent.test.ts` 使用真實 scheduler／runner、只 mock SDK，控制 reload/create/bind barrier；8 項專屬與原 scheduler 43 項 focused 測試通過，TS 模組檢查通過。複查另指出 disabled recurring job 延長／清除 deadline 後仍可繞過停用；已增加 fresh.enabled 門檻及本次 once 自動停用的有限例外，add/update/remove/stop/finally 撤銷標記。增加兩項 recurring 停用後更改期限與一項手動 once 停用回歸測試，以及 subscription 清理斷言；11 項新 runner 測試全部通過。第三輪 reviewer 僅唯讀靜態核對，確認原缺口封閉、未發現新的重要問題；未冒稱動態測試證據。
- 分組理由：修改單一 schedule-prompt 模組故執行 `test:module -- schedule-prompt`；新增 host fixture／runner 與 provenance 故執行 `test:cross`；程式碼修改故跑根 `npm test`，TS/schema 修改故跑根 `typecheck`。未執行全量 `test:integration`、`test:package`、`check`、`test:browser`（未發布／更動 package files 或 Web）；這些均不算通過。
- 本工作目錄沒有 `.git`，`git diff --check`／status 無法使用；以工具逐次 diff、來源 hash/provenance 與測試驗證，未建立 Git commit／發布。未修改真實 settings/auth/排程；host probes 全離線、隔離 temp home/workspace，無付費模型呼叫。
- 依本地 `modules/schedule-prompt/src/{types,scheduler,storage,tool}.ts`、`src/ui/add-flow.ts`、`src/ui/jobs-view.ts`、模組 README、既有測試片段、根 package scripts 與 `docs/configuration.md` 規劃。
- 目標：不透過額外 prompt，讓排程器於截止後拒絕新的觸發並自動停用工作。
- 非目標：執行次數上限、起始時間、OS 排程、強制終止已開始的 agent、依賴／Pi 升級。維持 Pi 1.0.0 基準、第三方來源與 MIT 身份。

## 1. 建議行為契約

### 欄位

持久化 `CronJob` 新增可選的 `endAt?: string`，儲存為 UTC ISO 時間字串。

工具新增 `endAt?: string | null`：

| 操作 | endAt 語意 |
|---|---|
| add 未提供 | 無截止，保持現有行為 |
| add 字串 | 設定截止 |
| add null | 拒絕；無截止應省略 |
| update 未提供 | 保留原值 |
| update 字串 | 替換截止 |
| update null | 清除截止，儲存時移除欄位 |

第一版只接受含明確時區的 ISO 日期時間（`Z` 或 `±HH:mm`）；不接受純日期、無時區時間、自然語言或相對時間。理由：避免時區歧義與 update 重設相對期限的不確定性；自然語言仍由 agent 換算為絕對時間後呼叫工具。

驗證必須檢查實際日曆日期，不僅依賴 `Date.parse` 寬鬆解析；有效輸入統一轉成 UTC ISO。add／設定新截止時要求截止嚴格晚於驗證時刻；工具與 UI 共用驗證邏輯，存檔前再檢查，避免使用者長時間停留確認畫面。

### 截止邊界

- `now >= endAt` 即過期；恰好等於截止時不觸發。
- cron、interval、once 都適用。once 的排定時間必須嚴格早於截止；update 必須驗證合併後的 schedule 與 endAt。
- recurring 首次執行若落在截止之後，允許建立；到期停用、可能執行零次，不新增「必須至少執行一次」規則。
- 到期清除該工作的排程資源，持久化 `enabled: false` 並清除 `nextRun`。不修改 `lastRun`、`runCount` 或既有 `lastStatus`；到期不是執行錯誤。
- 保留資料以便查看；既有 cleanup／session exit 清理 disabled jobs 的政策不變，不保證永久保留到期紀錄。
- UI 顯示「已到期」由有效 endAt 與當下時間推導，與最近執行結果分開，不擴張 `CronJobStatus`。

### 「結束」的保證範圍

截止限制的是排程器的新投遞／新啟動，而不是整個任務的完成時間。

- 截止前已啟動的 in-process agent 可繼續完成、寫入結果並按原 notify 規則通知。
- 截止前已投遞的 inline followUp 可能在截止後才被主 agent 處理；不撤回 host 佇列訊息。
- 不聲稱即時硬截止或強制終止工具／程序樹。event loop 阻塞或系統睡眠會延遲持久化停用，但恢復後必須先檢查截止，不補跑。
- Pi 關閉時沒有背景 timer；重啟載入後辨認過期並停用。已到期且已停用的工作不因系統時間回撥自行恢復。

## 2. 排程器設計

採用「獨立截止 timer + 啟動／執行入口防線」，不單獨依賴 croner 的 options，因為 interval／once 也必須遵循相同契約。

1. 新增每 job 一個截止 timer 的 Map，不與既有 interval／once Map 混用。
2. `scheduleJob()` 掛排程前檢查 endAt；過期者直接進入停用流程。手動寫入的無效值採 fail-closed：不執行，回報可診斷錯誤並嘗試停用，不把無效截止視為無截止。
3. 對有效截止設置 timer。分段延遲不超過 `MAX_TIMER_MS`；建議再以 60 秒作為最長檢查段，讓時鐘跳動可在有界週期內被重新評估。此段長是時鐘重查週期，不是觸發精度；短於此段的期限仍直接排至截止。
4. 截止 callback 重讀 storage 並檢查最新 endAt／enabled／session scope，不使用舊 closure 停用已延長或清除截止的工作。重讀發現變更時更新本地截止 timer；已被刪除或停用則釋放本地資源。
5. `executeJob()` 既有 fresh storage 讀取後加入截止驗證；inline 投遞及 model 啟動前再做時間檢查，以涵蓋同步 storage 操作跨越截止的情況。不得靠 timer callback 順序决定恰好截止時是否放行。
6. 到期處理應可重入；成功停用僅發一次必要 update 事件。更新持久化期限前不要用整筆舊 job 覆寫最新內容。
7. 在 storage 既有鎖內做「重讀 → 驗證仍過期且 scope 適用 → 局部停用」，避免其他 process 延長期限後遭舊 callback 覆蓋；沿用目前有界／best-effort 鎖，不宣稱跨 process 強交易或 exactly-once。若無法取得鎖，截止 mutation 應回報／延後，不採無鎖覆寫；這是新 mutation 的安全要求，不順帶全面改寫 storage。
8. 儲存失敗時仍依執行入口防線拒絕過期工作；停止本地觸發資源、回報錯誤，讓重啟可再次協調停用。不把失敗回報成成功，不增加無界重試。
9. `unscheduleJob()`、remove、update、stop、session reload 都清理截止 timer；更新時清掉舊 timer 再掛最新期限。截止停用不 abort 已在跑的 agent，session stop 仍遵循原 abort 流程。
10. `getNextRun()` 不回傳大於等於截止的時間。維持現有僅 cron 可取得 nextRun 的範圍，不為此功能另行重寫 interval／once next-run 計算。

## 3. 工具與 UI

- `tool.ts`：add／update／enable 共用截止驗證；enable 拒絕仍有過期或無效截止的工作，提示先延長／清除期限。update 不自動啟用 disabled job；使用者須明確 enable。
- UI toggle 同樣拒絕過期工作，不能繞過 tool 防線。
- add-flow 新增「無截止／指定截止」選擇，指定時輸入含時區 ISO，無效可重試；取消與留空不混為一談。確認畫面列出截止。
- tool create／update／list 回覆與 renderResult 顯示 endAt；jobs-view 選中詳情與 widget 顯示期限／已到期，注意窄視窗寬度與其他 session 唯讀規則。
- 第一版不新增完整 UI 編輯流程；既有工作的期限更新／清除使用 schedule_prompt update。

## 4. 檔案與實施步驟

1. **契約／驗證**：`src/types.ts` 加欄位與 schema；新增小型 `src/deadline.ts` 共用純驗證／過期判定，集中此功能，不抽出通用 scheduler framework。
2. **執行與資源**：`src/scheduler.ts` 加截止 timer、入口檢查、清理與 nextRun 過濾；`src/storage.ts` 加窄範圍條件式過期停用 mutation。
3. **工具／UI**：`src/tool.ts`、`src/ui/add-flow.ts`、`src/ui/jobs-view.ts`、`src/ui/cron-widget.ts` 同步行為與顯示。
4. **測試**：沿用 `modules/schedule-prompt/test` 的 vitest runner，新增 deadline 測試及補充 scheduler／tool／storage／widget 測試；真實 host probes 放既有 integration 的 Schedule Prompt 分組。
5. **文件與 provenance**：更新根 README、模組 README／CHANGELOG、`docs/configuration.md`、`docs/adaptations.json`；按既有 provenance 格式記錄新增本地檔案及來源差異，不改寫匯入來源基準假裝無差異複製。

## 5. 相容性

- 舊 jobs 沒有 endAt，行為不變；可選欄位沿用 store version 1，無需批次遷移。
- 不改工具名稱、舊 action、設定鍵、儲存路徑、session scope、共享工作多 Pi 觸發語意、既有並行限制或 provider credentials。
- 老版本 extension 不會強制 endAt。降版或新舊版本混跑不能視為安全截止保障，文件必須明講；不為此變更引入完整版本協商系統。
- 直接手改 JSON 仍建議 reload；執行入口重讀為額外防護，不承諾完整熱重載所有 schedule 欄位。

## 6. 驗證案例與驗收

使用 fake timers／可控時鐘；不新增固定 sleep、idle 或 watchdog 型測試，不呼叫付費模型，storage 與 host 測試用隔離 workspace／home。

| 情境 | 預期 |
|---|---|
| 無 endAt 的舊工作 | 舊排程行為不變 |
| UTC 與 offset 等值時間 | 正規化為相同 UTC；無時區、無效日曆日期拒絕 |
| 截止前 1ms／等於截止／截止後 | 只有截止前允許投遞／啟動 |
| interval／cron／once | 同一邊界，once schedule >= endAt 拒絕 |
| 首次 tick 晚於截止 | 零執行且到期停用 |
| 到期無 tick | 截止 timer 仍停用、清 nextRun、釋放排程資源 |
| sleep／時鐘跳動／逾期重啟 | 恢復後不補跑；startup 持久化停用 |
| 超過 MAX_TIMER_MS 的期限 | 分段等待，不提早觸發或 1ms 洪泛 |
| update 延长、縮短、null、未提供 | 舊 timer 無效；保留／清除契約正確 |
| 其他 writer 延長期限、disable、remove、session rebind | 舊 callback 不誤停用最新工作、不越 scope |
| enable／UI toggle 過期工作 | 拒絕；延長／清除後才可明確 enable |
| 截止前 in-flight agent 截止後完成 | 不 abort、不重啟工作，結果統計保持停用且 nextRun 空 |
| 同步存檔跨越截止／callback 同時就緒 | 實際投遞／啟動前再檢查，截止不放行 |
| storage 失敗／無法取鎖／listener 失敗 | 不新執行過期工作、不未處理 rejection、不覆寫並行延長 |
| update/remove/stop/reload | 無截止 timer 洩漏、無重複 callback |
| UI／工具結果／舊資料 roundtrip | 正確顯示，null 清除不持久化為 null |

實作後實際執行：

- `npm test`：修改程式碼的基本回歸。
- `npm run typecheck`：新增 TS 欄位／schema。
- `npm run test:module -- schedule-prompt`：該模組單元、整合、真實 Pi 1.0.0 host probes。
- `npm run test:cross`：provenance JSON 與跨 extension 載入驗證。
- 不涉及 package files／入口／依賴更新，預設不跑全部 integration、package、browser；若實作擴大此範圍，重新判斷分組。

验收核心：在可控時鐘下，任何 now >= endAt 的新觸發都不投遞、不啟動 agent；到期可安全停用、資源可清理，更新與重載不遺漏期限防線。不能以跳過或未執行當通過。

## 待確認決策

建議採上述第一版預設：**ISO 含時區、截止邊界排他、已啟動工作不強停、update null 可清除**。若需要 `+1h` 相對期限或「截止就取消正在執行的工作」，應作為後續獨立需求，而不是默默加入本次 endAt 契約。
