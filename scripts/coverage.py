"""
Coverage 計算スクリプト（δ=0）

## Coverage の定義

事例 i = 各 failure_mode 項目 / causal_chain ステップ（recall 内の全項目を横断）

### Coverage_LLM
  r̂_i   : LLM（per_item_score.json）の事例 i のスコア
  C_i    : 全専門家が事例 i につけたスコアの集合（expert_reviews.json）
  Coverage_LLM = (1/m) Σ_{i=1}^{m} 1[r̂_i ∈ C_i]

### Coverage_human（leave-one-out）
  r_{ij}    : 専門家 j が事例 i につけたスコア
  C_i^{-j}  : 専門家 j 以外の全専門家が事例 i につけたスコアの集合
  Coverage_human = (1/(m*n)) Σ_i Σ_j 1[r_{ij} ∈ C_i^{-j}]

### 判定
  Coverage_LLM >= Coverage_human - δ (δ=0) なら LLM は専門家相当

実行:
  python scripts/coverage.py                # data/ 内の全 recall を集計
  python scripts/coverage.py --id r8-01-13-005638  # 特定 recall のみ
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

BENCHMARK_ROOT = Path(__file__).parent.parent
DATA_DIR = BENCHMARK_ROOT / "data"

DELTA = 0.0


def _load_json(path: Path) -> dict | list | None:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return None


def _compute_coverage_one(recall_id: str) -> dict | None:
    """1件の recall_id に対して Coverage_LLM と Coverage_human を計算する。

    Returns:
        coverage 結果 dict、または計算不能な場合は None
    """
    base = DATA_DIR / recall_id
    per_item: dict | None = _load_json(base / "per_item_score.json")  # type: ignore
    expert_reviews: list | None = _load_json(base / "expert_reviews.json")  # type: ignore

    if per_item is None:
        print(f"  [SKIP] {recall_id}: per_item_score.json なし（judge.py --per-item を実行してください）")
        return None
    if not expert_reviews:
        print(f"  [SKIP] {recall_id}: expert_reviews.json なし、または専門家評価が 0 件")
        return None

    # ------------------------------------------------------------------
    # 全事例リストを構築
    # ------------------------------------------------------------------
    # 事例キー = "failure_mode:{item}" or "causal_chain:{item}"
    llm_scores: dict[str, int] = {}
    for entry in per_item.get("failure_modes", []):
        key = f"failure_mode:{entry['item']}"
        llm_scores[key] = entry["score"]
    for entry in per_item.get("causal_chain", []):
        key = f"causal_chain:{entry['item']}"
        llm_scores[key] = entry["score"]

    # 専門家ごとのスコア dict: reviewer -> {key: score}
    expert_score_maps: list[dict[str, int]] = []
    for rev in expert_reviews:
        m: dict[str, int] = {}
        for entry in rev.get("failure_modes", []):
            m[f"failure_mode:{entry['item']}"] = entry["score"]
        for entry in rev.get("causal_chain", []):
            m[f"causal_chain:{entry['item']}"] = entry["score"]
        expert_score_maps.append(m)

    n = len(expert_score_maps)  # 専門家人数

    # LLM スコアと専門家スコアが両方存在する事例のみ対象
    items = [key for key in llm_scores if any(key in em for em in expert_score_maps)]
    m_items = len(items)

    if m_items == 0:
        print(f"  [SKIP] {recall_id}: LLM スコアと専門家スコアの共通項目が 0 件")
        return None

    # ------------------------------------------------------------------
    # Coverage_LLM
    # ------------------------------------------------------------------
    llm_hit = 0
    for key in items:
        r_hat = llm_scores[key]
        C_i = {em[key] for em in expert_score_maps if key in em}
        if r_hat in C_i:
            llm_hit += 1

    coverage_llm = llm_hit / m_items

    # ------------------------------------------------------------------
    # Coverage_human（leave-one-out）
    # ------------------------------------------------------------------
    human_hit = 0
    human_total = 0
    for key in items:
        scores_for_item = [(j, em[key]) for j, em in enumerate(expert_score_maps) if key in em]
        for j, r_ij in scores_for_item:
            C_i_minus_j = {r for jj, r in scores_for_item if jj != j}
            if not C_i_minus_j:
                continue  # 専門家が 1 人のみの事例は leave-one-out 不可
            if r_ij in C_i_minus_j:
                human_hit += 1
            human_total += 1

    coverage_human = human_hit / human_total if human_total > 0 else None

    is_expert_level = (
        coverage_llm >= coverage_human - DELTA
        if coverage_human is not None
        else None
    )

    return {
        "recall_id": recall_id,
        "n_items": m_items,
        "n_experts": n,
        "coverage_llm": round(coverage_llm, 4),
        "coverage_human": round(coverage_human, 4) if coverage_human is not None else None,
        "delta": DELTA,
        "is_expert_level": is_expert_level,
    }


def compute_all(recall_ids: list[str] | None = None) -> list[dict]:
    """全件または指定 recall_id に対して Coverage を計算する。"""
    if recall_ids is None:
        recall_ids = sorted(d.name for d in DATA_DIR.iterdir() if d.is_dir())

    results = []
    for rid in recall_ids:
        r = _compute_coverage_one(rid)
        if r is not None:
            results.append(r)
            verdict = (
                "専門家相当" if r["is_expert_level"] is True
                else "専門家相当でない" if r["is_expert_level"] is False
                else "判定不可（専門家1人）"
            )
            print(
                f"  [OK] {rid}  "
                f"Coverage_LLM={r['coverage_llm']:.3f}  "
                f"Coverage_human={r['coverage_human']:.3f if r['coverage_human'] is not None else '---'}  "
                f"→ {verdict}"
            )

    if results:
        valid = [r for r in results if r["is_expert_level"] is not None]
        n_expert_level = sum(1 for r in valid if r["is_expert_level"])
        avg_llm = sum(r["coverage_llm"] for r in results) / len(results)
        avg_human = sum(r["coverage_human"] for r in results if r["coverage_human"] is not None)
        n_human = sum(1 for r in results if r["coverage_human"] is not None)

        print(f"\n[coverage] {len(results)} 件集計")
        print(f"  Coverage_LLM    平均: {avg_llm:.3f}")
        if n_human:
            print(f"  Coverage_human  平均: {avg_human / n_human:.3f}  （{n_human} 件）")
        if valid:
            print(f"  専門家相当率: {n_expert_level}/{len(valid)} ({n_expert_level/len(valid):.1%})")

    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Coverage_LLM / Coverage_human を計算し LLM の専門家相当性を判定する")
    parser.add_argument("--id", metavar="RECALL_ID", help="特定 recall_id のみ処理")
    args = parser.parse_args()

    print(f"[coverage] δ={DELTA}")
    compute_all([args.id] if args.id else None)


if __name__ == "__main__":
    main()
