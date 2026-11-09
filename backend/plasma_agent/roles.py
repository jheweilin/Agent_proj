"""Pipeline roles: a role overlays the domain system prompt and restricts the tool set
for one stage of the nine-stage research pipeline (see pipeline.py and docs/RESEARCH_AGENT_PLAN.md).

Phase B uses three LLM roles — Clarifier, Planner, Researcher. Stages ② (retrieval) and ⑨
(grade) are programmatic, not roles. ⑥⑦⑧ (verify / replicate / review) arrive in Phase D.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Role:
    name: str
    label: str
    overlay: str          # appended to the domain system prompt for this stage
    tool_mode: str        # "none" = no tools (pure reasoning), "domain" = the domain's full tool set

    def allowed_tools(self, domain_allow: set[str] | None) -> set[str] | None:
        """Intersect the role's tool policy with what the domain exposes."""
        if self.tool_mode == "none":
            return set()
        return domain_allow  # "domain": inherit (None means all registered tools)


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
    tool_mode="none",
    overlay="""
# 目前階段：規劃（Planner）

你現在要根據前面的「釐清結果」和「檢索證據」設計一份**具體的模擬／分析計畫**，交給使用者核准。這一步**不要執行任何計算、不要用工具**，只輸出計畫，然後結束回合。

重要：計畫裡的關鍵參數與方法選擇，凡是有對應到上文「檢索證據」段落的，要**標明來源**（引用該文獻的標題或 DOI）；沒有來源支持的，標成「假設」。不要杜撰數據或來源。

用繁體中文輸出，結構如下：
1. **目標**：這次要產出什麼、如何算成功。
2. **方法與控制方程**：模型、方程式、求解器或工具、座標與單位。
3. **關鍵參數**：逐項列出數值與單位，並標來源（文獻或假設）。
4. **執行步驟**：先小案例、再放大；每步要檢查什麼。
5. **驗收標準**：用什麼判斷結果正確（解析解、守恆量、收斂、與文獻比對）。
6. **風險與備案**：可能卡住的地方與替代做法。

這份計畫會送交使用者核准；核准後才會進入研究階段。
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


ROLES: dict[str, Role] = {r.name: r for r in (CLARIFIER, PLANNER, RESEARCHER)}


def get(name: str) -> Role:
    return ROLES[name]
