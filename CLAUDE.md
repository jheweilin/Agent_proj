# Plasma Agent（獨立部署版）

在這台 NLPServer（140.134.26.142，Ubuntu 24.04，2 × RTX 4070 Ti SUPER）上運作的電漿物理研究 agent，包含網頁前後端。
設計參考 SciencePal（fcu.sciencepal.ai）的 Plasma Agent，但**完全獨立**：不依賴 SciencePal 的主機、Supabase、Daytona 或 LiteLLM。
完整計畫與決策紀錄在 `docs/PLASMA_AGENT_PLAN.md`。

- 網址：http://140.134.26.142:8600（開放註冊）
- 回覆使用者一律用**繁體中文**。

## 架構

docker compose 專案 `plasma-agent`（`deploy/docker-compose.yml`，密鑰在 `deploy/.env`，權限 600，不進 git）：

| 服務 | 說明 |
|---|---|
| postgres:16 | 帳號、對話、訊息、執行紀錄；資料在 `/data/plasma-agent/postgres` |
| redis:7 | 工作佇列 `pa:queue`、`pa:cleanup`；事件 stream `pa:run:{id}:events`；沙盒狀態 `pa:sbx:status:{thread}` |
| api | FastAPI，同時提供網頁靜態檔；對外 8600→8000 |
| worker | agent 迴圈；掛載 `/var/run/docker.sock` 和 `~/.aws:ro` |

api 和 worker 共用同一個 image `plasma-agent:latest`（`Dockerfile`：先用 node 編譯 `web/`，再建 python app）。

- **LLM**：Amazon Bedrock，`anthropic.AsyncAnthropicBedrock(aws_region="ap-southeast-1")`，模型 `global.anthropic.claude-sonnet-5-5`；被拒絕時改用 `global.anthropic.claude-opus-5-5`；標題用 `global.anthropic.claude-haiku-5-5`。憑證來自 `~/.aws`（IAM 使用者 `sciencepal`，目前與正式環境共用帳號）。`AnthropicBedrockMantle` 在這個 region 找不到模型，不要改用它。Bedrock 沒有 Claude 內建的 web_search，所以搜尋是自己實作的工具。
- **沙盒**：worker 透過 Docker API 為每個對話建立一個 `public.ecr.aws/z1o8z4f9/agent:plasma-1.1.0` 容器（名稱 `pa-sbx-<id12>`，CDI 只給 `nvidia.com/gpu=0`，記憶體 16g、12 顆 CPU）。`/workspace` 掛載 `/data/plasma-agent/workspaces/<thread_id>`，閒置 120 分鐘自動停止。映像檔裡有 PlasmaPy 2025.10、SMILEI、happi、Gmsh、Hermes-3（BOUT++ 5 只有函式庫，沒有 `bout++` 執行檔）、PyTorch CUDA，也有 Playwright。
- **COMSOL 範例庫**：主機 `/data/jhewlin/comsol64_applications`（COMSOL 6.4 Application Library，44 個模組、2,094 個 `.mph`，環境變數 `COMSOL_LIBRARY_DIR`）唯讀掛到每個沙盒的 `/comsol_examples`。`sandbox._ensure_sync` 遇到沒有這個掛載的舊沙盒會砍掉重建（`/workspace` 保留，有背景計算在跑時不動）。用法在 `docs/comsol_examples/library/`。
- **COMSOL**：實驗室共用的 REST API `http://140.134.138.17:2035/api/v1`（COMSOL 6.4，一次只跑一個 job，無認證），說明在 `docs/AGENT_GUIDE.md`。**Plasma Module 已驗證有授權。**

## 程式碼位置

```
backend/plasma_agent/
  config.py      環境變數設定
  db.py          資料表：users、threads、messages（原樣保存 API 的 content blocks，只附加不修改）、runs
  events.py      Redis 佇列與事件
  sandbox.py     沙盒容器管理、路徑限制在 /workspace 之內、閒置停止
  agent.py       agent 迴圈（串流、工具依序執行、拒答時改用備援模型、補上中斷的工具結果、產生標題）
  worker.py      取出工作執行、清理被刪除的對話、回報沙盒狀態和 GPU 用量
  api.py         REST + SSE（含 /tools/{id} 完整步驟、/status 狀態面板）
  auth.py        bcrypt + JWT
  tools/         sandbox_tools.py、web.py（Tavily 或 ddgs、arXiv、OpenAlex）、comsol.py
prompts/plasma_system.md     system prompt
docs/comsol_examples/        argon_gec_ccp/（官方匯出的 GEC CCP 模型）、plot_data/（數據區塊輔助函式 PlotDataDemo.java）→ 沙盒 /workspace/.guides/comsol_examples/
docs/guide_tools/            comsol_quickplot.py（數據區塊 CSV → 預覽圖）→ 沙盒 /workspace/.guides/tools/
web/src/                     React 前端：App、Chat、Render（時間軸）、tools.tsx（每種工具的顯示）、Panel（步驟／檔案／狀態）、Code
deploy/e2e.py                端到端測試腳本
test_project/                使用者提供的 GEC CCP 範例檔（不進 git）
```

## 修改後的部署流程

```bash
cd ~/Agent_proj
# 前端有改的話先檢查（web/ 底下）：npm install && npx tsc -b && npx vite build
cd deploy
docker compose exec -T postgres psql -U plasma -d plasma -At \
  -c "select count(*) from runs where status in ('queued','running')"   # 必須是 0 才重啟，否則會中斷使用者的執行
docker compose build -q && docker compose up -d api worker
curl -s http://127.0.0.1:8600/api/health
docker compose logs --tail 50 worker
```

只改 prompt 也要重新 build（prompt 是打包在 image 裡的）。

## 測試

- 端到端：`.venv/bin/python deploy/e2e.py "<問題>"`（用測試帳號 `e2e-test@plasma.local`；`UPLOADS=a.txt,b.pdf` 可以附上檔案）。會印出每個工具呼叫、結果和最後的回覆。
- UI 截圖：`mkdir -p /tmp/pa-shots && cp deploy/shot.py /tmp/pa-shots/ && docker run --rm --network host -v /tmp/pa-shots:/out --entrypoint bash public.ecr.aws/z1o8z4f9/agent:plasma-1.1.0 -lc "python /out/shot.py <thread_id>"`，截圖會輸出到 `/tmp/pa-shots/*.png`（desktop、detail、files、welcome、dark、mobile），再用 Read 工具看圖。腳本會用 e2e 測試帳號登入；`<thread_id>` 要用該帳號擁有的對話。
- 已通過的案例：PlasmaPy 參數計算、SMILEI two-stream（MPI 加背景 job）、COMSOL 2D 靜電模型（50 V 與解析解一致）、文獻搜尋、GEC CCP 只建到網格的驗證。

## COMSOL 結果怎麼回來（2026-11-03 已修改 COMSOL 服務）

- COMSOL REST API 跑在 140.134.138.17（fcu-plasma06，帳號 fcu-plasma，sudo 需要密碼）：systemd `comsol-api.service`，以 root 執行 `/home/fcu-plasma/Comsollic/Comsol-main/comsol-api/main.py`，log 在 `/var/log/comsol-api.log`。說明檔是同目錄的 `AGENT_GUIDE.md`（本專案 `docs/AGENT_GUIDE.md` 是同一份）。
- 2026-11-03 改了 `main.py`（原檔備份在 `main.py.bak-20261103`）：(1) 三處 `comsol batch` 都加上 `-3drend sw`，沒有這個參數時 Image 匯出不報錯、但也不產生檔案；(2) 新增 `_snapshot_dir`／`_collect_exported_files`：batch 結束後，把工作目錄（＝上傳目錄）裡新產生的檔案（不含 .class/.java）複製到結果目錄，所以會出現在 `output_files`，也能從 `/download` 下載。log 裡會有 `--- Exported files collected: ... ---`。
- 因此 agent 現在用 COMSOL 原生出圖：建立 plot group，再用 `docs/comsol_examples/plot_data/PlotDataDemo.java` 的 `exportImage`（Image 匯出，要用 `plotgroup` 屬性、`./xxx.png` 相對路徑，並打開 options/title/legend/axes）。已驗證 Surface、Contour、ArrowSurface、CutLine2D 上的 LineGraph。
- 第二次修改（備份在 `main.py.bak-20261103b`）：batch 送出時，如果有 `.java`/`.class`，它就是主檔，同時上傳的 `.mph` 都當成資料檔。因此可以**後處理既有結果、不必重算**：Java 用 `ModelUtil.load("m", "xxx_result_Model.mph")` 載入，再取值或出新圖（範例在 `docs/comsol_examples/postprocess/`，小模型載入約 4.5 秒）。`comsol_submit` 會自動附上 Java 引用的 `.mph`（`.save()` 寫出的 `.mph` 視為輸出）。沙盒裡雖然裝了 MPh 1.4.0，但沒有本機 COMSOL，`find_backends()` 是空的，所以開不了 .mph。
- 服務不回傳 `.java`，要把 `.mph` 匯出成 Java 得用 `model.save("./name.txt", "java")`（2026-11-06 實測；`./x.java.txt` 和沒有副檔名都拿不回來），範本在 `docs/comsol_examples/library/ExportModelJava.java`。
- 仍然的限制：Java 本身不能讀寫檔案、不能讀 `System.getProperty`、不能呼叫 `getProtectionDomain`；batch 產生的 .mph 沒有縮圖。
- log 數據區塊（`#PA_DATA_BEGIN`…`#PA_DATA_END`，用 dumpGrid2D、dumpLine、dumpTable）保留做數值檢查：平台會轉成 CSV 和預覽圖，並算出 min/max/mean。
- `comsol_job` 在 batch 成功時會自動執行 `_collect_results`：下載全部結果到 `/workspace/comsol/<job_id>/`，附件順序是 COMSOL 圖片 → 數據區塊預覽圖 → .mph 預覽圖 → .mph／.mph.status／匯出的數據檔 → CSV。用 `.collected.json` 當標記避免重複處理。
- 改 COMSOL 服務前，先確認 `/api/v1/health` 的 `running_job` 是 null 而且 `queue_size` 是 0，再 `sudo systemctl restart comsol-api`。這個服務整個實驗室共用，同一台機器上還有 claude2comsol、warpx-comsol-web 等服務也在用 COMSOL，不要動它們。

## 前端顯示規則

- 上傳檔案到 `/workspace/uploads`：composer 的「＋ 上傳檔案」按鈕，或把檔案**拖曳**到對話區（`Chat.tsx` 的 drag & drop，拖進時顯示 `.drop-overlay` 提示；用 dragenter/dragleave 計數避免子元素閃爍）。兩者都走 `pickFiles` → `api.upload`，上傳後在 composer 顯示 chip、下次送出帶上。
- 長時間工具（目前是 COMSOL 求解）在執行中會顯示**步驟內進度條**：`comsol_job` 等待時每 5 秒抓一次 log，用 `_parse_progress` 解析 COMSOL 的 `Current Progress: N % - <階段>`（階段空就退回 `<---- … in Study` banner），`publish` 一個 `tool_progress` 事件（帶該步驟的 `id`）。前端 `reduce` 把它綁到對應 step、`Render.tsx` 的 `StepProgress` 顯示階段＋百分比＋進度條＋已耗時（排隊時顯示「排隊第 N 位」）。進度是暫態、只在串流中顯示，run 結束重載後換成結果。機制通用：工具靠 `ctx.tool_use_id`（agent 迴圈每次呼叫前設定，工具依序執行所以安全）就能把進度綁到自己的步驟。
- 已完成的回覆，步驟群組預設收合（只顯示「已執行步驟 · N」和用了哪些工具）；執行中的那一輪展開。
- 每個步驟預設只顯示一行標題，點了才展開；失敗的步驟自動展開。步驟標題用 agent 填的 `step_note`（繁中一句話說明這步在做什麼），原始命令／檔名退成灰字次要；沒有 `step_note` 時才 fallback 回工具類型名。`step_note` 是 `tools/base.py` 的裝飾器自動注入到**每個**工具 schema 的必填參數（放在參數最前面配合 eager streaming），prompt 要求每次呼叫都填；設成非必填時 Sonnet 會跳過不填，所以必須 required。
- 「詳情 ›」會在右側面板顯示完整的輸入與輸出。
- 回覆最後的「本次產生的檔案」卡片（`Render.tsx` 的 `Attachments`）：圖片排最前面，每張都有預覽和下載；其他主要成果（.mph、CSV、程式碼等）顯示類型、大小、所在資料夾；中間檔案（`.log`、`.status`，`isSecondaryFile` 正則判斷）收進「其餘 N 個檔案（log、狀態等） ›」，預設收合、點了才展開；「全部下載」會呼叫 `GET /api/threads/{id}/zip?path=...&path=...` 打包成 zip（含收合的檔案）。
- 只有一輪 assistant turn 裡的**最後一個** text block 當作正式回覆（正文 Markdown 顯示）；模型在工具呼叫之間寫的其他 text block 會收合成灰字「說明」條（`Render.tsx` 的 `InterimNote`，和思考區塊一樣可點開），避免中間碎句當正文。串流進行中（live）維持全顯示即時可見，完成後才收合。prompt 也要求模型把 running commentary 放思考區塊、別寫成可見 text。
- prompt 規定最後一則回覆的格式：結論 → 設定與方法 → 結果（表格與驗證方式）→ 產生的檔案（每個檔案一行說明）→ 限制與後續。圖片不要用 Markdown 嵌在文字裡，因為卡片已經會顯示。

## 必須遵守

- **這台是共用機**：只能操作 `plasma-agent` compose 專案和 `pa-sbx-*` 容器。不要停止、刪除或重啟 dify、wrenai、nuclio、carbon-analyzer 等其他服務，也不要刪別人的映像檔或 volume。`wrenai-qdrant` 一直在重啟是它自己的資料損壞，跟我們無關，不要去修。
- 根磁碟只剩約 100 GB，大型資料放 `/data`。
- 送出會跑超過幾分鐘的 COMSOL 求解前（例如 GEC CCP 完整求解約 20 分鐘），要先問使用者，因為整個實驗室共用同一個 COMSOL 服務。
- 對話紀錄只能附加、不能修改（Claude 的思考區塊必須原樣回傳）。
- 思考區塊會綁定產生時的 system prompt 和工具清單：只要改了 prompt 或工具說明，舊對話就會回 400 `Invalid signature ... bound to a different conversation`。所以每次請求都帶 beta `thinking-binding-controls-2026-08-01` 加 `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`（Bedrock 實測可用），失效的思考區塊會被丟掉，不會報錯；如果 beta 被拒絕或還是 400，就在那次請求中拿掉舊的思考區塊再重試（`agent.py` 的 `_without_thinking`，不修改資料庫）。不要拿掉這個機制。
- `sandbox._ensure_sync` 每次都會刷新 `/workspace/.guides/`，所以部署後新增的範例在舊對話裡也看得到。
- 工具必須依呼叫順序逐一執行（曾因同時執行造成讀到舊檔）。
- git commit 要等使用者開口才做。

## 測試中學到的事（已處理，改程式時不要改回去）

- matplotlib 只認得 .ttc 字型檔裡的第一個字型：中文要用 `WenQuanYi Zen Hei` 或 `Noto Sans CJK JP`（用 TC 會找不到）。
- Sonnet 5.5 會把工具呼叫之間的說明寫進思考區塊，所以 prompt 規定最後一則回覆要有完整總結。
- COMSOL log 只回報錯誤標記；`comsol_job` 會把標記後面的實際錯誤內容放進 `error_details`。COMSOL 服務無法輸出圖片，要匯出數據後在沙盒用 matplotlib 畫。
- `comsol_submit` 會自動附上 Java 程式碼引用的資料檔（例如 `Ar_xsecs_reduced.txt`）；Java 裡要用純檔名，不能帶目錄。
- Box selection 要設 `condition=inside`，座標單位要和幾何一致；`getReal()` 的形狀是 `[nExpr][nPoints]`；沒有 `MaxMin` 這種 feature。
- 標題模型的 max_tokens 不能太小，否則會全部用在思考上、拿不到文字。

## 待辦

- git commit（等使用者要求）
- 要不要提供 Tavily key（目前用 ddgs）
- 之後改用獨立的 AWS IAM 使用者
