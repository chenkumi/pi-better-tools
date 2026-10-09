# Footer 背景摘要與 Subagents 通知顯示修改結果

2026-10-07。實作完成；完整驗證未全數通過，保留Subagents fixture失敗，不宣稱全部驗證成功。

## 行為

- 原生setStatus在footer extension狀態列顯示 `▸ Subagents：N ｜ ▸ Shell：M`，與Fast／其他狀態共存。宿主按key排序及截短，不替換footer、不修改Pi／node_modules。
- 收合不掛widget，不顯示命令／title。`/background-jobs subagents|shell|all|collapse`各別展開；展開才在belowEditor掛原有詳細widget，全螢幕仍可點擊widget header，footer文字本身不可點擊。
- 所有工作終結清除自有status/widget，保護其他key。暫時removal失敗保留UI參照，下一事件重試；立即revision fencing防止舊component渲染或接mouse。永久失效／無後續事件不保證復原，無timer/polling。
- 新背景log_ready使用display:false，不新增聊天bubble。模型content/details、不觸發回合的followUp、工作生命週期不變；task_result/control_result/query_result仍顯示，歷史log_ready仍能render。
- 同步／前景onUpdate持續在原tool-call bubble更新，Markdown／結果契約不變。

## 實際驗證

| 分組 | 結果 |
|---|---|
| 最終focused panel/registry/lifecycle | 25/25通過，0 skip |
| 根npm test初輪 | 9/10 stages；Subagents251/253，2 failures；File Tools既有Windows skip |
| Shell module最終 | typecheck＋64 unit＋36 integration通過，3/3 stages，0 skip |
| Subagents module最終 | typecheck及36 integration通過，unit251/253，2 failures；2/3 stages |
| 根typecheck最終 | 9/9 stages通過 |
| cross最終 | 3/3 stages通過，0 skip；真Pi1.0.0 loader/reload/renderer與idle status/widget hooks |
| sources:verify最終 | 195 snapshots、94 adaptations、85 added、25 native通過；5個歴史delta warnings |
| 隔離runner-io原測試 | 5/17通過、12 failures、0 skip；後續完整module/root重跑未執行 |

模組分組因兩個模块共用UI helper及通知display修改而執行；cross因多模組、fixture/provenance變更而執行。没有新增entry、import邊界或runtime asset，所以未重跑test:package。full test:integration／browser／check／build及手動終端／fullscreen未執行，不算通過。Loader probes只覆蓋idle/mode/共存，active/footer/detail lifecycle由controlled與模組真Shell/offline child測試覆蓋，不能聲稱人工實機驗證。

## 未解失敗

三次runner-io分組均有在故障注入前耗盡fixture300ms begin/allocate managed setup期限。沒有放寬deadline/assertions、跳過或改動runner fixture；隔離仍失敗，不能宣稱單純資源競爭或已解決。詳見 `issue/ISSUE-20261007T090540772Z-footer-驗證遇到-subagents-runner-i-o-fixture.md`。

首次PowerShell launcher誤用$args只列npm scripts，exit0不算測試；原log保留。獨立靜態review未確認重大缺陷，指出1個UI移除重試缺口，已補强並focused驗證；未另行第二次獨立複審。

## 檔案與證據

- 產品：`modules/shell-tools/src/background-panel.ts`、`modules/subagents/extensions/subagent/index.ts`。
- 文件：根README、docs/configuration/architecture/adaptations及兩個模組README。
- 計畫：`plan/PLAN-20261007T084402463Z-背景工作改用原生-footer-狀態摘要.md`。
- 審查補強：`research/RESEARCH-20261007T085427933Z-footer-背景摘要獨立審查與清理警告補強.md`。
- 證據：`plan/evidence/footer-status-20261007T084402Z/`；root/module/typecheck原始log `C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-IkJJjB/output.log`、cross `C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-zuW1Ai/output.log`、隔離重跑 `C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-PDWCna/output.log`。

測試使用隔離資料與離線provider，未修改真實settings/auth/schedules，沒有commit/publish。sources只證明本地hash完整性，不證明缺失歷史內容的diff等價。待現有背景驗證全部結束後，可/reload載入顯示修改；reload仍會取消背景工作。
