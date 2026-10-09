# Subagent 與 Shell 英文訊息套用

## 結論
依使用者明確授權，已將英文訊息比較表 A–E 套用至產品與對應測試、文件；針對性回歸56/56與provenance通過。本次選定分組已完成：根typecheck9/9、根unit10/10、Subagents3/3、Shell3/3、cross3/3通過；根unit保留既有File-tools Windows skip1，不算pass。不是完整root integration／package／check驗證。獨立靜態審查已完成，沒有確認critical問題；九項呈現注意事項已逐項核對，另補成功receipt-only guard並通過Shell renderer 17/17回歸。

## 範圍
依據：`plan/PLAN-20261008T023831655Z-subagent-與-shell-訊息建議修改比較表.md`。

### Subagents
- 英文資料通知／摘要／query snapshot標籤，status-specific Control／Query 說明；applied與Query completed不表示主工作或指示已完成。
- agent scope、per-tool request/completed/failed、batch進度、finalizing、partial、skipped、中止原因及通知時點標籤。
- snapshot／late usage正常metadata採中性；未知用量、delivery_unknown／不可自動重送、cleanup pending仍保留安全提醒。
- running不由canResume=false推為blocked；終結缺log不暗示繼續等待；truncation只在已有logPath時推薦查閱。排隊 task 不描述成 running。
- 繼承現有resume核實條件，僅替換回傳文字；離線resume provider嚴格匹配新英文 checkpoint／session ID 說明。

### Shell
- receipt描述接受，不宣稱OS process已啟動；`Accepted in`只計receipt latency，同步`Took`與`(timeout 20s)`保持。
- cancelled即使exit130也不改稱failed；取消錯誤欄標Cancellation reason；缺exit code明說未提供，不偽造成功。
- timed_out明說output idle timeout；quiet指令應省略／調大timeoutMs，background:true只是非同步，不停用同一計時器。
- 通知／head／tail英文標籤；截短提示僅說通知保留部分、log最多first1MiB，不聲称磁碟log必定不完整。
- status/cancel TUI改為bounded命名欄位，保留模型JSON／structuredContent schema；terminal cancel明說沒有新增取消要求。
- eviction只說保留紀錄移除與log cleanup已嘗試；missing不推論原命令失敗；capacity refusal保留code／限額／建議。

## 不變量與其他問題
工具名稱、schema結構、公開status、isError、信任、activation、followUp／triggerTurn、限額、取消及ownership流程未修改。既有writer.lock清理失敗沒有修復、放寬或跳過；仍見`issue/ISSUE-20261008T024541630Z-subagents-abort-回歸測試暫存-writer-lock-清理失敗.md`。

## 文件與provenance
同步README.md、兩模組README與docs/configuration.md。docs/adaptations.json／docs/native-modules.json更新reviewed現有快照，docs/sources.json保持不變。最終紀錄89 reviewed snapshots；43 unavailable historical deltas限制保持，沒有歷史等價宣稱。23個變更source/test/docs/provenance檔案LF檢查通過；更新的background／completion／timeout renderer檔案沒有中文標籤。

## 已執行驗證
- 針對性 serial renderer／ShellJobs：56 cases，56 pass，0 fail／skip／cancel。
- npm run sources:verify：195 local snapshots、103 adaptations、93 added files、28 native files通過，歷史內容不足警告仍保留。
- 初輪48/49：一個舊missing訊息斷言未更新；修正文字，保留running ID／command斷言。
- 初輪typecheck8/9：wrapper result泛型需沿用host renderResult參數型別，已修正；後續根typecheck9/9通過，最後Shell source微調亦由Shell module typecheck再驗證。
- 新回歸初輪55/56：宿主renderer需唯讀initTheme('dark',false)，已初始化，不啟動watcher或寫設定；後續56/56通過。
- 新label在42欄下使用省略符，沒有擴大原欄寬；Shell receipt新增固定接受說明另作精確斷言，原payload仍限制<260字元。

## 完成驗證與失敗保留紀錄

| 分組 | 最終結果 | 證據 |
|---|---|---|
| npm run typecheck | 9/9 stage passed；後續Shell微調另由module typecheck通過 | plan/evidence/typecheck.json |
| npm test | 最後微調後再跑10/10 stage passed；1既有Windows skip不算pass | plan/evidence/unit.json |
| npm run test:module -- subagents | 3/3 stage passed，無skip；後續未再改Subagents程式 | plan/evidence/module-subagents.json |
| npm run test:module -- shell-tools | 最後微調後3/3 stage passed，無skip | plan/evidence/module-shell-tools.json |
| npm run test:cross | 最後fixture修正後3/3 stage passed，7/7 loader variants、無skip | plan/evidence/cross.json |
| npm run sources:verify | 最後source／fixture／provenance一致；歷史不足警告保留 | 195 snapshots／103 adaptations／93 added／28 native |

root unit與兩模組的成功不算已修復前序writer.lock清理問題；測試沒有被skip或放寬，無root-cause修復證據。

### 驗證歷程
獨立收集typecheck、npm test、test:module -- subagents、test:module -- shell-tools、test:cross，不因某階段失敗而漏掉其他分組。
- 第一輪jobId `01m4cqh82eayrm8h6mxh00yp1a`已failed（exit1，約3.7秒）；log：`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-PDPDTt/output.log`。動態參數啟動方式使npm只印usage；完整log確認五分組都在啟動時exit1，沒有任何[checks] runner summaries，全部標為未執行，而非五組測試失敗。未用旧evidence檔案冒充此輪結果。
- 改為五個明確npm命令依序獨立執行，失敗亦繼續收集其他分組；包含成功receipt-only guard的最新source／provenance。
- 重跑jobId：`01m4cqx28reqs2h0ken0vmwwzq`；log：`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-9nKvb0/output.log`。此輪完成：typecheck0／unit0／Subagents0／Shell1／cross1，Shell/cross各2/3，並非整組通過。
- Shell failure：過期integration斷言要求renderResult函式字串等同宿主，與授權wrapper衝突。替換為兩shell×五種fallback branch×80/200欄的宿主逐行輸出完全一致性，仍保留schema／metadata／guidelines嚴格檢查，另精確斷言成功receipt的Accepted in且無Took。
- Cross第一個failure：collapsed 80欄取消警語截掉is not confirmed，確屬呈現缺陷。產品改為兩行安全警語，在collapsed亦wrap，不改取消／status。新增1/6/24/80欄負面限定完整性斷言；原fixture80欄完整句斷言不放寬。
- 修正後同步重跑：root unit10/10、Shell3/3通過；cross2/3，進一步暴露message fixture仍要求log ready (event snapshot)。保留log_ready權威状态、future path、panel style、bounds與immutability斷言，只換為精確新英文並新增task_result／neutral data／log保守上限斷言。
- 最後fixture/provenance修正後cross3/3通過，7/7 loader variants無skip；再次sources:verify與23檔LF通過。失敗／修正重驗完整log：`C:/Users/KY6584/AppData/Local/Temp/pi-powershell-e59c72db67146c85.log`。該log包含root／Shell成功與中間cross舊log label失敗，最終cross結果以plan/evidence/cross.json及其stage logs為準。
- 審查job：`01m4cpn8y4j31khytemd2jghh5`已completed；read-only、非原子分段靜態快照，沒有修改檔案／跑測試，child沒有note工具而未保存獨立報告。父代理讀取完整結論後逐項核對，不能把此審查稱為最終snapshot全組驗證。

## 獨立審查的逐項處置
1. Query答案不存主線log：query截短只說response保留部分，不推薦task log；僅task result有logPath才推薦。
2. aborted有展開／收合／模型文字：index與result helper均已處理Stop reason，errorMessage／logError等原diagnostics及isError未刪除。
3. running／terminal resume/log分支：running不稱blocked；terminal缺log不稱being created，logError優先可見。
4. cancelled非零exit：label／icon／color／batch background一併保留cancelled，exit與error仍顯示，真正failed／timed_out保留error呈現。
5. Shell management無details：新UI讀完整structuredContent，舊紀錄安全解析compact content，不要求details，不改content/schema；list與錯誤可見。
6. 重複cancel：cancelling描述既有取消狀態，不宣稱本次新增；terminal明說no new cancellation，不推論程序樹已停止。
7. timeout兩處：error hint與promptGuidelines均校正background不會停用idle timer。
8. log上限不足以證明超額：只使用at most first1MiB保守文字，沒有推論Additional output was not saved。
9. Accepted in邊界：只在!isPartial、!result.isError、!context.isError且具有效receipt欄位時使用；partial／admission errors／同步仍交host。新增partial／兩種error flags回歸，宿主partial timer明確settle而非固定等待；Shell renderer 17/17通過、0skip。已刷新兩個變更檔案provenance。
- Capacity補充建議：dispatch／control／query／RPC保留原碼／限額，未改取消釋放時序；建議等待最終清理，不承諾取消立即空出容量。
- 成功receipt guard是在第一輪background驗證通知到達前追加；後續確認該輪啟動失敗、五組均未執行，沒有可採用的混合snapshot stage結果。新的五組重跑包含最終guard。

分組理由：TS renderer介面需要typecheck；程式碼變更需根單元；受影響兩模組需真實host probes；fixture／provenance／跨模組需cross。

未另執行完整root integration／package／check、手動真實TUI、付費／真實provider、WSL／SSH／POSIX process tree。Skip、pending及未執行不算通過。
