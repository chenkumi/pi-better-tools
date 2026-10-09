# Subagents 背景輸出 TUI 改善完成

## 交付

已新增 `modules/subagents/extensions/subagent/background-renderer.ts`，註冊 `subagent_background` 自訂通知，整理 `subagent_status/cancel/message` 與背景派發 receipt；同步模式既有進度／Markdown保留。

- 收合：job/task狀態、agent與結論，列表有省略提示，不再堆JSON。
- 展開：完整ID、已提供的live/final log、session、錯誤與保留輸出、獨立用量與互動。最多300行、64 jobs／32 tasks與互動、單欄位8192字元；不讀log、不恢復丟棄內容。
- ANSI／OSC／C1／bidi與Unicode欄寬、malformed／legacy JSON/text blocks安全處理，不依Error字詞判定失敗。log_ready是歷史事件快照，future final path不冒稱該時點已存在。
- aborted保留原狀態；cancel只是要求、control accepted／queued不是applied；query snapshot／stale、未知／晚到用量、cleanup pending不誤稱provider已停止。完成通知的display details補保留query cleanupPending/asOf/lateUsage/outputTruncated，模型content/structuredContent、followUp/triggerTurn、usage accounting、guard／並行上限與生命週期不變。

README、configuration、provenance同步。等背景工作結束後 `/reload` 才載入新renderer。

## 實際驗證

- 專屬renderer **14/14**；最終模組驗證 **237 unit＋36 integration**、TS，3/3階段通過／零skip。包括離線真實Pi1.0.0 CLI、RPC完成通知query快照與cleanup證據回歸。
- 根unit 10/10階段零失敗（review後修正前，Subagents當時236）；File Tools既有Windows skip一項不算通過。後續修改由完整Subagents模組unit/integration再驗證；根TS9/9。
- cross3/3：SDK hooks、provenance、實際manifest loader。包含註冊的subagent_background與管理結果renderer、收合／展開、1/2/12/24/80欄寬與不改model data斷言。
- sources：195 snapshot hashes／94 adaptations／70 added files／21 native files；5項既有historical delta警告保留，不宣稱歷史diff等價。
- 初次新測試因匯入未公開stripAnsi啟動失敗，改用node:util後通過；不是產品執行失敗。Review找到兩项狀態／query顯示證據缺口，已修正、補回歸；靜態複查未發現新重要問題，reviewer未重跑動態測試。

分組理由：程式碼／TS跑根unit/typecheck及完整模組；fixtures／provenance跑cross。重度驗證依序，避免Subagents setup競爭，未重現先前任務的setup timeout。

## 未執行與證據

未跑全量integration/package/browser/check/build（build原no-op），未人工fullscreen／使用者實際終端檢查；未跑不算通過。測試使用isolated offline fixtures，無真實provider／settings/auth/排程修改；無commit／發布。

紀錄：`plan/PLAN-20261007T024512969Z-subagents-背景輸出-tui-改善.md`。
證據：`plan/evidence/module-subagents.json`、`cross.json`、`typecheck.json`、`subagent-renderer-unit-initial.{json,log}`、`subagent-renderer-final-pipeline.log`與各組log。