# 實驗室知識飛輪設計（Lab Knowledge Flywheel）

> 本文記錄「以實驗室為單位積累與分享研究經驗」的設計與決策。技術現狀以 `CLAUDE.md` 為準；本文是**規劃**，引用的 file:line 是目前的掛載點（seam），實作時以當下程式碼為準。
> 決策日期：2026-11-11。討論者：使用者（fcucda）。

## 1. 目標：三個目標是同一個飛輪的三圈

| 目標 | 本質 |
|---|---|
| **加速實驗室研究** | 飛輪轉起來：每個新專案一開始（九階段的②檢索證據）就撈得到過去累積的經驗 |
| **積累實驗室經驗** | 飛輪變重：每做完一個研究專案，實驗室知識就多一層——尤其是**方法與踩坑**，不只是漂亮結論 |
| **跨領域合作** | 飛輪互相帶動：別的實驗室的經驗，在雙方同意下能被你的研究吃到 |

**核心洞察**：「加速」不是獨立功能，而是「積累」這個迴路閉合後的自然結果。pipeline 第②階段「檢索證據」已經會查 thread 庫＋lab 庫＋base＋arXiv/OpenAlex（`pipeline.py`）；只要研究產出會**回寫 lab 庫**，下一個專案就會自動站在過去的肩膀上。回寫迴路＝整個飛輪的傳動軸。

## 2. 現狀（已有 / 缺口）

- ✅ 三層知識庫 `KbDataset.category`：`task`（綁 thread、私人）/ `base`（全站、admin）/ `lab`（綁 lab、成員可見）。`db.py` 的 kb_datasets/kb_documents/kb_chunks。
- ✅ 檢索是**查詢時即時聚合**：`kb.datasets_for_thread(thread_id)` 把「thread 擁有者所屬的每個 lab」的 lab 庫一起納入（`kb.py:146`）。新生只要是 lab 成員，對話自動查得到 lab 庫。
- ✅ lab 管理：建立（faculty）、成員、join code、文件上傳/刪（`api.py` 的 `/api/labs*`、`LabLibrary.tsx`）。
- ❌ **研究產出回寫知識庫：完全沒有**。專案成果只存在 `projects.card`（JSONB）、`messages`、`/workspace`，沒有任何一條路寫回 KB。
- ❌ **審核/納入工作流：沒有**（無待審佇列、無核准動作）。
- ❌ **跨實驗室分享：沒有**（lab 庫對外人完全隱形，`_membership` 連 lab 存在都不洩露）。

## 3. 設計原則

1. **兩維知識模型**：知識同時有「可見範圍 scope」與「知識類型 kind」。
2. **兩道閘門，兩次可見性跳躍**：`專案產出 →(閘門1: owner 核准)→ lab 庫 →(閘門2: 跨域授權)→ 其他 lab`。IP 不會自動漏出 lab。
3. **跨域以被授權方同意為主、不設公共池**：只公開「專長名錄」當櫥窗；內容要 A 實驗室點頭、且 A 決定給多少，才會被 B 檢索到。
4. **以研究專案為納入單位**：顆粒度剛好；不做「每則聊天都能提名」（雜訊太大、審核負擔重）。一般對話（chat mode）的納入留待第二階段。
5. **審核同時守 IP 與守訊號品質**：寧可少而精，避免垃圾累積拖垮檢索。

## 4. 知識模型（兩維）

### scope（可見範圍，由窄到寬）
```
private(task) → lab → (跨域授權後) 其他 lab → base(校級, admin)
```
> 注意：跨域**不是**新增一個「commons 公共池」層，而是透過**點對點授權**讓某 lab 的（部分）dataset 對另一 lab 可見。

### kind（知識類型）
| 類型 | 內容 | 來源 | 原則 |
|---|---|---|---|
| **reference** 參考/IP | 論文、資料、智財 | 老師手動上傳 | 多半留在 lab，少外流 |
| **experience** 經驗/方法 | 研究摘要、方法、踩坑、負面結果 | **平台產出自動生成** | 可（去敏後）跨域分享 |

這個區分決定了跨域能分享什麼：**跨域分享的主要是 experience，reference 原則上不出 lab。**

## 5. 回寫迴路（閘門 1）

### 流程
```
研究專案被接受（pipeline approve, 目前 pipeline.py:366 awaiting_acceptance → completed）
   ↓
LLM 產生「存法二」結構化經驗文件（見 §6）
   ↓
提名進 lab 待審（成員發起）；owner / 老師自己的專案可直接納入
   ↓
owner 在待審佇列核准 → ingest 進該 lab 的 experience dataset
   ↓
下一個專案的②檢索證據自動撈得到
```

### 誰能提名（定案）
- **任何 lab 成員都能提名**（含提名別人的專案）；最終一律要 **owner 核准**才真的入庫。待審佇列因此可能較雜，審核 UI 要能快速略過/批次處理。

## 6. 「存法二」納入內容（決策：純法二）

納入知識庫的**不是**原始對話，而是由 LLM 整理成的一篇**結構化 Markdown 經驗文件**，刻意保留方法與踩坑：

```
# <研究題目>
- 研究問題：
- 方法與設定：用了哪些工具 / 關鍵參數 / 邊界條件
- 過程與踩坑：中間哪裡卡住、為何退回重做、最後怎麼解的（保留負面結果）
- 關鍵結果：
- 結論：
- 限制與後續：
- 來源：→ 回原研究專案 thread 的連結（想深入的人點回去看完整過程）
```

**理由**：論文只記成功的乾淨結果；實驗室真正的隱性知識是「這條路走不通、這個參數會發散、學長試過失敗了」。九階段 pipeline 本來就會記錄驗證失敗、退回重做、複現不一致（`projects.card` 的 verification/review/verify_retries），這些正是「讓新生少走彎路」的精華。原始對話全塞（存法三）雜訊太多、chunk 後檢索品質差，不採用。

## 7. 跨域合作（閘門 2）：專長名錄 + 申請授權

### 流程
```
① 公開「實驗室專長名錄」   每 lab 一張公開簡介：名稱、領域、專長關鍵字、代表主題（只有專長、無內容）
② 申請                     B 實驗室在名錄看到 A 的專長 → 送申請（附「我想了解什麼」）
③ A 實驗室決定             A 的老師：拒絕 / 授權；可選顆粒度：
                             • 整個實驗室庫
                             • 只授權某幾篇文件 / 某個主題標籤
                           唯讀、可設期限、隨時收回
```

### 要點
- **沒有東西預先外流**：名錄只是櫥窗，內容要 A 點頭且 A 決定給多少才被 B 檢索到。
- **不複製資料**：授權只讓 `datasets_for_thread()` 多撈一條「我所屬 lab 被授權的那些（部分）dataset」。
- **檢索到跨域知識時標註來源 lab**（溯源＋致謝）。

### 定案
- **「部分授權」顆粒度**：第一版（L3）就做到**整庫 / 指定文件 / 指定主題標籤**三種。→ 文件需能貼標籤/分群，列為 L3 前置（見 §8、§12）。
- **專長名錄簡介**：LLM 讀 lab 庫自動生成草稿 → 老師潤飾（`is_public` 由老師決定）。

## 8. 資料模型變更（規劃）

### `KbDocument` 加欄位（最小改動）
- `origin`：`upload | research | chat`（分辨手動上傳論文 vs 平台產出）
- `status`：`pending | approved | rejected`（審核狀態）
- `kind`：`reference | experience`
- `source_thread_id`：回連原專案（nullable）
- `submitted_by`：提名人（nullable）

### 檢索過濾
- `kb` 檢索 SQL 加 `status = 'approved'`：待審 chunk 檢索不到，核准才生效。

### 新表
- `kb_grants`：`grantor_lab_id`、`grantee_lab_id`、`scope`（`full | documents | tag`）、`scope_ref`（文件 id 清單 / 標籤）、`status`（`requested | granted | rejected | revoked`）、`expires_at`、`requested_by`、`note`。
- `lab_profiles`（或直接掛在 `labs` 上）：`specialties`、`keywords`、`summary`、`is_public`。
- 文件標籤（主題授權用，L3 前置）：`kb_document_tags` 或 `KbDocument.tags`。

## 9. API 變更（規劃）
- 回寫/審核：`POST /api/threads/{tid}/nominate`（提名）、`GET /api/labs/{id}/kb/pending`（待審佇列）、`POST /api/labs/{id}/kb/pending/{doc}/approve|reject`。
- 名錄：`GET /api/labs/directory`（公開專長名錄）、`PUT /api/labs/{id}/profile`。
- 授權：`POST /api/labs/{id}/grants/request`、`GET /api/labs/{id}/grants`（收到/送出）、`POST /api/grants/{gid}/approve|reject|revoke`。
- `kb.datasets_for_thread` 擴充：加入「被授權的（部分）dataset」。

## 10. 前端變更（規劃）
- `LabLibrary.tsx`：新增「待審佇列」區（owner）、文件標 origin/kind、授權管理（收到的申請、已送出的申請）。
- 新「實驗室名錄」入口（瀏覽專長、送申請）。
- 研究專案完成後：Pipeline 的驗收卡加「提名納入實驗室庫」按鈕。

## 11. 治理與品質
- **品質衰減**：審核守訊號品質，寧少而精；納入時可讓 LLM 評分、owner 看摘要再點。
- **知識過期**：experience 文件帶**時間戳＋來源專案連結**；檢索對舊知識可降權；老師可封存。
- **去敏**：跨域授權時可讓 LLM 跑一次去敏檢查，標出可能含資料/IP 的段落請老師確認。
- **成員離開**：成員離開後其已納入的研究經驗**保留在 lab 庫**（屬於實驗室），不因人走而流失。（定案）

## 12. 分期實作建議
1. **Phase L1 — 回寫迴路（閘門 1）**〔✅ 已實作、已部署 2026-11-11〕：`KbDocument` 加 origin/kind/status/source_thread_id/submitted_by/tags＋`init_db` 遷移；`kb.search`/`read_document` 加 `status='approved'` 過濾；`POST /api/threads/{id}/nominate`（任何成員提名自己已完成的專案）→ 丟 `pa:nominate` 佇列 → **worker**（有 Bedrock 憑證）用一次性 LLM 生「存法二」筆記（方法＋踩坑＋回連原專案）→ `kb.ingest` 存成 research/experience/pending；owner 專屬 `GET …/kb/pending`＋`POST …/kb/pending/{doc}/{approve|reject}`；前端 `NominateCard`（完成專案上）＋`LabLibrary` 待審佇列＋來源標籤。附帶：`_voyage` 加 429 退避重試。**已過 e2e**（權限、狀態過濾、提名→審核→可檢索全綠）。限制：只能提名「自己擁有」的 thread（跨使用者提名別人的專案需共享可見性，待後續）。
2. **Phase L2 — 專長名錄**〔✅ 已實作、已部署 2026-11-11〕：`labs` 加 summary/keywords/is_public/profile_draft/profile_status＋遷移；`GET /api/labs/directory`（公開名片，宣告在 `/{lab_id}` 之前避免被當 id）、`PUT …/profile`（owner 編輯＋ is_public toggle）、`POST …/profile/draft`（丟 `pa:labprofile` 佇列→**worker** 用 LLM 讀 lab 庫產 {summary,keywords} 草稿存進 profile_draft）；`labs.py` 放 lab 領域邏輯；前端頂部列「名錄」→`LabDirectory.tsx`（搜尋＋名片卡），`LabLibrary` owner「專長名片」編輯器（公開 toggle、摘要、關鍵字、AI 生成草稿＋採用）。**已過 e2e**（名錄公開過濾、權限、worker 草稿；UI light＋dark 已截圖）。
3. **Phase L3 — 申請授權（閘門 2）**〔✅ 已實作、已部署 2026-11-11〕：`kb_grants` 表（grantor/grantee lab、status requested/granted/rejected/revoked、scope full/documents/tags、scope_ref、note、unique(pair)）；`POST /api/labs/{id}/grants/request`（grantee owner 申請）、`GET …/grants`（owner 看 incoming/outgoing）、`POST /api/grants/{gid}/{approve|reject|revoke}`（grantor owner，approve 帶 scope+scope_ref）；文件標籤 `PUT …/kb/documents/{doc}/tags`。檢索核心：`kb.visible_scope(thread)` 回 `{datasets, doc_ids, tag_filters}`，`search`/`read_document` 改吃 scope（相容舊 list），3 處呼叫點改用 visible_scope；**整庫/指定文件/指定主題標籤三種顆粒度都在檢索層生效**。前端：名錄「申請合作」表、LabLibrary「跨實驗室授權」區（incoming 核准面板含 scope 選擇＋文件勾選、outgoing 狀態）、文件列標籤編輯。**已過 e2e**（三種範圍的 scope 可見性 + 權限 + 申請/核准/收回；UI light＋dark 已截圖）。
4. **Phase L4 — chat mode 納入 / 去敏檢查 / 品質治理**：一般對話整理成經驗文件提名；跨域授權前 LLM 去敏檢查；舊知識降權/封存。

## 12.5 已知問題
- **lab 刪除不會 cascade 清 lab dataset**：`kb_datasets.lab_id` 是用 `ALTER TABLE ADD COLUMN ... UUID` 加的，**沒有 FK 約束**（SQLAlchemy 模型宣告了 ForeignKey，但 create_all 不會改既有表）。目前沒有「刪除 lab」的 API，production 觸發不到；未來若加 lab 刪除，要一併刪 lab dataset/文件/chunk（或補上 FK）。

## 13. 已定案決策（2026-11-11）
- **提名權限**：任何 lab 成員都能提名（含別人的專案），一律 owner 核准才入庫。
- **成員離開歸屬**：已納入知識保留在 lab 庫，屬於實驗室。
- **部分授權顆粒度**：L3 第一版即做 整庫 / 指定文件 / 指定主題標籤 三種（文件標籤為前置）。
- **名錄簡介**：LLM 生草稿 + 老師潤飾，老師決定是否公開。
