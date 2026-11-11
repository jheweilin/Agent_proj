# 通用研究助理（Agent_proj）

在這台 NLPServer（140.134.26.142，Ubuntu 24.04，2 × RTX 4070 Ti SUPER）上運作的**通用研究 agent**，含網頁前後端。原本是電漿物理專用，已演進成通用（不綁電漿、核心仍是做研究）；plasma 變成其中一個領域。設計參考 SciencePal（fcu.sciencepal.ai）但**完全獨立**：不依賴它的主機、Supabase、Daytona 或 LiteLLM。

- 網址：http://140.134.26.142:8600（開放註冊）；回覆使用者一律用**繁體中文**。
- 設計／決策紀錄：`docs/RESEARCH_AGENT_PLAN.md`（通用化九階段設計）、`docs/PLASMA_AGENT_PLAN.md`（最初的 plasma 版）。
- git：已推到 **github.com/jheweilin/Agent_proj** 的 `main`（用 SSH `git@github.com:jheweilin/Agent_proj.git`，key 已綁）。`deploy/.env`（密鑰）不進 repo。**git commit 要等使用者開口才做。**

## 兩種模式

- **一般對話（chat）**：單一 agent 迴圈（最早的 Phase A 行為），配領域 prompt 與工具。
- **研究專案（project）**：`ar.jpg` 的**九階段 pipeline**，有兩個人工關卡。前端新建時按頂部列「＋ 新研究」開**置中 modal**（`NewThreadModal.tsx`）選模式／領域，並有「進階選項」可**為每個 agent（chat 助理＋六個 pipeline 角色）各指定 LLM**，另含 effort、max_iterations。設定存在 `threads.config`（JSONB），建立時決定、整條 pipeline 沿用。

九階段：① 釐清 Clarifier → ② 檢索證據（程式）→ ③ 規劃 Planner →〔④ 你核准計畫〕→ ⑤ 研究 Researcher（沙盒）→ ⑥ 獨立驗證 Verifier → ⑦ 第二實作 Replicator（隔離複現）→ ⑧ 唯讀審查 Reviewer → ⑨ 等級與報告（程式）→〔你接受／拒絕〕。退回邊：④ 退回→重新釐清；⑥ 驗證沒過→自動退回 ⑤ 研究（上限 1 次）；⑨ 拒絕→重做研究。

## 架構

docker compose 專案 `plasma-agent`（`deploy/docker-compose.yml`，密鑰在 `deploy/.env`，權限 600）：

| 服務 | 說明 |
|---|---|
| **pgvector/pgvector:pg16** | PostgreSQL 16＋`vector` 擴充；帳號／對話／訊息／執行／研究專案／知識庫向量；資料在 `/data/plasma-agent/postgres`（2026-11-10 從 `postgres:16-alpine` 換成這個，同份 PG16 資料夾相容，換前有 `pg_dump` 備份在 `/data/plasma-agent/backups/`）|
| redis:7 | 工作佇列 `pa:queue`、`pa:cleanup`；事件 stream `pa:run:{id}:events`；沙盒狀態 `pa:sbx:status:{thread}` |
| api | FastAPI，同時提供網頁靜態檔；對外 8600→8000 |
| worker | agent／pipeline 迴圈；掛 `/var/run/docker.sock`、`~/.aws:ro` |

api 和 worker 共用 image `plasma-agent:latest`（`Dockerfile`：node 編譯 `web/` → python app）。**Dockerfile 有 `ARG PIP_INDEX_URL`**：這台連 pypi.org 很慢（約 8 秒/次），改 requirements 觸發全套件重裝時 build 會卡很久；必要時 `docker compose build --build-arg PIP_INDEX_URL=<mirror>`（使用者已授權，auto 模式會擋第三方 index 需同意）。requirements 不變時走快取、很快。

- **LLM**：Amazon Bedrock，`anthropic.AsyncAnthropicBedrock(aws_region="ap-southeast-1")`，主模型 `global.anthropic.claude-sonnet-5-5`；拒答改 `global.anthropic.claude-opus-5-5`；標題／分類用 `global.anthropic.claude-haiku-5-5`。憑證來自 `~/.aws`（IAM `sciencepal`，與正式環境共用）。不要改用 `AnthropicBedrockMantle`（此 region 找不到模型）。Bedrock 沒有內建 web_search，搜尋是自己實作的工具。**每個 thread 可在 `threads.config` 覆寫每個 agent 的 model 與 effort／max_iterations**：`agent.thread_runtime(thread, key)` 解析（key＝`"chat"` 或角色名），`Runner(model=,effort=,max_iters=)` 吃；`pipeline._run_role` 按角色各自解析。拒答備援仍用 `settings.fallback_model`（per-run）。白名單＝`config.AVAILABLE_MODELS`／`VALID_MODEL_IDS`，`api._sanitize_config` 過濾、`GET /api/models` 給前端。
- **知識庫 embedding／rerank**：**Voyage AI**（`voyage-3.5` embedding 1024 維、`rerank-2.5`），key 在 `deploy/.env` 的 `VOYAGE_API_KEY`。這是新增的對外依賴（voyageai.com）。
- **沙盒**：worker 透過 Docker API 為每個對話建一個 `public.ecr.aws/z1o8z4f9/agent:plasma-1.1.0` 容器（名 `pa-sbx-<id12>`，CDI 只給 `nvidia.com/gpu=0`，16g 記憶體、12 CPU）。`/workspace` 掛 `/data/plasma-agent/workspaces/<thread_id>`，閒置 120 分鐘自動停。映像有 PlasmaPy 2025.10、SMILEI、happi、Gmsh、Hermes-3（BOUT++5 只有函式庫）、PyTorch CUDA、Playwright。**目前所有領域共用這個映像**（通用輕量映像尚未做）。
- **COMSOL 範例庫**：主機 `/data/jhewlin/comsol64_applications`（6.4 Application Library，44 模組、2,094 `.mph`，`COMSOL_LIBRARY_DIR`）唯讀掛到每個沙盒 `/comsol_examples`。`sandbox._ensure_sync` 遇到沒這個掛載的舊沙盒會砍掉重建（`/workspace` 保留，有背景 job 時不動）。用法在 `docs/comsol_examples/library/`。
- **COMSOL 服務**：實驗室共用 REST API `http://140.134.138.17:2035/api/v1`（6.4，一次一個 job，無認證），說明 `docs/AGENT_GUIDE.md`。**Plasma Module 已驗證有授權。**

## 程式碼位置

```
backend/plasma_agent/
  config.py        環境變數設定（含 voyage_*、default_domain、max_context_chars、admin/faculty emails）＋AVAILABLE_MODELS 白名單
  db.py            資料表：users、threads(含 domain/mode)、messages(原樣保存 content blocks，只附加)、
                   runs(含 stage)、projects(九階段研究卡：stage/status/card)、kb_datasets/kb_documents/kb_chunks(pgvector)
  events.py        Redis 佇列與事件
  sandbox.py       沙盒容器管理、路徑限制在 /workspace、閒置停止
  domains.py       領域 profile（plasma=全工具；general=排除 comsol_*）→ 選 prompt 與工具集
  roles.py         九角色（clarifier/planner=無工具；researcher/verifier=全工具；
                   replicator=replicate 模式排除 kb/web/comsol；reviewer=readonly 只讀）＋ overlay prompt
  agent.py         agent 引擎：串流迴圈、工具依序執行、拒答改備援、補中斷工具結果、產生標題、
                   Runner(role, init_messages)、thinking-binding、_fit_context(超長時裁較早工具輸出)
  pipeline.py      九階段 FSM：各階段執行、研究卡、程式檢索②、程式驗證⑥、隔離複現⑦、唯讀審查⑧、
                   程式定等級⑨、人工關卡(approve/reject)、注入訊息用機器 marker [[pa:...]]
  kb.py            知識庫：Voyage embed/rerank、chunk、ingest、pgvector 檢索、三層 dataset(task/base/lab)、基礎庫／lab 庫管理
  worker.py        取工作執行、清理被刪對話、回報沙盒/GPU
  api.py           REST + SSE（/tools、/status、/domains、approve/reject、/kb/base 管理）
  auth.py          bcrypt + JWT
  tools/           base.py(工具註冊＋step_note＋definitions 白名單)、sandbox_tools.py、web.py(Tavily/ddgs、arXiv、OpenAlex)、
                   comsol.py、kb.py(kb_search/kb_read)、pipeline_tools.py(record_verification/replication/review)
prompts/           plasma_system.md、general_system.md（領域 prompt；角色 overlay 內嵌在 roles.py）
docs/              RESEARCH_AGENT_PLAN.md、PLASMA_AGENT_PLAN.md、AGENT_GUIDE.md、comsol_examples/、guide_tools/
web/src/           App(頂部導覽＋對話抽屜)、Chat(對話＋階段渲染)、Render(時間軸/襯線報告)、tools.tsx、
                   Panel(步驟/檔案/狀態＋知識庫卡)、Pipeline.tsx(九階段 tracker＋核准卡＋等級卡)、
                   KbLibrary.tsx(基礎庫 modal)、LabLibrary.tsx(實驗室庫 modal)、NewThreadModal.tsx(新建 modal＋進階 per-agent model)、brand.ts(APP_NAME)、Code、Login、api.ts、index.css
deploy/e2e.py      端到端測試腳本；deploy/shot.py UI 截圖
test_project/      使用者提供的 GEC CCP 範例檔（不進 git）
```

## 九階段 pipeline 細節（`pipeline.py` / `roles.py`）

- 每個 LLM 角色＝領域 prompt＋角色 overlay＋工具白名單，由 `_run_role` 用一個 `agent.Runner` 跑一輪 loop，usage 併回外層 run。
- **程式階段**：② 檢索證據（先查該 thread 知識庫＋基礎庫，再查 arXiv/OpenAlex，合併成證據注入給 Planner）；⑨ 等級（`_grade` 綜合驗證＋複現＋審查：審查說不一致會把「通過」降「部分通過」）。
- **結構化輸出**：Verifier/Replicator/Reviewer 結束前分別呼叫 `record_verification`／`record_replication`／`record_review`（寫 `/workspace/.pipeline/*.json`，pipeline 讀回算等級、存進 `project.card`）。
- **隔離複現**：`agent.Runner(init_messages=...)` 讓複現者**只從「計畫」這個構造好的上下文開始**（看不到研究結果）；它只在 `/workspace/.replica`、不上網不查庫。目前是 prompt 級隔離（同沙盒），非容器級。
- **人工關卡**：④/⑨ 時 run 以 completed 結束、project.status 設 awaiting_plan_approval / awaiting_acceptance；前端用 `POST /api/threads/{id}/approve|reject` 續跑（各自 enqueue 新 run）。
- **注入訊息 marker**：檢索證據＝`[[pa:evidence]]`；流程注記＝`[[pa:note:approved_plan|reject_plan|reject_accept|verify|verify_fail|replicate|review]]`。前端 `Pipeline.tsx` 靠這些 marker 把注入訊息渲染成證據卡／流程分隔標，並推斷每個 assistant turn 屬於哪個階段（tracker 可點擊跳到該階段）。

## 知識庫（`kb.py` / `tools/kb.py`）

- pgvector 存 chunk（`vector(1024)`，HNSW cosine 索引，`init_db` 建 extension＋索引）。embedding/rerank 走 Voyage。
- 三層 `kb_datasets.category`：`task`（綁 thread，上傳自動匯入）、`base`（共用基礎庫，頂部列「基礎庫」modal 管理，所有專案都查得到；**只有 admin 能上傳/刪，其他人唯讀**）、`lab`（實驗室共用庫，綁 `kb_datasets.lab_id`）。`datasets_for_thread(thread_id)` = 該 thread 的 task ＋ 所有 base ＋ **該 thread 擁有者所屬各 lab 的 lab dataset**（從 thread→user→lab_members join）。
- **lab 權限層（實驗室）**：`labs`（name/owner_id/join_code）＋`lab_members`（lab↔user，role owner/member，unique(lab,user)）。lab 由**教職員**建立並擁有、文件成員皆可上傳/刪、成員管理（加人/移除/重置 code）限 owner。成員加入＝join code 自助或 owner 用 email 加。身份判定：**全域 admin** 看 `ADMIN_EMAILS`、**教職員** 看 `FACULTY_EMAILS`（`config.py` `_csv`、`auth.identity_flags`／`require_admin`；`User.is_faculty` 欄位登入/註冊回填，**未來串 nid API 改由它在登入時設 is_faculty**，其餘不動）。API：`/api/labs`（GET 列我的 lab＋can_create）、`POST /api/labs`（faculty）、`/api/labs/join`、`/api/labs/{id}`（成員看詳情＋成員清單，owner 另看 join_code）、`/api/labs/{id}/members`(owner 加)、`DELETE …/members/{uid}`（owner 移除或自己退出）、`…/regenerate-code`、`/api/labs/{id}/kb`(list/upload/delete)。前端頂部列「實驗室庫」→ `LabLibrary.tsx` modal（lab tabs＋文件＋成員＋join code＋建立/加入）。
- 檢索：query→Voyage embed→pgvector cosine→Voyage rerank。工具 `kb_search`（多輪 Agentic RAG）、`kb_read`（讀整篇）。
- 匯入：上傳檔（PDF 用 pypdf、文字檔直接讀）→ chunk → embed → 存。`api.py` 的 thread 上傳會自動匯入 task 層；`/api/kb/base/*` 管理 base 層。

## 部署流程

```bash
cd ~/Agent_proj
# 前端有改先檢查：cd web && npm install && npx tsc -b && npx vite build
cd deploy
docker compose exec -T postgres psql -U plasma -d plasma -At \
  -c "select count(*) from runs where status in ('queued','running')"   # 必須是 0 才重啟，否則中斷使用者的執行
docker compose build -q && docker compose up -d api worker
curl -s http://127.0.0.1:8600/api/health
docker compose logs --tail 50 worker
```

只改 prompt 也要重 build（prompt 打包在 image 裡）。`init_db` 會自動建新表、`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`、`CREATE EXTENSION vector`，並用 `pg_advisory_xact_lock` 避免 api/worker 同時建新表撞車。

## 測試

- 一般對話：`.venv/bin/python deploy/e2e.py "<問題>"`（測試帳號 `e2e-test@plasma.local`；`UPLOADS=a.txt,b.pdf` 附檔）。印出每個工具呼叫、結果、最後回覆。
- 研究專案／知識庫：另寫 httpx 腳本（建 `mode:"project"` thread、送想法、串流 run、`/approve` 續跑；或 `/api/kb/base/upload`）。參考 scratchpad 裡用過的 e2e。
- UI 截圖：`cp deploy/shot.py /tmp/pa-shots/ && docker run --rm --network host -v /tmp/pa-shots:/out --entrypoint bash public.ecr.aws/z1o8z4f9/agent:plasma-1.1.0 -lc "python /out/shot.py <thread_id>"`，輸出 `/tmp/pa-shots/*.png`，再用 Read 看圖。也有自寫的 top.py（捲到頂看 tracker）等。`<thread_id>` 要是測試帳號的對話。
- 已通過：PlasmaPy 參數、SMILEI two-stream、COMSOL 2D 靜電、文獻搜尋、GEC CCP 建網格、完整九階段專案（單擺：研究→驗證(三法重算)→複現→審查→等級通過）、知識庫跨 thread 檢索（base 庫）。

## COMSOL 結果怎麼回來（2026-11-03 已修改 COMSOL 服務，內容仍正確）

- COMSOL REST API 跑在 140.134.138.17（fcu-plasma06，帳號 fcu-plasma，sudo 要密碼）：systemd `comsol-api.service`，root 跑 `/home/fcu-plasma/Comsollic/Comsol-main/comsol-api/main.py`，log `/var/log/comsol-api.log`，說明同目錄 `AGENT_GUIDE.md`（＝本專案 `docs/AGENT_GUIDE.md`）。
- 2026-11-03 改 `main.py`（備份 `main.py.bak-20261103`）：(1) 三處 `comsol batch` 加 `-3drend sw`，否則 Image 匯出不報錯也不產檔；(2) `_snapshot_dir`／`_collect_exported_files` 把工作目錄新產生的檔（不含 .class/.java）收進 `output_files` 與 `/download`。
- agent 用 COMSOL 原生出圖：建 plot group，用 `docs/comsol_examples/plot_data/PlotDataDemo.java` 的 `exportImage`（`plotgroup` 屬性、`./xxx.png` 相對路徑，打開 options/title/legend/axes）。已驗證 Surface、Contour、ArrowSurface、CutLine2D LineGraph。
- 第二次改（`main.py.bak-20261103b`）：有 `.java`/`.class` 時它是主檔、`.mph` 當資料檔，可 `ModelUtil.load("m","xxx_result_Model.mph")` **後處理既有結果不必重算**（範例 `docs/comsol_examples/postprocess/`）。`comsol_submit` 會自動附上 Java 引用的 `.mph`。沙盒的 MPh 1.4.0 沒有本機 COMSOL，開不了 .mph。
- 服務不回 `.java`，要 `model.save("./name.txt","java")` 匯出（範本 `docs/comsol_examples/library/ExportModelJava.java`）。Java 本身不能讀寫檔、不能讀 `System.getProperty`、不能 `getProtectionDomain`；batch 產的 .mph 無縮圖。
- log 數據區塊（`#PA_DATA_BEGIN`…`#PA_DATA_END`，用 dumpGrid2D/dumpLine/dumpTable）保留做數值檢查，平台轉 CSV＋預覽圖＋算 min/max/mean。
- `comsol_job` batch 成功自動 `_collect_results`：下載到 `/workspace/comsol/<job_id>/`，附件序＝COMSOL 圖→數據預覽圖→.mph 預覽圖→.mph/.mph.status/匯出數據→CSV，用 `.collected.json` 防重複。
- 改 COMSOL 服務前先確認 `/api/v1/health` 的 `running_job` null、`queue_size` 0，再 `sudo systemctl restart comsol-api`。這服務整實驗室共用，同機還有 claude2comsol、warpx-comsol-web，不要動它們。

## 前端顯示規則

- **版面**：頂部導覽列（品牌＋對話抽屜＋一般/專案切換＋領域＋＋新研究＋基礎庫＋主題＋登出），沒有常駐左側欄；對話清單是從頂部滑出的 `.drawer`。中間寬閱讀欄（`.messages-inner` 置中 900px），右側輔助面板（步驟/檔案/狀態＋知識庫卡）。字體：Noto Serif TC＋Source Serif 4（標題/報告）、Source Sans 3（內文）、IBM Plex Mono（數據）；助理最終回覆用襯線排版。色票冷紙底＋語意色（AI＝深鋼藍、關卡＝赭黃、驗證＝森綠）。
- **研究專案**：`Pipeline.tsx` 的九階段 tracker **sticky 釘在對話頂端**，節點可 hover 看說明（誰負責/狀態/做什麼）、可點擊跳到該階段內容；關卡顯示核准/退回卡；驗收關卡顯示程式**等級卡**（通過/部分通過/未通過＋n/m 項＋summary）。
- **上傳**：composer「＋ 上傳檔案」或拖曳到對話區（`Chat.tsx` drag & drop）→ `pickFiles`→`api.upload`，同時自動匯入 task 知識庫。
- **長時間工具進度條**：`comsol_job` 等待時每 5 秒抓 log，`_parse_progress` 解析 `Current Progress: N % - <階段>`，publish `tool_progress`（綁 `ctx.tool_use_id`），`Render.tsx` 的 `StepProgress` 顯示階段＋%＋進度條＋已耗時（排隊顯示第 N 位）。
- **步驟**：已完成回覆的步驟群組預設收合；每步一行標題（agent 填的 `step_note`，`tools/base.py` 裝飾器自動注入成每個工具的**必填**參數，放最前配合 eager streaming——設非必填 Sonnet 會跳過），失敗自動展開；「詳情」在右側面板看完整輸入輸出。
- **產生的檔案卡片**（`Render.tsx` `Attachments`）：圖片排前＋預覽下載；主要成果顯示類型/大小/資料夾；中間檔（`.log`/`.status`，`isSecondaryFile`）收進「其餘 N 個 ›」；「全部下載」走 `GET /api/threads/{id}/zip?path=...`。
- **正文**：只有一輪 assistant turn 的**最後一個** text block 當正文，其餘工具呼叫間的 text 收合成「說明」條（`InterimNote`）。prompt 要求 running commentary 放思考區塊，最後一則回覆照固定格式：結論→設定與方法→結果（表格＋驗證方式）→產生的檔案→限制與後續；圖片不要用 Markdown 嵌文字（卡片會顯示）。

## 必須遵守

- **這台是共用機**：只能動 `plasma-agent` compose 專案和 `pa-sbx-*` 容器。不要停/刪/重啟 dify、wrenai、nuclio、carbon-analyzer 等別人的服務，不刪別人的映像/volume。`wrenai-qdrant` 一直重啟是它資料損壞，別去修。
- **重啟 api/worker 前先確認 runs 佇列＝0**（上面部署流程那條 SQL），否則會中斷使用者的執行（這次踩過一次）。
- 根磁碟剩約 100 GB，大型資料放 `/data`。
- 送出會跑超過幾分鐘的 COMSOL 求解前（GEC CCP 完整約 20 分鐘）要**先問使用者**；整條研究專案 pipeline 會讓研究/驗證/複現各送一次求解（≥3 次），要先問。
- 對話紀錄只能附加、不能修改（Claude 思考區塊必須原樣回傳）。
- **思考區塊綁定 system prompt＋工具清單**：改了 prompt/工具舊對話會 400。每次請求帶 beta `thinking-binding-controls-2026-08-01` 加 `thinking.block_binding.prefix_mismatch_behavior:"drop_block"`；失敗就那次拿掉舊思考區塊重試（`agent._without_thinking`，不改 DB）。不要拿掉這機制。
- **Bedrock 的 Claude 不支援 assistant prefill：對話必須以 user message 結尾**。所以 pipeline 在兩個 LLM 階段之間一定要注入一則 user 訊息（檢索證據、核准/退回 note、verify/replicate/review note 都是為此）。加新 LLM 階段時務必比照。
- `sandbox._ensure_sync` 每次刷新 `/workspace/.guides/`，部署後新增的範例舊對話也看得到。
- 工具必須依呼叫順序逐一執行（曾因同時執行讀到舊檔）。
- **git commit 要等使用者開口才做。** commit 前確認 `deploy/.env` 沒被 staged。

## 坑 / 測試學到的事（已處理，別改回去）

- **Bedrock 無 prefill**（見上）；pipeline 階段之間要注入 user 訊息。
- **pypi.org 從這台很慢**（8 秒/次）：改 requirements 的 build 會卡很久，Dockerfile 已加 `ARG PIP_INDEX_URL` 可用鏡像加速（Aliyun 0.77s＜Tsinghua 3.7s）。
- **pgvector 映像**：`postgres:16-alpine`→`pgvector/pgvector:pg16` 同份 PG16 資料相容（換前 pg_dump 備份）。
- **CSS dark 主題有兩個區塊**（`@media` 4 空格縮排的 `:root:not([data-theme=light])` 與 2 空格的 `:root[data-theme=dark]`），改色票兩個都要改，否則某個主題不生效。
- matplotlib 中文字型要 `WenQuanYi Zen Hei` 或 `Noto Sans CJK JP`（.ttc 只認第一個字型，用 TC 找不到）。
- Sonnet 5.5 會把工具呼叫間的說明寫進思考區塊，所以 prompt 規定最後一則要有完整總結。
- COMSOL log 只回錯誤標記，`comsol_job` 把標記後的實際錯誤放進 `error_details`；COMSOL 服務無法直接輸出圖，要匯數據後在沙盒用 matplotlib 畫。
- `comsol_submit` 自動附上 Java 引用的資料檔（如 `Ar_xsecs_reduced.txt`）；Java 裡用純檔名、不帶目錄。
- Box selection 設 `condition=inside`，座標單位和幾何一致；`getReal()` 形狀 `[nExpr][nPoints]`；沒有 `MaxMin` feature。
- 標題模型 max_tokens 不能太小，否則全用在思考上、拿不到文字。

## 待辦

- **#3 容器級複現隔離**（目前 prompt 級；低 CP 值、建議擱著）。
- **#6 COMSOL 實題端到端驗收**（要使用者同意，因 pipeline 會送 ≥3 次求解到共用服務）。
- **nid API 身份驗證串接**（教職員身份目前用 `FACULTY_EMAILS` 橋接，seam 在登入回填 `User.is_faculty`）。
- **通用沙盒映像（進行中）**：`deploy/sandbox-general.Dockerfile`（FROM plasma 映像＋跨領域開源：R、GDAL/GeoPandas、statsmodels/sklearn/OR-Tools/pulp、shapely/trimesh、nltk/文件處理…），build 成 `plasma-agent-sandbox:general-1.0`、改 `SANDBOX_IMAGE` 指向它。沙盒本來就能自己 pip/apt 裝開源套件（root＋對外網路，已實測 statsmodels/apt tree 成功），所以預裝只是加速。**後續可能規劃：以學院/領域群組切映像**——逢甲共 10 學院，但工具需求收斂成 ~3–4 群（科學計算／資料統計最佳化／地理空間CAD／AI-GPU）；只有很重又不重疊的特例（Blender、OpenFOAM、特定模擬）才值得特化映像，且需要 lab→學院的路由資料。先 1 顆通用，特例現裝。
- 之後改用獨立 AWS IAM 使用者、要不要提供 Tavily key（目前 ddgs）。
- **`deploy/.env` 的 `ADMIN_EMAILS`／`FACULTY_EMAILS` 要填真實的管理員／老師 email**（目前是測試帳號 lab-admin/lab-teacher@plasma.local，驗收用）。改 .env 後要重啟 api/worker（先確認 runs 佇列＝0）。
