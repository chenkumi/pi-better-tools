# Subagents 背景輸出 TUI 改善

使用者要求改善 subagents 輸出。新增原模組內的背景 renderer：subagent_background（log_ready/task_result/control_result/query_result）、status/cancel/message 管理結果、subagent 背景派發 receipt。同步模式既有進度與 Markdown renderer 保留。

只改顯示，content/structuredContent（display details僅額外保留query顯示證據）、followUp/triggerTurn、usage accounting、scheduler、child args/guard/32 submitted與8 active限制、取消與查詢生命週期不變。不讀 log、不執行工具；取消只標要求，control accepted/queued不等於applied；query snapshot/unknown usage/late usage/cleanup pending須誠實呈現。

收合顯示有界 job/task狀態、agent與結論，展開顯示IDs、原有log/session、錯誤與保留輸出/usage/互動。舊JSON/text blocks有安全fallback，不信任Error字詞判斷狀態。清理ANSI/OSC/C1/bidi、Unicode欄寬，限制欄位與總300行。log_ready明確為通知時快照，並區分live log及尚未存在的future final path。

## 結果與驗證

- 已完成兩個新檔：`modules/subagents/extensions/subagent/background-renderer.ts`、`modules/subagents/tests/background-renderer.test.ts`；index註冊新 custom message renderer、共用管理結果及背景派發 receipt。同步 foreground renderer 保留。
- Review確認 aborted不可被signal exitCode改稱failed、完成通知缺query快照／cleanup證據；已修正前者、在display details加cleanupPending/asOf/lateUsage/outputTruncated。model content／structuredContent與followUp原樣。新增aborted回歸及既有RPC integration的completion metadata保留斷言，無新增sleep／放寬時限。靜態複查確認缺口閉合，沒有新重要問題；不冒稱review跑過動態測試。
- 最初新測試錯誤匯入Pi TUI未公開的stripAnsi導致測試啟動失敗，已改node:util stripVTControlCharacters；後续14/14專屬測試與TS通過，不是產品執行失敗。
- 根 `npm test` 10/10階段零失敗（在後續review修正前跑的root unit，Subagents當時236）；File Tools仍有1項既有Windows平台skip（229/230），不算通過。原紀錄保存於`plan/evidence/subagent-renderer-unit-initial.{json,log}`。
- 根 `npm run typecheck` 9/9通過；最終`npm run test:module -- subagents` 3/3通過：TS、**237 unit／36 integration**，零skip；含最新14項renderer cases、真實Pi1.0.0 CLI與RPC control/query metadata回歸。根unit先結束再跑模組重度驗證，沒有重現過去的setup timeout。
- `sources:verify`驗證195 snapshot hashes／94 adaptations／70 added files／21 native files，保留5項既有historical delta warnings，不宣稱歷史diff等價。
- `test:cross` 3/3通過：SDK hooks、provenance、manifest loaders，實際註冊的subagent_background與status/cancel/message renderer已檢查，涵蓋收合／展開、欄寬1/2/12/24/80、Unicode／控制安全、模型content/details不被renderer修改。
- README、configuration與provenance已同步。證據`plan/evidence/{module-subagents,cross,typecheck}.json`與各組log，另存`plan/evidence/subagent-renderer-final-pipeline.log`。

分組理由：改TS／程式碼跑root unit/typecheck與模組完整組；改fixtures／provenance跑cross。未執行全量integration/package/browser/check/build（build原no-op），未人工fullscreen／實際使用者TUI驗證；未執行不是通過。離線fixtures，不呼叫真實付費provider，不改settings/auth/排程；沒有.git，未commit／發布。

待背景工作完成後`/reload`才載入新renderer。展開只呈現已保留資料，不讀log；historical log_ready的狀態／路徑是通知時點，不查證目前檔案存在。所有上限及控制／查詢／取消／用量語意不變。