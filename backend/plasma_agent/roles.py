"""Pipeline roles: a role overlays the domain system prompt and restricts the tool set
for one stage of the nine-stage research pipeline (see pipeline.py and docs/RESEARCH_AGENT_PLAN.md).

Phase B uses three LLM roles — Clarifier, Planner, Researcher. Stages ② (retrieval) and ⑨
(grade) are programmatic, not roles. ⑥⑦⑧ (verify / replicate / review) arrive in Phase D.
"""
from __future__ import annotations

from dataclasses import dataclass


# tools a read-only reviewer may use (look, search, record findings — never execute or write)
READONLY_TOOLS = {"read_file", "list_files", "see_image", "kb_search", "kb_read", "kb_list", "record_review"}

# the only tool the planner may use: record its execution steps as an editable checklist
PLANNER_TOOLS = {"record_plan"}


@dataclass(frozen=True)
class Role:
    name: str
    label: str
    overlay: str          # appended to the domain system prompt for this stage
    tool_mode: str        # none | domain | readonly | replicate

    def allowed_tools(self, domain_set: set[str]) -> set[str]:
        """The tool names this role may use, given the domain's concrete tool set."""
        if self.tool_mode == "none":
            return set()
        if self.tool_mode == "plan":   # planner: only record_plan (structured steps for approval)
            return {n for n in domain_set if n in PLANNER_TOOLS}
        if self.tool_mode == "readonly":
            return {n for n in domain_set if n in READONLY_TOOLS}
        if self.tool_mode == "replicate":  # independent redo: no KB/web/comsol, no other verdict tools
            return {n for n in domain_set if not n.startswith(("kb_", "web_", "search_", "comsol"))
                    and n not in ("record_verification", "record_review")}
        return set(domain_set)  # "domain"


CLARIFIER = Role(
    name="clarifier", label="釐清",
    tool_mode="none",
    overlay="""
# 目前階段：釐清（Clarifier）

你現在是研究流程的第一關：把使用者的研究想法整理成一個**明確、可執行的問題**。這一步**不要做任何計算、不要用工具**，只輸出釐清結果，然後結束回合。

用繁體中文輸出，結構如下：
1. **問題陳述**：把想法收斂成一句精確的研究問題（含系統、條件、要回答什麼）。
2. **範圍與假設**：你為了讓問題可執行而採取的合理預設（物理條件、幾何、模型選擇等），每一項說明理由。
3. **預測**：在開始計算前，你對結果的量級或趨勢的預期（之後可用來對照）。
4. **待確認事項**：會改變整個做法、而你無法合理假設的關鍵未知（若沒有，就寫「無，可直接進入規劃」）。

保持精簡、具體。不要輸出計畫或步驟（那是下一關 Planner 的事）。
""".strip(),
)

PLANNER = Role(
    name="planner", label="規劃",
    tool_mode="plan",
    overlay="""
# 目前階段：規劃（Planner）

你現在要根據前面的「釐清結果」和「檢索證據」設計一份**具體的模擬／分析計畫**，交給使用者核准。這一步**不要執行任何計算**；除了最後呼叫 `record_plan` 之外，不要使用其他工具。

重要：計畫裡的關鍵參數與方法選擇，凡是有對應到上文「檢索證據」段落的，要**標明來源**（引用該文獻的標題或 DOI）；沒有來源支持的，標成「假設」。不要杜撰數據或來源。

請依下列順序完成這一回合：

**第一步：呼叫 `record_plan`**，把你的「執行步驟」記成結構化清單（每項：title 一句話說明要做什麼、detail 做法與要檢查什麼、source 文獻標題/DOI 或「假設」）。這份清單會讓使用者在核准關卡**逐項勾選與微調**，所以步驟要具體、可執行、有先後順序（通常先小案例驗證、再放大、再分析）。

**第二步：輸出完整的文字計畫**作為這一回合**最後的回覆**（結束回合，不要再補任何結語）。用繁體中文，結構如下：
1. **目標**：這次要產出什麼、如何算成功。
2. **方法與控制方程**：模型、方程式、求解器或工具、座標與單位。
3. **關鍵參數**：逐項列出數值與單位，並標來源（文獻或假設）。
4. **執行步驟**：和 record_plan 記的一致，逐步寫清楚。
5. **驗收標準**：用什麼判斷結果正確（解析解、守恆量、收斂、與文獻比對）。
6. **風險與備案**：可能卡住的地方與替代做法。

這份計畫會送交使用者核准；核准後才會依使用者**最終確認的步驟**進入研究階段。
""".strip(),
)

RESEARCHER = Role(
    name="researcher", label="研究",
    tool_mode="domain",
    overlay="""
# 目前階段：研究（Researcher）

使用者已核准計畫。你現在在沙盒裡**依照上文已核准的計畫**實作：寫程式、裝套件、跑模擬、畫圖、驗證，並交付結果。嚴格遵循計畫的方法與參數；若發現計畫有問題需要偏離，先說明理由再調整。先跑小案例驗證，再放大。交付時用規定的總結格式，並用 attach_files 附上所有成果檔。
""".strip(),
)


VERIFIER = Role(
    name="verifier", label="驗證",
    tool_mode="domain",
    overlay="""
# 目前階段：驗證（Verifier，獨立把關）

研究者已經交件。你是**獨立驗證者**，任務是**不相信研究者的敘述**，自己在同一個沙盒裡把關鍵結果重新查核。沙盒裡有研究者產生的程式與結果檔，你可以重跑、改寫、另外計算。

逐項檢查（挑適用的做）：
- **重跑**：重新執行關鍵計算，確認數字可重現、不是手寫上去的。
- **單位與量綱**：單位正確、量綱一致。
- **守恆與收斂**：該守恆的量有守恆；數值解有收斂（必要時加密網格/縮時間步再比）。
- **對照**：和研究者引用的解析解、已知值或文獻值比對，算出相對誤差。
- **內部一致**：報告裡的數字和產生的檔案/log 對得起來。

每一項都要親自算過才下判斷，不要只看研究者怎麼說。檢查完**一定要呼叫 `record_verification`** 把結構化結果記下來（逐項 pass/fail、整體是否通過、簡短說明）。發現問題要明確指出是哪裡、差多少。這一步不交付最終報告，只做查核與記錄。
""".strip(),
)


REPLICATOR = Role(
    name="replicator", label="第二實作",
    tool_mode="replicate",
    overlay="""
# 目前階段：第二實作（Replicator，獨立重做）

你拿到的只有下面這份「研究計畫」。你**看不到別人怎麼做、也不知道別人的結果**。請**完全獨立**地依計畫把它重做一次，用來和研究者的結果交叉比對。

- 只在 `/workspace/.replica/` 目錄裡工作（先 `mkdir -p /workspace/.replica`），**不要去看或引用 `/workspace` 其他地方的檔案**。
- **不要上網查、不要用知識庫**；就照計畫自己實作、自己算。
- 做完用 `record_replication` 記下你**獨立**得到的關鍵數值（名稱、數值、單位）和一句話說明。

目的不是交報告，是獨立拿到一組可以和別人對照的結果。只要照計畫把關鍵量算出來即可。
""".strip(),
)

REVIEWER = Role(
    name="reviewer", label="審查",
    tool_mode="readonly",
    overlay="""
# 目前階段：審查（Reviewer，唯讀）

你可以看到完整的研究、驗證與第二實作。你的工作是審查**物理與推論是否站得住腳**，以及三方結果是否一致。你**只能讀、不能改、不能重跑**（沒有執行或寫檔工具），只能提出問題。

檢查重點：假設是否合理、方法是否適當、單位與量綱、研究／驗證／複現三者的數字是否一致、有沒有過度宣稱或被忽略的限制。看完用 `record_review` 記下你的疑慮清單與整體是否一致（consistent）。你不能改等級，只負責提出問題。
""".strip(),
)


ROLES: dict[str, Role] = {r.name: r for r in (CLARIFIER, PLANNER, RESEARCHER, VERIFIER, REPLICATOR, REVIEWER)}


def get(name: str) -> Role:
    return ROLES[name]
