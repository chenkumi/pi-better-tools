# Code review checklist 逐項修復追蹤

日期：2026-10-08

## 範圍與策略

依 `report/code-review-checklist.md` 現存 53 項逐項處理。七個獨立 worker 分別擁有 Subagents、File、Web、Schedule、PTY、JSON Schema、Note/GPT 各模組目錄，主代理負責 Shell、scripts、根文件、provenance 與最終整合。所有 worker 不修改根共用檔案，避免寫入衝突。

遵循 software-fix-bugs：已文件化取捨與既定行為不單方面改政策；不弱化完整性、trust 或 lifecycle 保證。不成立／已修復／跳過／部分修復均逐 ID 說明，不將未執行或 skip 算成通過。

## 初始證據

- 目前目錄沒有 `.git`（`git status --short` 回報非 Git repository），以修改前 SHA-256 inventory 比對檔案，不宣稱 Git diff。
- 模組/scripts/tests/docs 修改前 inventory 保存在系統 temp `pi-better-review-baseline.json`，578 檔。
- 主代理初查發現 L28 Shell 清理重試與 dead-owner sweep、L29 startup 計時說明、L34 空測試清單防護已在當前檔案存在；後續用實際測試確認，不重複改碼。

## 驗證計畫

各 worker 執行其 `npm run test:module -- <module>`。主代理執行 Shell 模組、全單元、typecheck、cross 與 sources verifier；多模組/根 provenance 改動必須 cross。若新增 worker runtime 資源或 tarball 合約變更，另執行 package smoke。實際結果、skip、失敗及重跑原因在交付紀錄保留。

## 待決策政策

已確認需決策：MH1 @ 路徑慣例、M11 diff timeout 不提交、L11 URL fail-closed、L12 暫存檔保留、L13 context close timeout。H2 只有事後peer檢查，無法防blind SSRF，仍需出口filter／受控transport；沒有根治不能標已修復。

## 收斂進度

- Checklist 53個唯一ID均有處置；38修復／既有查證、5部分、5政策待決、5理由保留。原始發現/行號保留作歷史，不冒充當前缺陷。
- 九模組module分組最終都有完整成功紀錄。Web追加有界active/idle/retiring worker ownership＋shutdown後再次4/4 stages通過（70unit、14real-browser、2composition）。File既有Windows POSIX-path skip與PTY POSIX signal skip不算通過；Subagent真實POSIX signal tree未跑。
- 主代理全根npm test 10/10 stages、typecheck 9/9、cross 3/3、build no-op通過。根Note loader/renderer fixtures已強化為relativePath-only；production probes同步PTY ready與JSON reusable worker、Web extraction core/worker。
- Provenance記錄76 reviewed snapshots，其中51為開始前已有不符；保留immutable來源／originalSha256、前值／baseline／當前hash與historicalDeltaAudit限制。sources:verify通過：195 import paths、93 added files、28 native files；0 originals checked。43歷史delta warning不隱藏，不宣稱原始差異等價。
- 83個reviewed module/root/provenance/checklist檔案LF檢查通過。初期timeout、fixture contract、jiti cache與browser cold-start失敗都保存在各模組報告／原日誌，不弱化斷言來求pass。
- package實際tarball＋clean Pi1.0.0 production smoke最終19/19 stages通過，包含production install/tree/native setup、PTY/JSON/Web protocols、structured JSON、所有loader modes、managed child與cleanup；未遠端發布。
- 最終報告：`report/REPORT-20261008T020215870Z-code-review-checklist-逐項處置與最終驗證.md`。部分／政策待決／保留15項仍未冒稱根治。
- 未另外跑全組test:integration／完整check，因module＋cross覆蓋相應項目，避免重複；人工TUI、真實provider與WSL/SSH未驗證。額外第一個read-only reviewer失敗：RPC startup get_state未在期限內回覆（COMMIT_FAILED / RPC_DEADLINE，exit1、totalTokens0），沒有可採用審查結論，不算pass。Job `01m4cjj138zhd6x1awahpj6ted`、task `01m4cjj1383dse0fffth9tjtnb`；回報log：`C:/Users/KY6584/.pi/agent/subagent-sessions/01m4cjj18decktvzab17g4dvq2/runs/01m4cjj1383dse0fffth9tjtnb/transcript.jsonl`（未另行讀取）。第二個reliability reviewer已完成靜態審查、提出1項close-rejection ownership warning，parent對照current writer/runner確認成立。

## M4重新開啟時的歷史記錄

- 重新開啟當時checklist：37完成／6部分／5政策待決／5保留。先前38完成與green測試快照不涵蓋close-rejection缺口。
- Issue：`issue/ISSUE-20261008T020740472Z-subagents-m4-重新開啟-transcript-close-失敗被誤視.md`。
- 專屬worker `01m4cm76r8x79ws1qwtdt9264s`／task `01m4cm76r8b18gttjdcfnh6p4m`，只修改writer/runner、三個指定測試檔與README；parent不與worker重疊寫入。
- 要求close failure保持ownership rejection、一般與late cleanup不錯釋lock、立即掛abandon rejection handler、保留primary/close diagnostics、確定性故障注入與成功close regressions。
- 當時要求Worker完成targeted＋subagents module後，parent更新reviewed provenance並重跑cross/package；未完成前不恢復M4勾選。

## M4後續現況（2026-10-08第一階段同步）

- close-rejection修補／故障注入與後續選定驗證已完成，checklist恢復38完成／5部分／5政策待決／5保留，53項與原始發現仍保留。後續驗證見 `report/REPORT-20261008T065714430Z-subagent-建立-訊息統一實作與最終驗證.md`，本次current唯讀查證見 `report/REPORT-20261008T075605060Z.md`。
- 上方收斂測試／tarball/provenance數字仍是原快照，不以同名evidence現檔冒充歷史結果。新第一階段計畫 `plan/PLAN-20261008T075046931Z.md` 尚在實作／待驗證；EPERM／ENOTEMPTY另案、歷史通知及RPC根因仍開放，不將M4恢復勾選當作全部問題解決。