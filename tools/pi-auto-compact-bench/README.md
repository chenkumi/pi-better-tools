# Pi Auto Compact 長程任務試驗

兩個自訂任務，用來比較 `pi-auto-compact` 與 Blackhole（或 Pi 原生壓縮）在**連續壓縮多次**後的表現。腳本只產生資料與判分，**不呼叫任何模型**；真正跑任務是你手動在 Pi 裡進行，會花真實模型費用。

## 任務

| 模式 | 測什麼 | 設計 |
|---|---|---|
| `constraint` | 第 1 種：早期約束回憶（L3／savepoint 是否保住脈絡） | 開頭只說一次三條規則，之後 60 個小項目，每項要完整讀一個約 30k 字元的檔案。判分檢查每個檔案是否仍遵守規則，另看 `legacy/` 是否被動過、最後 `FINAL.md` 是否還記得規則 |
| `parallel` | 第 2 種：大型平行讀取（L1 填不滿、L2 借用） | 12 個項目，每項要一次平行讀 6 個約 25k 字元的檔案，再寫出六個 ACTIVE 數字的總和。判分檢查總和 |

兩者總讀入量約 180 萬字元（約 80 萬 token @2.2），在 200k 窗口下預期壓縮約 4～5 次。要更多壓縮就調高 `--items`，或用 context window 較小的模型。

## 步驟

```bash
# 1. 產生（同 seed 內容相同，A/B 要用同一份）
node gen.mjs --mode constraint --out D:/bench/c1 --seed 1
node gen.mjs --mode parallel   --out D:/bench/p1 --seed 1

# 2. 每個要比較的組態各複製一份 workspace（只複製 workspace，不要把 expected.json 放進去）
cp -r D:/bench/c1/workspace D:/bench/c1-auto/workspace   # 之後 --dir 指向 c1-auto，並把 expected.json 一起放在 c1-auto/

# 3. 在該 workspace 啟動 Pi，掛載要比較的壓縮 extension（pi-auto-compact 或 Blackhole，只掛其一），
#    把 PROMPT.md 的內容貼進去，讓它跑到結束。不要中途插話或手動壓縮。

# 4. 判分與蒐集
node score.mjs   --dir D:/bench/c1-auto
node collect.mjs <該次 session 的 .jsonl>
```

## 要看的指標

- `score.mjs`：通過項目數、**後半段失敗數**（規則在壓縮後被遺忘會集中在後半）、`rule1/2/3`、FINAL.md 的規則回憶。
- `collect.mjs`：壓縮次數與各次的 `guard`／`windowStartKept`／`cutMoved`／`l2Lent`／`keptChars`、`session_*` 回溯工具呼叫次數、`cacheReadShare`、總成本。
- 比較要點：同 seed、同模型、同 context window，每組至少重複 3 次；單次結果變異大，不能下結論。

## 注意

- 提示要求「完整讀檔、不要 grep」，但模型仍可能用 grep 或只讀片段，那會降低 context 壓力；`collect.mjs` 的工具呼叫統計可以看出來。
- `constraint` 的規則只在 PROMPT.md 說一次；如果模型自己把規則寫進 TASKS.md 或筆記檔，它就是在繞過壓縮，判分時要留意。
- `--solve` 只用來驗證判分器，**不要**對要給模型跑的 workspace 使用。
- 本目錄在 `tools/`。產生的 workspace 約 2 MB，放在 repository 之外。
