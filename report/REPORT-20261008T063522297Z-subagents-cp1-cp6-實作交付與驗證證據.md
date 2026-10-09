# Subagents CP1–CP6 實作交付與驗證證據

日期：2026-10-08。對應計畫：`plan/PLAN-20261008T060625729Z-subagent-建立-訊息操作統一執行計畫.md`，OQ1=A。

## 結論

CP1–CP5 模組實作與 CP6 離線真實 Pi 1.0.0 整合已完成；最終整合 49/49、針對性回歸 36/36、最新模組 TypeScript 通過，皆無 skip。但 `npm run test:module -- subagents` 整體仍為失敗（2/3 stages）：其單元階段 297/299，一項描述契約失敗已修正並針對性驗證，另一項 Windows writer.lock 清理 EPERM 在明確排除範圍，未修正。不得將整組或根驗證標為通過。

所有人工原始碼、測試及文件變更均在 `modules/subagents/**`；沒有修改 parent 所有的根 README/docs/tests/scripts/provenance/計畫。既有驗證 runner 自動產出 `plan/evidence/`，另以本 note 保存交付報告。沒有變更真實全域 settings/auth/session、呼叫真實 provider credentials、執行遠端發布，亦未修正通知摘要選取或無關 writer.lock 問題。

## 精確變更路徑（22 個）

### Runtime / 文件
- `modules/subagents/extensions/subagent/index.ts`：建立-only schema、移除 resume 派遣並拒絕遷移、`continueSession` 唯一共用續接 preflight/runner 路徑、session-addressed message routing、實際 managed 預配置、acceptance abort fence、旧歷史 render 相容；RPC guard 在 get_state 前拒絕亦讀取 authoritative startup.json，避免誤 rollback。
- `modules/subagents/extensions/subagent/background.ts`：`locate`、`submitManaged` admission gate、同步 `beforeAccept` fence、明確模型文字 false 狀態、interaction session/action。
- `modules/subagents/extensions/subagent/background-renderer.ts`：resume acceptance 與 completion 區分；結構化拒絕診斷與 invocation/session/action 顯示。
- `modules/subagents/extensions/subagent/message-reservation.ts`（新增）：跨 extension loader instance 的 process-global continuation reservation，key 為 canonical root + session ID；釋放冪等。
- `modules/subagents/README.md`：新公開契約、狀態路由、accepted/completed、queued 真實身份與 migration。
- `modules/subagents/agents/worker.md`
- `modules/subagents/prompts/implement.md`
- `modules/subagents/prompts/implement-and-review.md`
- `modules/subagents/prompts/scout-and-plan.md`
  - 上述 worker/prompts 改為建立用 subagent、後續指示用 subagent_message，不由 parent 舊 canMessage/canResume 快照選路由。

### 測試 / fixtures
- `modules/subagents/tests/always-managed.test.ts`
- `modules/subagents/tests/title.test.ts`
- `modules/subagents/tests/session-store.test.ts`
- `modules/subagents/tests/background.test.ts`
- `modules/subagents/tests/background.integration.test.ts`
- `modules/subagents/tests/rpc-interaction.integration.test.ts`
- `modules/subagents/tests/pi-resume.integration.test.ts`
- `modules/subagents/tests/message-routing.test.ts`（新增，純事件 / deferred registry 回歸）
- `modules/subagents/tests/message-routing.integration.test.ts`（新增，需要子行程的 routing/continuation 回歸）
- `modules/subagents/tests/fixtures/managed-native.mjs`
- `modules/subagents/tests/fixtures/message-harness.ts`（新增，事件式 task_result observer）
- `modules/subagents/tests/fixtures/pi-resume-provider.ts`
- `modules/subagents/tests/fixtures/pi-cli-harness.ts`

`background-renderer.test.ts`、`runner.test.ts`、review-lifecycle/runner-io/startup diagnostics 等原安全斷言未刪改或弱化。`session-store.ts`/`rpc.ts`/child argument builder/guard 本體未修改；內部 ManagedSession/runSingleAgent continuation、checkpoint、rollback、format identity 仍在。

## 最終公開契約

### subagent

只接受 single (`agent` + `task`)、parallel (`tasks`)、chain (`chain`) 建立。保留 background、title、cwd、agentScope、既有 model/provider/thinkingLevel 明確覆寫規則。公開 schema 不再包含 `resume`；runtime 對任何 own `resume` 欄位回 `INVALID_DISPATCH` 並指向 `subagent_message`，不悄悄轉建立。

成功背景建立：content 是 slim job receipt，details 為既有 `{mode, agentScope, projectAgentsDir, results: [], background: receipt}`，structuredContent 為完整 receipt。每個 item 在 acceptance 前已成功 `ManagedSession.allocate`，擁有實際 manifest 與完整 26-character session ID；chain queued/skipped identity 獨立。`jobId`/`taskId` 與 session ID 分離。不造 log paths，queued 為 `logPending:true`；既有 writer create callback 才公布實際 live/future log path。身份不表示 checkpoint ready。

完整背景 receipt：
```ts
{ jobId, status: "queued"|"running"|"completed"|"failed"|"aborted", cancelRequested: boolean,
  tasks: [{ taskId, agent, status, logPending: boolean, subagentSessionId?,
    liveLogPath?, finalLogPath?, result?, canMessage?, controls?, queries? }] }
```

模型 slim receipt 明確保留 `cancelRequested`、每個 task 的 `canMessage`、`logPending`，及 result 中存在的 boolean `canResume`（包含 false）。歷史 result 缺 readiness field 表示未提供 readiness 證據，不代表 true；缺 log path 不代表已建立 log。structured/details 的 optional legacy fields 仍可缺省，不能用其 parent 歷史值授權路由。

### subagent_message

```ts
{ subagentSessionId: string, message: string,
  mode?: "control"|"query", title?: string }
```
required 恰為 `subagentSessionId`、`message`；mode 預設 control。message literal、上限 65536；title display-only、1–50 Unicode code points，保存 agent 配置不變。jobId/taskId 舊 addressing 在 execute 被拒絕並附 migration diagnostic。

受理 control/query receipt：`{subagentSessionId, mode, action:"control"|"query", jobId, taskId, ...existingControlOrQueryReceipt}`。保留 messageId/queryId、accepted/queued/applied/not_applied/delivery_unknown 與 query asOf/usage semantics。

受理 resume receipt：
```ts
{ action: "resume", mode: "control", subagentSessionId, status: "accepted",
  jobId, taskId, background: receipt }
```
不附 host tool usage；完成另送既有 `subagent_background` 的 `kind:"task_result"` followUp，以新 jobId/taskId/session ID 精確關聯。background usage 不二次累加 host totals。

拒絕 receipt：
```ts
{ subagentSessionId, mode, status: "rejected", errorCode, observedState,
  nextAction, error }
```
`isError:true`，content/details/structuredContent 一致。無法安全確定狀態時明說 `unknown`。SESSION_BUSY 的 nextAction 要求等 task_result/cleanup，且不可重送已 accepted 或 delivery_unknown controls。

### 路由與 ownership

running interactive => synchronous live control/query；registry queued/startup/finalizing/canceling => 明確 busy refusal。query 無 live handle => TASK_NOT_RUNNING，不 resume。無活動 invocation 的 control => strict ManagedSession.resolve/assertResumable/checkpoint/config fingerprint/canonical cwd/trust/model preflight，續接前 reservation；blocked/foreign owner/busy/corrupt checkpoint 皆拒絕，不 create。

preflight reservation 在 await 前保留 invocation admission，持續到 runner settlement；disk writer.lock 仍是 I/O ownership authority。child 實際 close、native/transcript/spool I/O、actual handle-close barrier 不提前釋放。工具 signal 在 publication 前最後同步 fence 再檢查；acceptance 後 job-owned signal 控制，不受旧 tool abort 影響。registry handle lookup/delivery 不跨 await；settlement race 不把 accepted control 重送成 resume。32 submitted / 8 active、owner/generation/reload/cancel/child exclusions 沿用。

RPC guard 如因 saved model 或 child trust 在 get_state 前拒絕，actual child close 後讀既有 startup.json 檢查 SessionError，保留原 transport diagnostic 並禁止 rollback/ready。不是放寬 guard 或 retry。

## 實際驗證及修正循環

- 初始遷移目標測試：30/33；background receipt admission 額外 microtask 與 failed-test capacity 連帶失敗，已修正 optional gate，不變更限制。
- 路由 / background 針對性測試：21/21，包含 queued identity、registry states、concurrent reservation、literal input、refusal/migration。
- 最初 offline actual Pi probes：11/14；RPC parent 舊 print lifetime 無法接收 asynchronous task_result。改為 RPC literal prompt、持續 drain LF JSONL、在 task_result + agent_settled 後 orderly stdin close。
- 下一次 actual Pi continuation probes：4/6；child model/trust startup rejection 曾誤顯 canResume:true。依 authoritative guard file 修正安全分類，未弱化 canResume:false / blocked / errorCode / no-provider-request 斷言。
- `npm run test:module -- subagents`：typecheck passed；單元 297/299、0 skipped；整合 49/49、0 skipped；總計 2/3 stages，整體 failed。
  - 描述斷言 `/applied confirms.*not that the requested work finished/` 失敗已補回該語意；原測試保持。
  - `modules/subagents/tests/runner.test.ts` 的 `parent abort wins when it precedes inactivity timeout` cleanup 發生 EPERM rmdir writer.lock；此已知類型問題明確排除，不修、不重跑掩蓋。
- 最終程式碼的 `node --import tsx --test modules/subagents/tests/message-routing.test.ts modules/subagents/tests/message-routing.integration.test.ts modules/subagents/tests/background-renderer.test.ts`：36/36，0 failed、0 skipped，確認描述修正和最後 acceptance fence。
- 最終程式碼的 `node node_modules/typescript/bin/tsc -p modules/subagents/tsconfig.json`：exit0。模組 runner 初次 typecheck 後仍有 acceptance-fence/description 小變更，因此此命令另確認最新來源。

整合 49 個包含所有 actual offline Pi host probes：single/parallel/chain、background create/resume、parent automatic followUp、literal control/query/owner replacement、P0 physical/virtual native sessions、dispatch overrides 原 fixture 契約、missing-model/child-missing-model/child-trust。normal single 真實 create → message → message 使用三個不同 parent/child PID，session ID 保持、native/transcript prefixes append-only、new task/job identities、user count=3、opaque tool history/nonce 保留、side effect count=1。parent 路由第三次仍使用舊 creation receipt，未靠新的 completion snapshot 授權。

## 證據路徑

- 最終模組 runner：`plan/evidence/module-subagents.json`
- 單元：`plan/evidence/subagents-test.log`
- 全整合：`plan/evidence/subagents-test-integration.log`
- P0 actual CLI：`plan/evidence/subagents/run-2026-10-08T06-31-33-199Z-19792/`
- 更完整 shell stdout：`C:\Users\KY6584\AppData\Local\Temp\pi-shell-job-pdcukm\output.log`
- 最終 36-case targeted stdout：`C:\Users\KY6584\AppData\Local\Temp\pi-shell-job-Xbwwyu\output.log`
- 最新 typecheck stdout：`C:\Users\KY6584\AppData\Local\Temp\pi-shell-job-DGzmBS\output.log`
- Pi continuation evidence 位於 module runner 配置的 `plan/evidence/subagents/run-<timestamp>-<pid>/`；舊失敗輪另保留於 `modules/subagents/issues/IMPL-20260930-resumable-subagents/e2e/`。需以當次 logs/manifest/run.json 對應，不以舊 blocked evidence 推論最新結果。

未執行：根 `npm test`、根最終 `npm run typecheck`、`npm run sources:verify`、`npm run test:cross`、`npm run test:package`、根全套 test:integration/check、browser、付費 provider、WSL/SSH；按分工留給 parent。不宣稱通過。build no-op 未由 worker 重跑。

## Parent 精確下一步

1. 來源碼已停止修改；核對並更新上述22路徑的 adaptations/provenance，不改 docs/sources.json/originalSha256/hostContract。根 README/configuration/migration/architecture 由 parent 維護。
2. 根 `tests/fixtures/smoke.mjs` 應保持：subagent.resume absent、message required ID+message / optional mode/control default / title、old subagent.resume explicit rejection / migration、old invocation addressing rejected、無 child/provider call 的安全 smoke。已唯讀看到 parent 草稿具此方向，不由 worker改。
3. 根 `tests/fixtures/renderer-probes.mjs` 應保持 legacy-history coverage、session-ID message renderCall/title、resume acceptance vs completion、structured rejection observedState/nextAction；舊 resume history只能 renderer讀取，不能重公開參數。已唯讀看到 parent新草稿，最終 cross由parent確認。
4. 執行根要求的最終單元、typecheck、sources:verify/cross/package；把 writer.lock EPERM 與已解決的描述 regression 分開記錄，避免刪斷言或假報全綠。CP6 可記錄真實整合通過，但整組模組驗證有排除範圍阻礙，checkbox/CP7由parent依真實結果決定。
5. 若要處理 writer.lock EPERM，需另取得範圍授權；本 worker 不再以驗證重試迴圈自行修復。
