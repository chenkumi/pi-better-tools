# Subagents

提供 `subagent` 工具，將工作委派給獨立的 Pi child process。每個 child 擁有乾淨、隔離的 context window，**看不到主對話**。

## 功能

- 四種模式（每次呼叫只能擇一）：single、parallel、chain、resume。
- 內建 agents、使用者層級與專案層級 agent 定義。
- 所有新派遣自動保存 Pi 原生 session，成功提交後可續接。
- TUI 即時顯示 child 進度（每個 task 保留最新三則單行訊息；工具只顯示 request／completed／failed 與截斷後的參數）。
- 完成後保留完整輸出、sub-session log 路徑與 token／cost 用量。
- 每回合在主代理 system prompt 注入 agent 目錄（名稱、來源、用途）；未信任專案不注入專案層級 agent。

## `subagent` 工具參數

| 參數 | 說明 |
| --- | --- |
| `agent`、`task` | single 模式 |
| `title` | 選填；用 50 字內描述這個 subagent 要做甚麼事，顯示於 TUI，不取代完整 `task` |
| `tasks` | parallel 模式，`[{ agent, task, title?, cwd? }]` |
| `chain` | chain 模式，`[{ agent, task, title?, cwd? }]`；`task` 可用 `{previous}` 取得前一步完整 assistant 文字 |
| `resume`、`task` | resume 模式，`resume` 為工具回傳的完整 `subagentSessionId` |
| `cwd` | single 模式的工作目錄 |
| `provider` | 選填；須搭配不含 `/` 的 `model` |
| `model` | 預設省略；只有使用者或 skill 明確指定時才傳入。exact model ID 或 `provider/model`；未知／歧義選擇忽略並使用預設值 |
| `thinkingLevel` | 預設省略；只有使用者或 skill 明確指定時才傳入。`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；未知／目標模型不支援的等級忽略並使用預設值 |
| `agentScope` | `"user"`（預設）、`"project"`、`"both"` |
| `confirmProjectAgents` | 預設 `true`；使用專案 agent 且專案未信任、有 UI 時先確認 |

`provider`、`model`、`thinkingLevel` 預設不傳；只有使用者或 skill 明確指定才作為本次所有 subagents 的 override，代理不可自行猜測。`provider` 不可與 `provider/model` 格式的 `model` 併用。`resumable` 參數已移除，傳入會回傳 `INVALID_DISPATCH`。

首次派遣在啟動 child 前，**先解析模型，再檢查該模型支援的思考等級**：

- 模型以 parent registry 的 exact ID 查詢，不做 fuzzy 猜測；明確的 `provider` 僅查詢該 provider。單一模型字串優先採已註冊的 `provider/model` 解讀，否則按完整裸 ID 查詢（優先目前 provider，其餘須唯一匹配）；含 `/` 的裸 ID 若與另一組已註冊的 `provider/model` 衝突，請傳入完整 provider 前綴消除歧義。成功後傳入完整 `provider/model`。未知／歧義 override 忽略，改用已註冊的 agent 模型，否則繼承 parent 模型。
- 未知或模型不支援的思考等級忽略，等同省略 `thinkingLevel`。為允許這種容錯，schema 接受字串，支援清單在執行前驗證。
- 繼承 parent 模型時，預設繼承 parent 思考等級並依宿主能力正規化；使用有效 model override 或 agent 模型、且沒有有效 thinking override 時，不傳 `--thinking`，交由 child Pi 預設設定決定。
- 此容錯只處理新派遣的選擇參數；resume 不接受 override，已保存的模型／信任／checkpoint 驗證保持嚴格。格式錯誤（例如只提供 provider）仍依原規則拒絕。
- Parent registry 的存在／能力檢查不發出模型 API 請求，也不保證 child 能載入相同 provider 或遠端憑證有效。保留 child startup guard；child 設定不一致仍會失敗，不自動重試。

首次 task 須完整說明目標、操作要求、相關路徑、限制／非目標及預期回傳格式。

`title` 是父工具的 UI 標題：single／resume 填頂層欄位，parallel／chain 每項可填獨立標題（優先於頂層批次標題 fallback）。Call、執行中及完成後均保留 agent 身份並顯示標題；缺少標題沿用舊呈現。最多 50 個 Unicode 字元（code points／碼點），不按 UTF-16 code units 計數；組合 emoji／重音可包含多個碼點。Schema 保留 maxLength 50，派遣前再次計數，避免宿主分群演算法漏過超長組合文字；另限原始 UTF-8 4 KiB，避免極長 combining sequences。空白、只有控制碼或超長會於派遣前拒絕。沿用 Pi 參數正規化：optional null 可視為省略，數字／布林可轉為字串；直接 execute 收到非字串則拒絕。TUI 清理標題的 ANSI／控制字元與 bidi；不變 task／child args／提示、managed config／guard／trust，不修改真實設定。標題僅保存於 parent 工具 arguments/details；resume 的新標題不改先前紀錄，也不自動沿用前次標題。

```json
{ "agent": "scout", "title": "調查登入與驗證程式碼", "task": "Find all authentication code." }
```

```json
{
  "tasks": [
    { "agent": "scout", "title": "調查模型相關程式碼", "task": "Find model-related code." },
    { "agent": "scout", "title": "調查 provider 相關程式碼", "task": "Find provider-related code." }
  ]
}
```

```json
{
  "chain": [
    { "agent": "scout", "task": "Investigate the authentication flow." },
    { "agent": "planner", "task": "Create a plan using this context:\n{previous}" },
    { "agent": "worker", "task": "Implement this plan:\n{previous}" }
  ]
}
```

Task 以權限受限的 UTF-8 暫存檔（Pi `@file` 參數）傳給 child，不放入 command line；task 內的 `@path` 不會被展開。

### 上限

- parallel 最多提交 32 個 task、chain 最多 32 個 step；超量請求在確認提示與 log 建立前即回傳錯誤。
- 同時執行的 child 上限 8 個，為整個 Pi process 共用（同一 turn 的多個並行 `subagent` 呼叫合計不超過 8 個，多的排隊；排隊中被取消者不會啟動 child）。
- Child 連續 300 秒沒有 stdout 輸出即因 inactivity timeout 失敗（stdout 每次輸出重置）。stderr 輸出也會重置，但只在最後一次 stdout 後 4 倍期限內有效，避免只吐 stderr 的 child 永遠不逾時。
- `agent_settled` 後 child 若五秒內未結束，會被終止並保留已完成的結果（不再等 300 秒後標為錯誤）。
- 取消或 timeout 對 direct child 送 SIGTERM，五秒後仍未結束則 SIGKILL；Windows 另以 best-effort `taskkill /T /F /PID` 嘗試終止子行程樹。以上皆不保證清除完整 process tree（終止要求不等於 process tree 已停止），不自動重試。若 SIGKILL 後 child 仍未結束，結果會誠實標註它可能仍在執行。`Ctrl+C` 會中止 child。
- Child 非零結束且未產生 startup handshake 時，錯誤訊息附上 stderr 尾端，不再只顯示 ENOENT。
- Child 以 `PI_SUBAGENTS_GUARD` 接收啟動 handshake，guard 讀取後即從環境刪除，孫行程不會繼承。
- Pi CLI 解析順序：環境變數 `PI_SUBAGENTS_PI_CLI`（指向 `cli.js` 或可執行檔）、宿主提供的 `@earendil-works/pi-coding-agent` bin、`process.argv[1]`、PATH 上的 `pi`。以 SDK 內嵌時不會再重跑宿主應用程式。
- stdout 單筆 JSON record 上限 8 MiB；stderr diagnostics 上限 512 KiB；retained message 記憶體預算 2 MiB。累積 assistant 輸出超過預算時截斷並附註，不會讓成功的 run 失敗。
- Log 寫入 I/O 另有 300 秒停滯期限。

## 續接

派遣成功並完成驗證後，結果會回傳 `subagentSessionId` 與 `canResume: true`：

```json
{ "resume": "<subagentSessionId>", "title": "實作並驗證方案 B", "task": "採用方案 B，繼續實作並執行驗證。" }
```

- Resume 只接受 `resume`、非空 `task` 與選填顯示用 `title`；不可同時提供 agent、tasks、chain、cwd、provider、model、thinkingLevel、agentScope、confirmProjectAgents。
- 只接受完整小寫 ULID（沿用舊版 UUID 的既有 session 仍可續接）；續接只載入該 child 自己的歷史，看不到 parent 新對話。
- Parallel／chain 每個 item／step 各有獨立 session，不共用 context。
- 限相同 parent session 與 canonical parent cwd。
- 保存 agent 定義、cwd、model、thinking 與 trust；agent 被修改／移除、cwd 或 model 不可用、信任改變時拒絕。
- 只有 ready 的 session 可續接；busy、blocked 的不會被接管。
- 先前 ready 的 session 續接時若 run 失敗、取消或逾時（child 已確實結束，且非 checkpoint／commit／startup 驗證類失敗），會在 checkpoint 的 native hash 前綴仍相符時，把 native 檔與 readable transcript 截回 checkpoint 位元組並還原為 ready；前綴不符則維持 blocked。首次 run 失敗仍為 blocked。
- Parent crash 遺留的 `writer.lock`：僅當 owner.json 記錄的 pid 已不存在（且不是本 process）、並有已驗證的 checkpoint 時，才會接管並依上述規則回復；pid 仍存活或無法驗證時維持 SESSION_BUSY／SESSION_BLOCKED，不自動接管。pid 可能被作業系統重用，此為 best-effort 判斷。
- 錯誤碼：`INVALID_DISPATCH`、`SESSION_NOT_FOUND`、`OWNER_MISMATCH`、`SESSION_BUSY`、`SESSION_BLOCKED`、`DUPLICATE_DISPATCH`、`METADATA_UNSUPPORTED`、`CHECKPOINT_MISMATCH`、`CONFIG_CHANGED`、`CWD_UNAVAILABLE`、`MODEL_UNAVAILABLE`、`TRUST_REQUIRED`、`COMMIT_FAILED`。
- 不保證副作用 exactly-once。

若需要決策，child 應回報選項後正常結束，不要常駐等待。

## 內建 agents

| Agent | tools | 用途 |
| --- | --- | --- |
| `scout` | read, grep, find, ls, bash | 快速探索程式碼並產生可交接的精簡 context |
| `planner` | read, grep, find, ls | 依需求與 context 產生實作計畫（唯讀） |
| `reviewer` | read, grep, find, ls, bash | 品質、安全與可維護性 review（bash 僅限唯讀） |
| `worker` | 不限定 | 通用、完整能力；僅在使用者或 skill 指派時啟動 |

內建 agents 不固定模型，繼承主 session。

## 自訂 agents

Markdown 檔，位置：

- 使用者層級：`~/.pi/agent/agents/*.md`（遵循 `PI_CODING_AGENT_DIR`）
- 專案層級：從 cwd 向上找到最近的 `.pi/agents/`

優先順序：專案 > 使用者 > 內建（同名覆寫）。`agentScope` 預設 `"user"`，需指定 `"both"` 或 `"project"` 才會使用專案 agents。

Frontmatter：`name`、`description`（必填，皆須為字串）、`tools`（逗號字串或陣列）、`model`（選填）；本文為 system prompt。格式錯誤的檔案會被略過。

```markdown
---
name: test-writer
description: Designs and implements focused tests
tools: read, grep, find, ls, bash
model: claude-sonnet-4-5
---

You write focused, reliable tests. Inspect the existing test conventions first.
```

## Prompt 指令

| 指令 | 流程 |
| --- | --- |
| `/implement <需求>` | scout → planner → worker |
| `/scout-and-plan <需求>` | scout → planner（不實作） |
| `/implement-and-review <需求>` | worker → reviewer → worker 套用回饋 |

## Sub-session 儲存

位於 `<agentDir>/subagent-sessions/<subagentSessionId>/`（預設 `~/.pi/agent`）：

```text
manifest.json         # owner、配置、狀態、checkpoint
pi/*.jsonl            # Pi 原生 session
transcript.jsonl      # 查閱 log（user／assistant／tool_call／tool_result）
runs/<taskId>/        # 每次 invocation 的 result、usage、diagnostics
dispatch/             # dispatch key
writer.lock/          # 獨占鎖
```

- 單一 conversation 檢查上限約 512 MiB／10,000 個檔案目錄（軟性上限，非 disk quota）；原生 session 檢查上限 8 MiB record、128 MiB file、16,384 entries。
- 沒有自動 TTL、pruning 或 stale-lock 接管；需確認無 writer 後手動移除整個目錄（ID 隨之失效）。
- Log 可能含程式碼、工具輸出或憑證，分享前請自行檢查。

## 設定

唯一設定鍵位於全域 `<agentDir>/settings.json`（不讀取專案 `.pi/settings.json`）：

```json
{
  "pi-subagents": {
    "debugLog": true
  }
}
```

| 鍵 | 預設 | 說明 |
| --- | --- | --- |
| `pi-subagents.debugLog` | `false` | 僅布林 `true` 啟用；缺少、`false`、字串、格式錯誤皆視為關閉。每次工具呼叫重新讀取 |

啟用後，每個 `failed` task 寫入一份 JSON 到 `~/.pi/logs/pi-subagents/`（內容含 system prompt、task、final／partial response、錯誤與 sub-session 路徑，可能含敏感資訊）。診斷為 best-effort，寫入失敗不影響派遣結果；無自動清理。

## 安全邊界

- 所有 child 以 `--exclude-tools subagent` 啟動，無法再次派遣 subagent。若 agent 有 shell 權限仍可自行執行 `pi`，需另用 sandbox 限制。
- Child 另載入 startup guard，於第一個 provider request 前驗證 model registry 與 trust；不複製 parent 的臨時 provider、credentials 或一次性 approve。Child 須能自行載入相同 provider 定義。
- Process isolation 不是 credential 隔離或 OS sandbox。只使用你信任的 agents。
