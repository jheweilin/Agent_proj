# 獨立 Plasma Agent 建置計畫（NLPServer）

- 目標主機：NLPServer `140.134.26.142`（使用者 `jhewlin`）
- 專案目錄：`~/Agent_proj`（程式碼與設定）、`/data/plasma-agent`（資料、工作區、資料庫）
- 撰寫日期：2026-11-03
- 狀態：**規劃中，尚未開始實作**

---

## 1. 目標

參考現有 SciencePal（fcu.sciencepal.ai）的 Plasma Agent，在 NLPServer 上建立一套**完全獨立**的系統，包含網頁前端、後端與 agent 功能：

- 不依賴 SciencePal 的任何主機或服務（.131、.132、Supabase、Daytona、S3、LiteLLM）
- 對外只連兩個地方：**AWS Bedrock**（LLM）和 **COMSOL REST API**（`140.134.138.17:2035`）
- 前端做精簡版（拿不到 SciencePal 的前端原始碼）
- 先用 `IP:埠號` 存取，暫時不綁網域

### 已決定事項

| # | 項目 | 決定 |
|---|---|---|
| 1 | 前端 | SciencePal 前端原始碼拿不到，**重新設計精簡版** |
| 2 | LLM | **直連 Bedrock**，不經過 LiteLLM |
| 3 | 存取方式 | **IP 加埠號**，暫時不用網域 |
| 4 | COMSOL | 接 `AGENT_GUIDE.md` 描述的 REST API |
| 5 | 隔離程度 | 和現有 SciencePal **完全切開** |

---

## 2. 現況盤點（2026-11-03 實測）

### 2.1 NLPServer 硬體與環境

| 項目 | 狀況 | 影響 |
|---|---|---|
| 作業系統／架構 | Ubuntu 24.04，x86_64 | SciencePal 的映像檔可以直接使用 |
| CPU／記憶體 | i5-14500 20 核心，記憶體 31 GB（可用約 27 GB） | 夠用，但要和其他服務共用 |
| GPU | 2 × RTX 4070 Ti SUPER 16 GB；GPU0 閒置，GPU1 已被佔用約 7 GB | 沙盒**只用 GPU0** |
| Docker | 29.7，nvidia runtime 與 CDI 都已設定（`nvidia.com/gpu=0/1/all`） | 可以直接把 GPU 給容器 |
| 磁碟 | 根磁碟 915 GB，已用 90%，**只剩約 90 GB**（Docker 也在根磁碟）；`/data` 剩 3.4 TB | 大型資料一律放 `/data`；映像檔空間吃緊（見 §8） |
| 共用機 | 已經在跑 dify、wrenai、nuclio、carbon-analyzer、mongodb 等 | **不能動既有容器、映像檔、volume**，埠號要避開 |
| 已佔用的埠 | 21、22、53、631、3000、3306、5003、8003、8070、8500、8890、11435、20002、20241、27017、33060 等 | 正式選埠號前要再檢查一次 |

### 2.2 外部依賴

| 依賴 | 實測結果 |
|---|---|
| COMSOL REST API `http://140.134.138.17:2035/api/v1` | ✅ `healthy`，COMSOL 6.4.0.293，沒有排隊中的工作 |
| AWS Bedrock | ✅ 這台的 `~/.aws` 已有憑證（IAM 使用者 `sciencepal`，region `ap-southeast-1`）。可用 `global.anthropic.claude-sonnet-5-5`、`global.anthropic.claude-opus-5-5`、`global.anthropic.claude-haiku-5-5` |
| Plasma 沙盒映像檔 `public.ecr.aws/z1o8z4f9/agent:plasma-1.1.0` | ✅ 公開 ECR 拉得到；74 層，壓縮後 16.1 GB，解開後約 50 GB |
| 機器上的舊映像檔 | `public.ecr.aws/z1o8z4f9:plasma-1.0.7`（53 GB，2025-12-30）；啟動方式是 `/opt/nvidia/nvidia_entrypoint.sh /usr/local/bin/start.sh`，工作目錄 `/workspace` |

---

## 3. 參考對象：SciencePal 的 Plasma Agent 怎麼運作

（從 .132 上 backend 容器的原始碼整理）

1. **處理流程**：前端 → `POST /api/thread/{id}/agent/start` → 工作丟進 Redis 佇列（dramatiq） → worker 執行 `run_agent()` → 輸出逐段寫入 Redis list → 前端透過 SSE 收到。
2. **Agent 迴圈**：最多 100 輪「呼叫 LLM → 執行工具 → 再呼叫 LLM」，每輪內最多自動接續 25 次；agent 呼叫 `ask` 或 `complete` 時結束；偵測到重複的工具呼叫就停止；模型拒答時改用備援模型。
3. **上下文管理**：太長時把中段對話壓縮成摘要（`compact_context`）。
4. **Hooks**：在呼叫模型前後、工具執行前後注入記憶、技能和提醒。
5. **沙盒**：每個對話一個 Daytona 沙盒，Plasma 使用專屬映像檔 `plasma-1.1.0`（BOUT++、Hermes-3、SMILEI、PlasmaPy、Gmsh、PETSc、MPI 等）。
6. **工具**：shell、檔案、瀏覽器、搜尋、看圖、背景長時間計算（`submit_job` / `submit_checkpointed_batch`）、子 agent、記憶、技能、`ask` / `complete`。
7. **System prompt**：Plasma 目前用的是程式碼裡寫死的 `agent/plasma_prompt.py`（約 4.2 萬字元）。資料庫和 COS 裡都沒有覆寫版本。

### 3.1 要沿用的部分

- agent 迴圈的結構：串流、工具呼叫、終止條件、重試和備援模型、上下文壓縮
- 沙盒映像檔 `plasma-1.1.0`，整套電漿軟體不用重新建置
- 長時間計算的規範：先跑小案例、設檢查點、可續跑、實測結果和推估要分開寫
- Plasma prompt 裡的物理規範：單位、PIC/CFL 檢查、收斂驗證、EEDF 要有截面資料出處

### 3.2 要捨棄或改寫的部分

| SciencePal 原有 | 新系統 |
|---|---|
| Supabase（雲端） | 本機 Postgres |
| Daytona 沙盒平台 | worker 直接用 Docker 管理容器 |
| AWS S3 / COS | 本機 `/data/plasma-agent` |
| LiteLLM 代理 | Anthropic SDK 直連 Bedrock |
| 15 種 agent 和自動分流 | 只有 Plasma 一種 |
| 技能演化、子 agent、MCP、記憶等進階功能 | 第一版先不做 |
| Prompt 寫著「COMSOL 不可用」 | **COMSOL 可用**，透過 REST API |

### 3.3 原 Plasma prompt 要修正的地方

- 前段寫 COMSOL 和 EEDF 求解器可以用，後段又說不能用 → 統一改成實際狀況
- 有不少從 Materials Agent 繼承來的內容（FireWorks、Atomate、PyMatGen、MongoDB 高通量流程）→ 確認不需要就刪掉
- 「直接查 ITER/JET/DIII-D 資料庫」→ 實際上沒有這些資料庫的存取權限，刪掉
- 中文字型的說明重複了 4 次 → 合併成 1 次
- 「一律先釐清」和「只有缺資訊才發問」互相衝突 → 改成只有缺資訊才發問
- 章節編號重複（有兩個 `# 7.`）

---

## 4. 方案選擇

| | A. 搬 SciencePal 原始碼 | **B. 參考設計重寫精簡版（建議）** |
|---|---|---|
| 規模 | `api.py` 7300 行、199 個 migration、相依套件很多 | 幾千行，每一段都看得懂 |
| 依賴 | Supabase、Daytona、S3、COS、Tavily 等都要自己架 | Postgres、Redis、本機 Docker |
| 前端 | 原本的前端 API 很複雜，精簡版前端很難對接 | 前後端一起設計，API 簡單 |
| COMSOL | 要改進它的程式碼 | 直接做成原生工具 |
| 隔離和維護 | 跟正式版綁在一起，日後很難同步或修改 | 完全獨立，可以自由改 |

**建議採用 B。**

---

## 5. 系統架構

```
NLPServer 140.134.26.142
~/Agent_proj（程式碼與設定）   /data/plasma-agent（資料、工作區、資料庫）
┌───────────────────────────────────────────────────────────────┐
│ web（React 精簡版）  ←  http://140.134.26.142:<埠號>          │
│   登入｜對話列表｜對話（串流顯示思考與工具）｜檔案與圖片      │
│        │ REST + SSE                                           │
│ api（FastAPI）── postgres（帳號／對話／訊息／執行紀錄）       │
│        │       └ redis（工作佇列、串流）                      │
│ worker（agent 迴圈）                                          │
│   ├ Claude Sonnet 5.5 on Bedrock（Anthropic SDK 直連）        │
│   └ 工具 ─┬─ sandbox：每個對話一個 plasma-1.1.0 容器（GPU0）  │
│           │    shell／檔案／看圖／背景長時間計算              │
│           ├─ comsol：health/compile/batch/status/log/download │
│           │          ──→ 140.134.138.17:2035                  │
│           └─ ask／complete                                    │
└───────────────────────────────────────────────────────────────┘
   對外只連 Bedrock（LLM）和 COMSOL API
```

### 5.1 元件

| 元件 | 技術 | 說明 |
|---|---|---|
| web | React（Vite 編譯成靜態檔，由 api 或 nginx 提供） | 登入、對話列表、對話頁、檔案和圖片 |
| api | Python FastAPI | 登入（帳號密碼＋JWT）、對話與訊息 CRUD、開始和停止執行、SSE 串流、下載檔案 |
| worker | Python（agent 迴圈） | 從 Redis 取出工作，執行 agent，結果寫回 Postgres 和 Redis |
| postgres | 官方映像檔 | 資料放在 `/data/plasma-agent/postgres` |
| redis | 官方映像檔 | 工作佇列和串流用的暫存 |
| sandbox | `plasma-1.1.0` 容器（動態建立） | 每個對話一個容器；工作區掛 `/data/plasma-agent/workspaces/<對話 id>`；GPU 用 CDI 只給 `nvidia.com/gpu=0`；閒置一段時間後自動停止 |

### 5.2 Agent 工具（第一版）

| 工具 | 功能 |
|---|---|
| `execute_command` | 在沙盒裡執行 shell 指令（有逾時限制、輸出過長會截斷） |
| `read_file` / `write_file` / `list_files` | 讀寫沙盒工作區的檔案 |
| `see_image` | 讀取工作區裡的圖片，交給模型看 |
| `submit_job` / `job_status` | 長時間計算放到背景執行，完成時用檔案存在與否或 log 標記判定 |
| `comsol_health` / `comsol_compile` / `comsol_batch` / `comsol_job` / `comsol_log` / `comsol_download` | 包裝 COMSOL REST API |
| `ask` | 向使用者提問並暫停 |
| `complete` | 交付結果並結束 |

COMSOL 工具要內建 `AGENT_GUIDE.md` 提到的檢查：

- `success:true` 不代表算對，一律讀 log，找 `Error`、`Exception`、`NaN`
- Java 程式要把關鍵結果印成 `RESULT_xxx=` 再拿來核對
- 邊界用 Box selection 選，不要用邊界編號
- `main` 要宣告 `throws java.io.IOException`
- COMSOL 一次只能跑一個工作，送出前先看排隊狀況
- Plasma Module 的授權還沒驗證過，要先用小模型測試

---

## 6. 分階段計畫

### 階段 0：準備
- [ ] 設定 SSH key 免密碼登入
- [ ] `~/Agent_proj` 建立目錄結構並用 git 管理：`api/`、`worker/`、`web/`、`deploy/`、`prompts/`
- [ ] 建立 `/data/plasma-agent/{postgres,redis,workspaces,logs}`
- [ ] 選定不會衝突的埠號
- [ ] 處理磁碟空間（見 §8 問題 2）

### 階段 1：沙盒
- [ ] 拉取 `plasma-1.1.0`
- [ ] 沙盒管理程式：建立、執行指令、讀寫檔案、閒置停止、刪除；確認容器啟動方式（`nvidia_entrypoint.sh` / `start.sh`）
- [ ] 驗收：在容器裡能跑 `nvidia-smi`（只看得到 GPU0）、PlasmaPy 計算、小型 SMILEI 案例

### 階段 2：Agent 核心
- [ ] Agent 迴圈：Bedrock 串流、tool use、上下文壓縮、重試和備援模型、輪數上限、可中途停止
- [ ] 工具：sandbox 和 COMSOL（§5.2）
- [ ] System prompt：依 §3.3 整理原 plasma prompt，加入 COMSOL 工作流程
- [ ] 驗收：用指令列跑完整任務（PlasmaPy 參數計算＋小型 COMSOL 模型，從 compile 到 batch 到讀取結果）

### 階段 3：API 與資料
- [ ] 資料表：`users`、`threads`、`messages`、`runs`
- [ ] 功能：登入（JWT）、建立和列出對話、送出訊息、SSE 串流、停止、下載檔案
- [ ] 驗收：用 curl 走完整流程

### 階段 4：精簡版前端
- [ ] 登入頁
- [ ] 對話列表（新增、刪除、改名）
- [ ] 對話頁：Markdown 和數學公式、工具呼叫可以展開、圖片直接顯示、停止按鈕
- [ ] 工作區檔案列表和下載

### 階段 5：部署
- [ ] 用 docker compose 管理（`restart: unless-stopped`），compose 專案名稱另外取，避免和 dify 等撞名
- [ ] 綁定 `140.134.26.142:<埠號>`
- [ ] 只操作自己的容器

### 階段 6：驗收
- [ ] 案例 1：純計算（PlasmaPy 參數計算）
- [ ] 案例 2：沙盒模擬（SMILEI，用 GPU0）
- [ ] 案例 3：COMSOL 全流程（compile → batch → 讀 log 核對 → 下載結果）
- [ ] 確認 dify 等既有服務、GPU1、磁碟空間都沒受影響

---

## 7. 風險

| 風險 | 說明 | 對策 |
|---|---|---|
| 根磁碟空間 | 只剩約 90 GB，新映像檔約 50 GB | 刪除舊的 `plasma-1.0.7`，或把 Docker 根目錄搬到 `/data`（要 sudo，會影響其他服務，需管理者同意） |
| 共用資源 | 記憶體和 GPU 要跟其他服務共用 | 沙盒設 CPU 和記憶體上限，只用 GPU0，限制同時存在的沙盒數量 |
| COMSOL 一次只跑一個工作 | 多人同時使用時要排隊 | 工具先查 `queue_size`，並告知使用者大約要等多久 |
| COMSOL API 沒有認證 | 任何人都能送工作 | 只在內網使用；`owner` 欄位填使用者識別 |
| AWS 費用混在一起 | 憑證是正式環境同一個 IAM 使用者 `sciencepal` | 之後改用獨立的 IAM 使用者，或至少加上用量標記 |
| 沙盒權限 | 原本的映像檔預設有 sudo | 容器不開 privileged，只掛自己的工作區目錄 |

---

## 8. 決定紀錄（2026-11-03）

| # | 事項 | 決定 |
|---|---|---|
| 1 | 方案 | **採用 B**（參考設計重寫精簡版） |
| 2 | 磁碟空間 | 舊的 `plasma-1.0.7` 是使用者自己拉的，**已刪除**；根磁碟可用空間從 90 GB 增加到 140 GB |
| 3 | AWS 帳號 | **先共用** IAM 使用者 `sciencepal`，以後再分開 |
| 4 | 網路搜尋 | **要做**：網頁搜尋加上學術文獻搜尋 |
| 5 | 帳號管理 | **開放自行註冊** |
| 6 | 埠號 | **8600**（檢查過沒有被佔用）→ `http://140.134.26.142:8600` |

## 9. 進度

- [x] 階段 0：建立目錄、`git init`、拉取 `plasma-1.1.0`（30.5 GB）
- [ ] 階段 0：SSH key（目前用密碼登入）
- [x] 階段 1：沙盒（每個對話一個容器，只用 GPU0，閒置自動停止；PlasmaPy、SMILEI、happi、Gmsh、Hermes-3、torch CUDA 都驗證可用）
- [x] 階段 2：agent 核心（Bedrock Sonnet 5.5 串流、工具依序執行、拒答時改用 Opus 5.5、對話紀錄只附加不修改、prompt 快取）
- [x] 階段 3：API（註冊／登入、對話、SSE 串流、停止、上傳／下載）
- [x] 階段 4：精簡版前端（React，介面繁體中文）
- [x] 階段 5：部署 `http://140.134.26.142:8600`（docker compose 專案 `plasma-agent`）
- [x] 階段 6：端到端驗收：PlasmaPy、SMILEI（MPI 加背景 job）、COMSOL 靜電模型、文獻搜尋、GEC CCP 快速驗證（只建到網格、不求解），全部通過
- [x] COMSOL Plasma Module 授權已驗證；官方範例 argon_gec_ccp 整理成 `docs/comsol_examples/`，沙盒裡在 `/workspace/.guides/comsol_examples/`
- [x] comsol_submit 會自動附上 Java 程式碼引用的資料檔（例如 .txt 截面）；comsol_job 會回報 log 裡實際的錯誤內容

### 程式碼結構（實際）

```
~/Agent_proj/
├── Dockerfile                  # node 編譯前端 + python app（api 與 worker 共用）
├── deploy/docker-compose.yml   # postgres、redis、api(:8600)、worker
├── deploy/.env                 # 密鑰（不進 git）
├── deploy/e2e.py               # 端到端測試腳本
├── backend/plasma_agent/       # config、db、events、sandbox、agent、worker、api、auth、tools/
├── prompts/plasma_system.md
├── docs/                       # 本計畫、AGENT_GUIDE.md、comsol_examples/
└── web/                        # React 前端
```
