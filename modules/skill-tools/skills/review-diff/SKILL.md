---
name: review-diff
description: Review a change set with an independent reviewer subagent and report prioritized findings. Use when the user asks for a code review of uncommitted changes, a base-branch diff, a commit, or custom review instructions.
---

# Diff 審查

用獨立子代理審查指定範圍的變更，回報可執行、可定位的 findings。審查不是修復：審查期間不修改被審查的檔案，也不產生 patch。

本 skill 只負責確認範圍、解析 diff 基準、派出子代理並核對回報。審查判斷全部由子代理依 `references/rubric.md` 執行，主代理不重做一次。

## 1. 確認範圍

只有四種範圍，對應的取 diff 方式是固定的：

| 範圍 | 子代理要執行的指令 |
| --- | --- |
| 未提交變更（預設） | `git status --porcelain` 取得含 untracked 的清單、`git diff` 取已追蹤變更；untracked 檔案直接讀取內容 |
| base branch | `git diff <merge-base-sha>`（由主代理先算好；含工作樹的未提交已追蹤變更，不含 untracked，需要時另用 `git status --porcelain` 列出） |
| 單一 commit | `git show <sha>` |
| 自訂指示 | 使用者原文，不改寫、不擴充 |

- 呼叫參數已指定範圍時直接採用，不再詢問。
- 未指定且範圍會改變審查結果時，用一則純文字提問列出選項後結束回合；提問中不夾帶審查內容或推測的 findings。
- base branch 或 SHA 無法解析時停止並回報實際錯誤，不猜近似範圍、不改用其他基準。

## 2. 解析基準

主代理只跑定位用的唯讀命令：

- `git rev-parse --abbrev-ref HEAD` 與 `git rev-parse HEAD` 記錄程式碼基準。
- base branch 走 `git merge-base HEAD <branch>`；該分支設定 upstream 且 upstream 領先本地時改用 `git merge-base HEAD <branch>@{upstream}`。算不出來就停止並回報，不退回合子代理自己找。
- 記錄工作目錄絕對路徑，子代理以該目錄執行。

diff 內容由子代理自己取，主代理不轉貼。

## 3. 派出子代理

用 `subagent` single 模式、`agent: "reviewer"`（唯讀工具集＋`note`）。子代理看不到本 skill 也看不到父對話，所以 task 必須自包含：

1. rubric 絕對路徑：本 skill 目錄下的 `references/rubric.md`，要求先完整讀取。
2. 範圍與確切指令：上一節解析出的分支／SHA／工作目錄，以及要執行的 git 指令。
3. 輸出格式：task 明確指定以 rubric 的「結論／未涵蓋／Findings」作為 report 內容，覆寫 `reviewer` agent 預設的 report 段落（Files Reviewed／Critical／Warnings…）；`reviewer` 的 note-only 寫入、一句 verdict 加回傳相對路徑（少於 150 words）與 note 失敗即回報受阻的規則照舊，不改動 agent 定義。
4. 邊界：只讀審查，不修改檔案、不 commit、不產生 patch；不得以推論代替實際讀 diff 與周邊程式碼。
5. 可驗證性：每個 finding 的位置必須落在本次 diff 內。

```json
{ "agent": "reviewer", "title": "審查未提交變更", "task": "先完整讀取 <skill 目錄>/references/rubric.md 並依其審查。範圍：未提交變更（含 untracked）。工作目錄：<abs cwd>。基準：HEAD <sha>。執行 git status --porcelain 與 git diff，untracked 檔案直接讀取。report 內容改用 rubric 的結論／未涵蓋／Findings 格式（覆寫 agent 預設段落），以 note 產生 report，回覆只給一句 verdict 與回傳的相對路徑。只讀審查，不修改檔案、不 commit、不產生 patch。" }
```

同一回合只派一個 reviewer；需要多個範圍時逐一派遣，不合併成一個 task。

## 4. 核對與回報

- 確認回報中的 report 路徑真實存在。
- 抽驗 findings 的位置是否落在該範圍的 diff 內；範圍外、檔案不存在或明顯誤讀的，要求子代理重審一次並說明原因，只重審一次。
- 回覆使用者：一句 verdict、report 相對路徑、未涵蓋的範圍或未執行的檢查。不重述完整 findings，也不補充子代理沒有的問題。

沒有 `subagent` 可用時，明講無法提供獨立審查，不以主代理自行審查冒充。
