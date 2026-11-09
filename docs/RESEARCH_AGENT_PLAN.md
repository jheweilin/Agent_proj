# 通用研究 Agent 建置計畫（九角色 pipeline ／ 就地重構）

- 目標主機：NLPServer `140.134.26.142`（沿用現有 `plasma-agent` compose 專案）
- 撰寫日期：2026-11-09
- 狀態：**規劃中，待核准後從 Phase A 開始**
- 設計來源：使用者的架構圖 `ar.jpg`（「AI for Science Agent 流程」）＋ SciencePal 正式環境原始碼實地分析（.132 `fcu-agent-latest` image）

---

## 0. 目標

把現在單一迴圈的 **Plasma Agent demo**，就地重構成一套**通用、但專注做研究**的多角色 agent：

- 底層走 **SciencePal / agentpress 風格的通用引擎**（單迴圈可配不同角色 prompt／工具／模型）。
- 上層實作**架構圖的九階段研究 pipeline**：釐清 → 檢索證據 → 規劃 → **人工核准** → 研究 → 驗證 → 第二實作 → 審查 → 等級與報告 → **人工接受／拒絕**。
- **plasma 物理降級成「領域之一」**；新增通用領域；之後可擴充其他領域。
- 知識庫三層（任務／基礎／實驗室）＋ Agentic RAG，用 **pgvector ＋ Voyage API**。

### 四個已定決策（2026-11-09）

| # | 項目 | 決定 |
|---|---|---|
| 1 | 程式碼落腳處 | **就地重構**：在 `Agent_proj` 內把 `plasma_agent` 抽象成通用引擎，plasma 變領域 profile |
| 2 | 編排嚴格度 | **完整照圖、分期做**：嚴格 FSM、兩個人工關卡、程式化驗證、獨立複現、唯讀審查、程式定等級 |
| 3 | 知識庫／RAG | **pgvector ＋ Voyage API**（embedding + rerank）；先做任務層＋fusion search，基礎／實驗室層分期 |
| 4 | 通用化／沙盒 | **通用沙盒當預設**；plasma／COMSOL 當可選重映像，由分流決定 |

### 不變的原則（沿用現有）

- 直連 **Bedrock**（Sonnet 5.5 主力、Opus 5.5 備援、Haiku 5.5 標題／分類）。
- 本機 **Postgres／Redis／Docker 沙盒**，資料在 `/data/plasma-agent`。
- 共用機：只動 `plasma-agent` 專案與 `pa-sbx-*` 容器。
- 對話紀錄只附加；thinking block 原樣回傳（維持 thinking-binding beta ＋ drop_block）。
- 回覆一律繁體中文。
- **新增對外依賴**：Voyage API（`voyageai.com`）。

---

## 1. 目標架構（分層）

```
web (React)
  現有時間軸 + 新增：九階段 pipeline 視圖、人工核准／接受關卡 UI、
  知識庫管理（上傳/分層）、領域與角色模型選擇
      │ REST + SSE
api (FastAPI)
  現有 + 新增：pipeline run / stage 狀態、approval endpoints、kb endpoints
      │
worker
  engine（通用引擎）＋ orchestrator（九階段 FSM）
  ├─ engine/      串流迴圈、工具註冊、終止/壓縮/重試降級、hooks、模型路由
  ├─ roles/       九角色定義（prompt + 工具白名單 + 模型 + 可否讀 KB）
  ├─ pipeline/    FSM 階段機、研究卡片、程式化驗證器、等級計算
  ├─ domains/     領域 profile（general / plasma / …）
  ├─ kb/          pgvector + Voyage：ingest / retrieve / fusion / agentic RAG
  ├─ tools/       sandbox / web / comsol / subagent / kb / research_state
  └─ sandbox/     通用映像 + 可選 plasma 重映像；子 agent 共享 workspace
      │
postgres (+ pgvector)   redis
      │
對外：Bedrock（LLM）、Voyage（embedding/rerank）、COMSOL REST、arXiv/OpenAlex/Tavily
```

### 1.1 引擎層（`engine/`）＝ 現有 `agent.py` + `tools/base.py` 升級

沿用現有，並從 SciencePal 補上值得搬的機制：
- 串流迴圈、工具依序執行（維持「依序」避免讀到舊檔）、終止條件（complete/ask、重複呼叫偵測、輪數上限）、拒答改備援模型 — **現有已有**。
- 自動上下文摘要壓縮（token 預算觸發）— **新增**（參考 `context_manager.compact_context`）。
- Hooks 生命週期（before_model／after_model／before_tool／after_tool）— **新增**，用來注入：檢索策略、階段守衛、記憶、技能。
- 模型路由：依角色／任務型別選模型 — **新增**（參考 `query_classifier` + `TASK_TYPE_MODEL_MAP`）。

### 1.2 角色層（`roles/`）

每個角色 = `prompt 片段 + 工具白名單 + 預設模型 + 是否可讀知識庫 + 是否唯讀`。對應圖的顏色語意（藍＝AI 角色、灰＝程式、綠＝人）：

| # | 階段 | 執行者 | 類型 | 可讀 KB | 工具範圍 |
|---|---|---|---|---|---|
| 0 | 研究想法 | 使用者 | 輸入 | — | 選領域／沙箱、上傳檔 |
| 1 | 釐清 Clarifier | AI | LLM | 可選（Agentic RAG） | 檢索、問答；輸出明確問題＋預測＋待確認 |
| 2 | 檢索證據 | **程式** | 非 AI | 固定查一次 | fusion search（KB＋網搜＋arXiv/OpenAlex），回傳標來源的段落 |
| 3 | 規劃 Planner | AI | LLM | **只用②的段落**（不直接查 KB） | 產出模擬計畫，參數標來源 |
| 4 | 核准計畫 | **使用者** | 人工關卡 | — | 核准 or 退回修改（繞回①） |
| 5 | 研究 Researcher | AI | LLM＋沙盒 | 可（kb_search/kb_read） | 寫程式、裝套件、跑模擬、畫圖、交件 |
| 6 | 驗證 | **程式** | 非 AI | — | 重跑／單位／守恆／收斂／與已知解比對；沒過退回⑤ |
| 7 | 第二實作 Replicator | AI 子 agent | LLM＋沙盒 | **刻意不讀 KB** | 只看計畫、獨立重做，結果要和⑤對得上 |
| 8 | 審查 Reviewer | AI 子 agent | **唯讀** LLM | 可讀 | 只能提問題、不能改等級；基礎物理原理卡只有這裡用 |
| 9 | 等級與報告 | **程式** | 非 AI | — | 依⑥驗證結果算等級（AI 不能改）；報告數字全來自重跑 → 使用者接受／拒絕 |

模型預設（可每任務覆寫，對應圖底註）：Clarifier／Planner／Reviewer → Opus 5.5；Researcher／Replicator → Sonnet 5.5；分類／標題 → Haiku 5.5。

### 1.3 Pipeline 層（`pipeline/`）＝ 九階段 FSM

- **研究卡片**（擴充自 SciencePal `ResearchProjectHook`）：`current_stage`、各階段 inputs/outputs（檔案 + hash）、acceptance_evidence、reviewer 簽名、核准紀錄。存 Postgres。
- **階段守衛 hook**：`before_tool_use` 只放行當前階段白名單內的工具（例如 Reviewer 階段擋掉寫入工具）。
- **轉換邊**：正向 1→2→…→9；退回邊 4→1（計畫被退回）、6→5（驗證沒過）、9→5（使用者拒絕）。
- **人工關卡**：階段 4、9 暫停 run、發 SSE、等 API 收到核准／退回再續跑。
- **程式化驗證器**（階段 6）：框架 + 領域可插規則（單位、守恆量、收斂、網格無關性、與解析解／已知解比對）。
- **等級計算**（階段 9）：純程式，依驗證通過項目評級；報告模板的數值一律從重跑結果填入。

### 1.4 領域層（`domains/`）

領域 profile = `領域 prompt 片段 + 沙盒映像 + 專用工具 + runtime policy + 驗證規則`。
- `domains/general`：通用科學／資料分析／文獻。
- `domains/plasma`：現有 plasma prompt＋COMSOL＋SMILEI／PlasmaPy，沙盒用 plasma-1.1.0。
- 分流器 `classifier`：預設 general；支援 `@plasma` 明示；之後接 LLM 分類。

### 1.5 知識庫層（`kb/`）

- **向量庫**：Postgres `pgvector`，`chunks.embedding vector(1024)`。
- **Voyage**：embedding `voyage-3.5`（或 `voyage-3-large`，output 1024 維）；rerank `rerank-2.5`。需 `VOYAGE_API_KEY`。
- **三層 category**：`task`（綁 thread/project，只該任務可見）／`base`（共用基礎庫）／`lab`（實驗室付費文獻，需權限、不外流）。
- **Ingest**：上傳 → PDF 解析（本機 `pymupdf`／`marker`，取代 MinerU）→ 切塊 → Voyage embedding → 入 pgvector。
- **Retrieve**：query → Voyage embedding → pgvector cosine 檢索 → Voyage rerank → 回傳段落＋出處。
- **Fusion search**：KB ＋ 現有 `web.py`（Tavily/ddgs、arXiv、OpenAlex）策略模式並行，查詢去重。
- **Agentic RAG**：`kb_search`（多輪、可自己決定再查）、`kb_read`（讀整篇）工具；`retrieval_policy` hook 定優先序（task → base → lab/web）。
- **階段②「檢索證據」**：固定查一次、回傳段落供 Planner 標來源（Planner 本身不直接查）。

---

## 2. 資料表（新增／擴充）

沿用現有 `users / threads / messages / runs`，新增：

```
research_projects      thread_id, current_stage, status, domain, config(JSONB), created_at
stage_records          project_id, stage, inputs(JSONB), outputs(JSONB), hashes(JSONB),
                       acceptance_evidence(JSONB), approval(JSONB), reviewer_signoff(JSONB)
kb_datasets            id, owner, category(task|base|lab), name, scope(thread_id?), doc_count
kb_documents           id, dataset_id, source_uri, file_hash, metadata(JSONB)
kb_chunks              id, document_id, chunk_index, content, embedding vector(1024), metadata
subagent_runs          parent_run_id, role, status, task_id, output_path   (複現/審查用)
```

`runs` 增欄位：`stage`、`awaiting_approval`（人工關卡暫停用）。

---

## 3. 分期計畫

> 每個 Phase 結束都要通過 e2e＋前端截圖驗收；只改 prompt 也要重 build；重啟前先確認 `runs` 無 queued/running。

### Phase A — 引擎通用化 + 領域 profile（地基，行為不變）
- 把 `agent.py`／`tools/base.py` 抽成 `engine/`；plasma 既有能力搬進 `domains/plasma`；新增 `domains/general`。
- 加分流器骨架（預設 general、支援 `@plasma`）與角色/模型配置檔。
- **驗收**：現有 plasma e2e 全數通過（PlasmaPy、SMILEI、COMSOL、文獻搜尋、GEC CCP 建網格），行為不變。

### Phase B — 九階段 pipeline 骨架 + 研究卡片 + 人工關卡
- `pipeline/` FSM、研究卡片、階段守衛 hook、階段工具白名單。
- 角色：Clarifier／Planner／Researcher（先接現有單 agent 能力）。
- 人工關卡 ④計畫核准、⑨接受／拒絕：API + 前端階段視圖與核准 UI。
- 階段②先接 fusion search（無向量庫也能跑）。
- **驗收**：一個題目走完 ①→②→③→④核准→⑤→⑨，前端顯示階段流程與核准/退回。

### Phase C — 知識庫（pgvector + Voyage）+ Agentic RAG
- pgvector schema、ingest（上傳→解析→切塊→Voyage embedding→入庫）、retrieve（+rerank）。
- 三層先做 `task` 層 ＋ `base` 層骨架；`kb_search`／`kb_read` 工具；`retrieval_policy` hook。
- 階段②「檢索證據」改接真 KB；Planner 參數標來源。
- **驗收**：上傳 PDF → 入庫 → 規劃時引用段落並標出處。

### Phase D — 程式化驗證 + 獨立複現 + 唯讀審查 + 程式定等級
- 階段⑥驗證器框架 + plasma/general 驗證規則；退回邊 6→5。
- 階段⑦ Replicator 子 agent（`run_subagent`，不讀 KB、獨立 workspace，比對⑤輸出）。
- 階段⑧ Reviewer 唯讀子 agent（工具白名單只含讀取＋基礎物理原理卡）。
- 階段⑨等級計算（程式）＋報告（數字全來自重跑）；退回邊 9→5。
- **驗收**：完整九階段跑通，含複現比對、唯讀審查、程式評級。

### Phase E — 進階（視需要）
- 技能系統（SKILL.md ＋ judge ＋ 蒸餾）、排程任務、`lab` 層權限、MCP、多領域重映像分流。

---

## 4. 與 SciencePal 的對照（沿用／自建）

| 能力 | SciencePal | 本專案做法 |
|---|---|---|
| agent 引擎 | agentpress（ThreadManager/ResponseProcessor/ToolRegistry/hooks/壓縮） | 升級現有 `agent.py` 為 `engine/`，搬壓縮＋hooks＋模型路由 |
| 分流 | `query_classifier`（規則＋LLM，15 領域） | `classifier`：general 預設、`@plasma` 明示、LLM 分類（Bedrock） |
| 子 agent | `run_subagent`/`check_subagent`（獨立 thread、角色工具集、背景） | 自建對應工具，用於 Replicator／Reviewer |
| 多角色 pipeline | swarm（survey-research 隱含 pipeline，無 FSM） | 自建**嚴格 FSM** ＋研究卡片 ＋階段守衛 |
| 研究卡片 | `ResearchProjectHook`（鬆散狀態） | 擴充成 9 階段 state ＋ 簽名鏈 ＋ 核准紀錄 |
| RAG | RAGFlow＋BGE-M3＋SiliconFlow rerank＋MinerU | pgvector ＋ **Voyage** embedding/rerank ＋ `pymupdf`/`marker` |
| fusion search | Tavily/Elsevier/Firecrawl/KB | 沿用現有 `web.py`（Tavily/ddgs、arXiv、OpenAlex）＋ KB |
| 沙盒 | Daytona（每領域一 image） | 本機 Docker（現有 `sandbox.py`）：通用 image 預設 ＋ plasma 可選 |
| 驗證/等級 | 無程式化驗證 | **自建**：程式化驗證器 ＋ 程式評級（AI 不能改） |

---

## 5. 風險與注意

| 風險 | 對策 |
|---|---|
| 重構動到線上 demo | Phase A 以「行為不變」為驗收；每步跑既有 e2e；重啟前確認 runs 清空 |
| Voyage 對外依賴／費用 | 新增 `VOYAGE_API_KEY`；embedding 可本地快取避免重算；可退回 Bedrock embedding |
| 通用沙盒映像 | 需自建或取現成輕量科學映像；plasma 大映像維持可選，控管磁碟（根碟剩約 100G） |
| 人工關卡的執行暫停 | run 暫停狀態要能跨 worker 重啟恢復；用 `runs.awaiting_approval` ＋ 研究卡片 |
| 子 agent GPU/資源 | Replicator 需獨立沙盒；限制同時沙盒數、只用 GPU0 |
| thinking binding | 改 prompt/工具會使舊對話思考區塊失效 → 維持 drop_block 機制 |

---

## 6. 待與使用者確認（實作前）

- 專案對外名稱／前端標題（目前仍叫 Plasma Agent；通用化後要不要改名）。
- 通用沙盒映像：自建輕量 image，還是先沿用 plasma-1.1.0 當通用預設（Phase A 可先沿用、Phase E 再換）。
- Voyage 的 `VOYAGE_API_KEY` 由誰提供。
- 是否保留現有 plasma demo 可同時使用（分流到 plasma 領域即可，預設保留）。
```
