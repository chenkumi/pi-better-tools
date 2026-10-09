# Schedule Prompt checklist 修補與現況驗證

日期：2026-10-08。授權程式範圍：僅 `modules/schedule-prompt/**`；本報告依明確要求由 note 新增。根 checklist、docs/provenance、scripts、root tests 均未修改。

## 結論

M5、M6、M7、L15、L16 已補強；L14、L17 與 L19 的主要缺陷在接手前已修復，本輪新增／保留回歸驗證；L18 的 foreign/unbound 保護接手前已存在，本輪修正 session id 未取得時仍清掉 unbound running 的邊界。純日期 UTC、+0s 拒絕等已文件化政策不擅改。最後模組驗證 3/3 stages 通過（typecheck、261 個 vitest 案例、1 個離線真實 Pi 1.0.0 host probe），無 skip。

接手時先讀 checklist、README、types、storage、scheduler、widget、既有測試與 software-fix-bugs/test-case-creator skills；模組內未找到 AGENTS.md。實際程式已比 checklist 新，因此不把既有修補冒稱本輪新增。工作目錄不含 Git metadata，`git status` 無法使用；已記錄工具提供的原始版本 token。父代理提及的 temp baseline 在本 worker `$env:TEMP` 下未找到，未宣稱完成該 baseline 比對；父代理負責其 51 個既有 provenance mismatch 與本輪 provenance 更新。

## 逐 ID 狀態與證據

| ID | 接手時查證 | 本輪處理／狀態 | 主要驗證 |
|---|---|---|---|
| M5 | 已有 5 次／30 秒 bounded retry，非原 checklist 描述的永久無 timer；仍與本次明確要求 false 必須停用／error 不一致 | **依本次明確授權修復**：false fire 對仍 enabled、仍屬本 session 的 once 明確停用、lastStatus=error、清除 nextRun／本地 timers，發 error/update，不自動重試。removed/disabled/foreign 保留 state，expired/invalid 仍走既有 endAt 路徑。儲存失敗也停本地 timers 並回報 | overlap、四個 subagent slots 滿載、inline delivery throw、沒有延遲重送；既有 retry 案例依新契約改為一次 false terminal 的強斷言 |
| M6 | render 已用 cachedJobs，getNextRun 已可傳 knownJob，主要同步 I/O 已修；cron:change burst 仍每個事件讀檔 | **既有修補＋新增節流**：100ms coalescing、destroy/hide 取消 pending refresh；deferred refresh 例外被包含並隱藏 stale widget | 50 個事件僅一次追加 snapshot read；多次 render 無讀檔；destroy 後無 timer/read；deferred storage error 不逃出 timer |
| M7 | 已有 owner token／rename stale takeover，但 age 不能證明 owner 已死；普通 mutation 仍可能無鎖執行 | **修復**：排他 mkdir，token 初始化成功才執行 callback；任何 contention／acquire failure 立即 fail closed；不根據 age 偷鎖、不 block 等待 2s、不無鎖寫入。只移除自己的 token lock。direct save 也取得鎖 | fresh 與 old lock 均拒絕；另一 CronStorage 在持鎖 callback 內對 add/remove/update/updateWith/save/expire 全部拒絕且 bytes 不變；token write failure 不執行 mutation；peer token 不被 release |
| L14 | getNextRun 已支援 cron/interval/once，以 intervalStarts/onceTargets 記帳，且可傳 knownJob | **已修復（接手前）**，未重寫 | 保留 interval/once nextRun 案例、stop 清理；deadline 限制與 widget cached knownJob 亦由既有套件驗證 |
| L15 | 已 filter null/basic string fields，但 optional model/session/runCount/selection 等腐敗可傳到 consumer，或錯誤 enabled/type 可能觸發錯誤工作 | **補強修復**：驗證 required execution fields、type/enabled、正數 finite intervalMs、非負 safe-integer runCount、optional strings/model/notify/status/extensions/skills；忽略損毀元素並 diagnostic。缺少 legacy stats 保留；endAt 故意不 drop，由 scheduler 依原有 fail-closed/status 保留語意停用 | 14 組 malformed fields、null/basic malformed 既有案例；version=1、missing stats 與 invalid endAt 保留後 scheduler disable |
| L16 | ENOENT quarantine tolerance 已修復直接 crash 部分；未鎖定 read→quarantine，可能移走 peer 新存入的有效檔 | **補強修復**：corrupt recovery 取得 mutation lock 後重新 read/parse，再決定 quarantine；backup 加 pid/random 避免同毫秒命名撞擊；rename ENOENT 僅確認 source 真正 absent 才容忍，仍存在 source 時拒絕替換 | 首讀損毀／鎖內 reread 已有效時不 quarantine；corrupt＋peer lock 保留 bytes 並 fail closed；真實 source 已被移走的 ENOENT 仍容忍且 backup bytes 保留；假 ENOENT/source 存在時不抹除原檔 |
| L17 | inline/subagent success 都已使用 updateJobWith，fresh count 在同一 locked read-modify-write 內加一 | **已修復（接手前）；本輪 M7 提供真正互斥保障**，修正過時 comment，未重寫 counter | inline 與 subagent：getNextRun/snapshot 到 commit 間另一 storage 累計一次，本次完成後 runCount=2；既有 fresh count 10→11 案例 |
| L18 | own-session only reset 已存在，foreign/unbound 通常不清除；但 mySessionId=undefined 與 unbound session=undefined 仍相等 | **既有修補＋邊界修復**：reset 還需 truthy job.session | own-session、foreign、unbound 既有案例；session id unavailable 不清除 unbound running |
| L19 | +0s 已明確 validation error；超大 relative 已回傳 null／清楚 too far error；README 已說 date-only UTC 和無 zone datetime local | **已修復／已文件化政策，維持**；不改為 local date 或允許 zero，避免擅改政策 | 保留 +0s/huge/+1s 案例；新增 date-only 在固定時鐘解析為 UTC midnight 的契約案例 |

## 檔案變更（本 worker）

### 修改既有檔

- `modules/schedule-prompt/src/storage.ts`：`isJobShape`、`withLock`、`load`、`quarantineCorruptStore`、`save`、`expireJobIfDue`。全 mutation fail closed、不 age-steal、鎖內 corruption reread、完整 consumer shape。
- `modules/schedule-prompt/src/scheduler.ts`：`start`、`armOnce`、`handleSkippedOnce`、execution stats comment；移除 ONCE_SKIP_MAX_RETRIES/ONCE_SKIP_RETRY_MS（非 tool schema）。
- `modules/schedule-prompt/src/ui/cron-widget.ts`：change debounce、`refresh` timer error containment、`hide`/`destroy` lifecycle。
- `modules/schedule-prompt/README.md`：同步明確授權的 once false terminal 與 fail-closed lock、manual stale lock recovery、validation、widget snapshot/coalescing 行為；第三方 author/identity/license 不變。
- `modules/schedule-prompt/test/review-fixes.test.ts`：更新 unsafe lock stealing／once retry expectation 為明確授權契約，增加 timer／no-redelivery 強斷言。
- `modules/schedule-prompt/test/stability-storage.test.ts`：unsafe lock fallback/stealing 測試改為 refusal＋bytes/no-file／peer lock 保留，不以固定等待衡量 timeout。
- `modules/schedule-prompt/test/deadline.test.ts`：原本以 performance.now mock 耗尽舊 lock budget 的 fixture 改為真實 peer directory/token。原 throw 與 unchanged bytes 斷言保留，另加 peer token unchanged。
- `modules/schedule-prompt/test/stability-fixes.test.ts`：ENOENT fixture 現在真的把 source 移到 peer backup，保留 tolerance 斷言並新增 backup bytes；另新增 source 尚存在時 fail-closed regression。

### 新增檔

- `modules/schedule-prompt/test/checklist-regressions.test.ts`：28 個案例；M7 全 mutation contention/owner-init failure、L15 腐敗元素/v1/endAt、L16 valid replacement/lock fail-closed、M5 overlap/capacity/inline error、L17 inline/model 競爭計數、L18 undefined session、L19 UTC、M6 coalescing/render/no-I/O/teardown/error containment。

## 實際驗證

1. 初次 targeted：`node node_modules/vitest/vitest.mjs run --root modules/schedule-prompt test/checklist-regressions.test.ts test/review-fixes.test.ts test/stability-storage.test.ts test/stability-fixes.test.ts`：4 files / 49 tests 通過。
2. 第一次 `npm run test:module -- schedule-prompt`：typecheck 與離線 host probe 通過；vitest 258 通過、1 失敗。唯一失敗是 `deadline.test.ts` 用已移除的 performance.now lock-budget mock，沒有真的製造 contention；已改為 real lock fixture，不弱化斷言。
3. 最後 targeted：上述四檔＋`test/deadline.test.ts`：5 files / **89 tests 通過**。
4. 最後 `npm run test:module -- schedule-prompt`：**3/3 stages 通過**；typecheck；17 files / **261 vitest tests 通過**；**1 real Pi 1.0.0 offline host test 通過**。Host checks startup/schema-null/add/update/enable/session-reinitialize/no-provider。無 provider 呼叫、無真實使用者 schedules/settings/auth 資料存取；使用既有隔離 probe 與 temp workspaces。
5. 9 個程式／文件變更檔逐一檢查無 CR，均為 LF。

未執行：全 repo `npm test`、root typecheck/build、test:cross、全部 test:integration、test:package、browser tests。理由：授權僅本模組、module runner 已包含本模組型別/完整來源 vitest/離線真實 host；根 provenance 與跨模組驗證由父代理處理。未執行不當作通過。

## 保留契約與風險

- 維持第三方 tintinweb/pi-schedule-prompt 身份與 LICENSE；`schedule_prompt`/`/schedule-prompt`、tool schema、version-1 storage 路徑/格式、session binding、endAt exclusive cutoff／already-started may finish／status 保留語意未變。未修改 settings/auth/credentials 或付費 provider。
- **Fail-closed intentional trade-off（本次使用者明確要求）**：crashed peer 的 lock 不會自動偷取；需確認無 writer 後手動移除。競爭下 mutation 或 corrupt recovery 可能明確報錯／停止本地排程；不是假裝仍然成功。有效 store 的 read 不需要 mutation lock。
- L16 不再有兩個合作新版程序同時 quarantine 的 race；真正 contention、權限、無法保存損毀檔仍可能拒絕 startup，符合既有 README「storage/lock failure stop local scheduling」契約，不靜默吞掉資料。
- L18 保留已存在的 own-session interrupted-running reset 政策；兩個程序刻意 resume 相同 session id 時，v1 沒有 run-owner metadata 可證明該 running 是否 stale。本輪不擅自取消 own-session recovery 或加入新的持久化格式；如需跨同-session distributed ownership，由使用者決定政策。
- 不是 exactly-once scheduling、不是 OS sandbox；unbound jobs 仍依文件在每個 cwd session 執行。hand editor／舊版忽略 lock 的 mixed-version peer 不受新版鎖保證。direct save 的 stale snapshot overwrite 仍是 caller 責任；mutation/counter API 使用 fresh locked read-modify-write。
- Shape 驗證維持原有 malformed element ignore 政策；後續 mutation 的序列化只保存有效元素，並非把元素 quarantine 到另一個格式。若要保留每個無效元素的独立 backup 或排程型別 migrate，需另定政策。
- 測試以 deterministic interleaving/持鎖 callback/兩個真實 CronStorage 實例驗證 filesystem 互斥，並非額外實行兩個 OS process 的 stress 測試。

## 父代理下一步（未代做）

1. 依本表更新 checklist：L14/L17/L19 應標 already fixed／policy preserved，不算本輪新修；M6/L18 區分既有主要修補與此次補強。
2. 更新 docs/adaptations/native provenance 中本模組的來源 hash/differences；不要把本次修改當無差異第三方 snapshot。
3. 處理已知 preexisting provenance mismatches 後執行父代理的跨模組／provenance 分組。

### 最後 SHA-256（provenance 交接）

```text
modules/schedule-prompt/src/storage.ts f24af3bfc82e2b43f4c98663d68628d5b9437db8f1677302056b97047e7a126c
modules/schedule-prompt/src/scheduler.ts a8f8d1c0b104cfdbf442227a5d8375c2669e7248a85a9fe5ee1ef5746af1560e
modules/schedule-prompt/src/ui/cron-widget.ts a43b39de20928612b6cf3d03e4cda93cfe9771a4d5d27843af0b5f412c5107d1
modules/schedule-prompt/README.md ef17463761084cc12b14f60f17c049fc3eeb0b02f2815c8f5ca7a861ff6447df
modules/schedule-prompt/test/review-fixes.test.ts 34fe7c1f4bcdba9f95e0cfebb160c63c37118cf946d5680f133ffa7d50958fde
modules/schedule-prompt/test/stability-storage.test.ts fd1a7a90a1eebff18aefaa77f7d75b1c460a6b92c38cc147459b223d13d715de
modules/schedule-prompt/test/deadline.test.ts 65454a1984caf0587b1a63b48254633de4af596080f7226a743287893a963975
modules/schedule-prompt/test/stability-fixes.test.ts 0bb84c00b602b5540ba2130e631e46c01dc60ffe9a7e0286770f5af8478dd730
modules/schedule-prompt/test/checklist-regressions.test.ts 18aa2f68ef8770cdf9748d61c7eec0037142aa4fc1eafc989a9b443292b142f1
```
