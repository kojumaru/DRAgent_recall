"""
LLM as judge スコアリングスクリプト。

label.json（正解ラベル）と output.yaml（FTA生成結果）を比較し、
3軸でスコアを算出する。

評価軸:
  - component_match  : 部品一致（target_component がFTAに含まれるか）
  - failure_mode_match: 故障モード一致（failure_modes がFTAに含まれるか）
  - top_event_match  : トップ事象一致（top_event がFTAのトップに反映されているか）

※ top_event は raw.json の consequences から導出（label.json から取得しない）ため評価対象に含める。
スコア: 各軸 0.0〜1.0、overall は3軸の平均

実行:
  python benchmark/scripts/judge.py --id r8-01-28-005649
  python benchmark/scripts/judge.py  # 全件
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dotenv import load_dotenv
from openai import AzureOpenAI

load_dotenv()

BENCHMARK_ROOT = Path(__file__).parent.parent
DATA_DIR = BENCHMARK_ROOT / "data"

AOAI_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
AOAI_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")
AOAI_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-5.2")
AOAI_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2025-04-01-preview")

JUDGE_SYSTEM_PROMPT = """\
あなたはFTA（故障の木解析）の品質評価専門家です。
リコール届出書から抽出した正解ラベルと、AIが生成したFTA（YAML形式）を比較し、
3つの軸を★1〜5の整数で評価してください。

## 評価軸と採点基準

### 1. component_match（部品一致）
正解ラベルの target_component に含まれる部品が、FTAのノードに登場しているか。
- 5: 主要部品が全てFTAに含まれる
- 4: ほぼ含まれる（1件程度の表現ゆれ・別名あり）
- 3: 半数程度含まれる
- 2: 一部含まれるが主要部品が欠落
- 1: 主要部品がほぼ含まれない

### 2. failure_mode_match（故障モード一致）
正解ラベルの failure_modes に含まれる故障現象が、FTAのノードに登場しているか。
- 5: 主要故障モードが全てFTAに含まれる（同義語・類似表現も可）
- 4: ほぼ含まれる
- 3: 半数程度含まれる
- 2: 一部含まれるが主要なものが欠落
- 1: ほぼ含まれない

### 3. top_event_match（トップ事象一致）
正解ラベルの top_event が、FTAのトップ事象（最上位ノード）と一致または近似しているか。
- 5: 実質的に同じ事象
- 4: 表現や粒度が若干異なるが同じ事象
- 3: 概念的に近いが表現・粒度が明確に異なる
- 2: 関連はあるが別の事象
- 1: 全く別の事象

## 出力スキーマ（JSONのみ返す、コードブロック不要）

{
  "component_match": 1〜5,
  "failure_mode_match": 1〜5,
  "top_event_match": 1〜5,
  "overall": 1〜5,
  "reasoning": {
    "component_match": "判定根拠（一致した部品名・不一致の部品名を明記）",
    "failure_mode_match": "判定根拠（一致した故障モード・不一致を明記）",
    "top_event_match": "判定根拠（FTAのトップ事象と正解の比較を明記）"
  }
}

overall は3軸の単純平均を小数点以下1桁に丸めた値とする。
"""

# ---------------------------------------------------------------------------
# 項目別スコアリング（per-item judge）
# ---------------------------------------------------------------------------

SCORE_CRITERIA = """\
## 評価基準（1〜5）

- 5: 明確に含まれている（同一または同義の表現でFTA内に完全に表現されている）
- 4: 含まれているが、表現や粒度がやや異なる（言い換え・上位概念・近似表現など）
- 3: 関連する記述はあるが、直接的な表現ではない（周辺事象として間接的に示唆されている）
- 2: 部分的にしか表れておらず、重要な側面が欠けている
- 1: ほとんど含まれていない（または全く含まれていない）"""

PER_ITEM_JUDGE_SYSTEM_PROMPT = f"""\
あなたはFTA（故障の木解析）の品質評価専門家です。
リコール届出書から抽出した正解ラベルの各項目が、AIが生成したFTA（YAML形式）の中に
どの程度含まれているかを1〜5の整数で評価してください。

{SCORE_CRITERIA}

## 出力スキーマ（JSONのみ返す、コードブロック不要）

{{
  "failure_modes": [
    {{"item": "評価対象の故障モード名（入力と同じ文字列）", "score": 1〜5}},
    ...
  ],
  "causal_chain": [
    {{"item": "評価対象の因果連鎖ステップ（入力と同じ文字列）", "score": 1〜5}},
    ...
  ]
}}

failure_modes と causal_chain の各項目は、入力で渡したリストと同じ順序・同じ文字列で返してください。
"""


def _yaml_to_text(fta_yaml: dict) -> str:
    """FTA YAML を評価用のフラットなテキスト（全ノードラベル一覧）に変換する。"""

    def _collect_labels(node: dict | list, labels: list[str]) -> None:
        if isinstance(node, list):
            for item in node:
                _collect_labels(item, labels)
        elif isinstance(node, dict):
            if "label" in node:
                labels.append(node["label"])
            if "label_detail" in node and node["label_detail"]:
                labels.append(node["label_detail"])
            if "child" in node:
                _collect_labels(node["child"], labels)

    labels: list[str] = []
    nodes = fta_yaml.get("nodes", [])
    _collect_labels(nodes, labels)
    top = fta_yaml.get("product_name", "")
    return f"製品名: {top}\nFTAノード一覧:\n" + "\n".join(f"  - {l}" for l in labels)


def judge_one(
    label: dict,
    fta_yaml: dict,
    client: AzureOpenAI,
) -> dict:
    """1件の評価を実行する。

    Args:
        label: label.json の内容
        fta_yaml: output.yaml の内容
        client: Azure OpenAI クライアント

    Returns:
        score.json 形式の dict
    """
    fta_text = _yaml_to_text(fta_yaml)
    label_text = json.dumps(label, ensure_ascii=False, indent=2)

    response = client.chat.completions.create(
        model=AOAI_DEPLOYMENT,
        max_completion_tokens=2048,
        messages=[
            {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "## 正解ラベル\n"
                    f"```json\n{label_text}\n```\n\n"
                    "## FTA生成結果\n"
                    f"```\n{fta_text}\n```\n\n"
                    "上記を比較し、3軸でスコアを評価してください。"
                ),
            },
        ],
    )
    raw = response.choices[0].message.content.strip()
    raw = re.sub(r"```(?:json)?|```", "", raw).strip()
    try:
        score = json.loads(raw)
    except json.JSONDecodeError:
        print(f"  [WARN] JSONパース失敗")
        score = {
            "component_match": 1,
            "failure_mode_match": 1,
            "top_event_match": 1,
            "overall": 1.0,
            "reasoning": {"error": raw[:200]},
        }

    # overall を念のため再計算（3軸の平均、小数点以下1桁）
    axes = ["component_match", "failure_mode_match", "top_event_match"]
    vals = [score.get(a, 1) for a in axes]
    score["overall"] = round(sum(vals) / len(vals), 1)
    return score


def process_one(recall_id: str, client: AzureOpenAI, force: bool = False) -> bool:
    """1件の recall_id に対してスコアリングを実行する。

    Returns:
        成功した場合 True
    """
    base = DATA_DIR / recall_id
    label_path = base / "label.json"
    output_path = base / "output.yaml"
    score_path = base / "score.json"

    if not label_path.exists():
        print(f"  [SKIP] {recall_id}: label.json なし")
        return False
    if not output_path.exists():
        print(f"  [SKIP] {recall_id}: output.yaml なし（FTA未生成）")
        return False
    if score_path.exists() and not force:
        print(f"  [SKIP] {recall_id}: score.json 既存")
        return True

    label = json.loads(label_path.read_text(encoding="utf-8"))
    fta_yaml = yaml.safe_load(output_path.read_text(encoding="utf-8"))

    score = judge_one(label, fta_yaml, client)
    score_path.write_text(json.dumps(score, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  [OK] {recall_id}")
    print(f"       部品一致={score['component_match']:.2f}  "
          f"故障モード={score['failure_mode_match']:.2f}  "
          f"トップ事象={score['top_event_match']:.2f}  "
          f"overall={score['overall']:.2f}")
    return True


def judge_all(recall_ids: list[str] | None = None, force: bool = False) -> list[dict]:
    """全件または指定 recall_id に対してスコアリングを実行する。

    Args:
        recall_ids: 対象 ID リスト。None の場合は data/ 内の全件
        force: 既存 score.json を上書きする

    Returns:
        スコア結果リスト
    """
    if not AOAI_KEY:
        raise EnvironmentError("AZURE_OPENAI_API_KEY が未設定です")
    client = AzureOpenAI(
        azure_endpoint=AOAI_ENDPOINT,
        api_key=AOAI_KEY,
        api_version=AOAI_API_VERSION,
    )

    if recall_ids is None:
        recall_ids = [d.name for d in DATA_DIR.iterdir() if d.is_dir()]
    if not recall_ids:
        print("[judge] 対象データがありません")
        return []

    print(f"[judge] {len(recall_ids)} 件処理中...")
    results = []
    for rid in recall_ids:
        process_one(rid, client, force=force)
        score_path = DATA_DIR / rid / "score.json"
        if score_path.exists():
            s = json.loads(score_path.read_text(encoding="utf-8"))
            s["recall_id"] = rid
            results.append(s)

    if results:
        avg = sum(r["overall"] for r in results) / len(results)
        print(f"\n[judge] 平均 overall スコア: {avg:.3f} ({len(results)} 件)")
    return results


def judge_per_item_one(
    label: dict,
    fta_yaml: dict,
    client: AzureOpenAI,
) -> dict:
    """failure_modes と causal_chain の各項目を個別に1〜5でスコアリングする。

    Args:
        label: label.json の内容
        fta_yaml: output.yaml の内容
        client: Azure OpenAI クライアント

    Returns:
        per_item_score.json 形式の dict
    """
    fta_text = _yaml_to_text(fta_yaml)
    failure_modes = label.get("failure_modes") or []
    causal_chain = label.get("causal_chain") or []

    user_content = (
        "## 生成FTA\n"
        f"```\n{fta_text}\n```\n\n"
        "## 評価対象: 故障モード\n"
        + "\n".join(f"- {m}" for m in failure_modes)
        + "\n\n## 評価対象: 因果連鎖ステップ\n"
        + "\n".join(f"- {s}" for s in causal_chain)
        + "\n\n上記の各項目について、生成FTAへの包含度を1〜5で評価してください。"
    )

    response = client.chat.completions.create(
        model=AOAI_DEPLOYMENT,
        max_completion_tokens=2048,
        messages=[
            {"role": "system", "content": PER_ITEM_JUDGE_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
    )
    raw = response.choices[0].message.content.strip()
    raw = re.sub(r"```(?:json)?|```", "", raw).strip()
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        print(f"  [WARN] per-item JSONパース失敗")
        result = {
            "failure_modes": [{"item": m, "score": 1} for m in failure_modes],
            "causal_chain": [{"item": s, "score": 1} for s in causal_chain],
            "error": raw[:200],
        }

    # 項目数が一致しない場合は入力リストで補正
    if len(result.get("failure_modes", [])) != len(failure_modes):
        result["failure_modes"] = [{"item": m, "score": 1} for m in failure_modes]
    if len(result.get("causal_chain", [])) != len(causal_chain):
        result["causal_chain"] = [{"item": s, "score": 1} for s in causal_chain]

    return result


def process_per_item_one(recall_id: str, client: AzureOpenAI, force: bool = False) -> bool:
    """1件の recall_id に対して項目別スコアリングを実行し per_item_score.json に保存する。

    Args:
        recall_id: 対象 ID
        client: Azure OpenAI クライアント
        force: 既存ファイルを上書き

    Returns:
        成功した場合 True
    """
    base = DATA_DIR / recall_id
    label_path = base / "label.json"
    output_path = base / "output.yaml"
    score_path = base / "per_item_score.json"

    if not label_path.exists():
        print(f"  [SKIP] {recall_id}: label.json なし")
        return False
    if not output_path.exists():
        print(f"  [SKIP] {recall_id}: output.yaml なし（FTA未生成）")
        return False
    if score_path.exists() and not force:
        print(f"  [SKIP] {recall_id}: per_item_score.json 既存")
        return True

    label = json.loads(label_path.read_text(encoding="utf-8"))
    fta_yaml = yaml.safe_load(output_path.read_text(encoding="utf-8"))

    result = judge_per_item_one(label, fta_yaml, client)
    result["recall_id"] = recall_id
    score_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  [OK] {recall_id}: "
          f"故障モード {len(result['failure_modes'])} 件、"
          f"因果連鎖 {len(result['causal_chain'])} ステップ")
    return True


def judge_per_item_all(recall_ids: list[str] | None = None, force: bool = False) -> None:
    """全件または指定 recall_id に対して項目別スコアリングを実行する。"""
    if not AOAI_KEY:
        raise EnvironmentError("AZURE_OPENAI_API_KEY が未設定です")
    client = AzureOpenAI(
        azure_endpoint=AOAI_ENDPOINT,
        api_key=AOAI_KEY,
        api_version=AOAI_API_VERSION,
    )
    if recall_ids is None:
        recall_ids = [d.name for d in DATA_DIR.iterdir() if d.is_dir()]
    print(f"[judge-per-item] {len(recall_ids)} 件処理中...")
    for rid in recall_ids:
        process_per_item_one(rid, client, force=force)


def main() -> None:
    parser = argparse.ArgumentParser(description="LLM as judge でFTA品質をスコア化")
    parser.add_argument("--id", metavar="RECALL_ID", help="特定 recall_id のみ処理")
    parser.add_argument("--force", action="store_true", help="既存 score.json を上書き")
    parser.add_argument("--per-item", action="store_true",
                        help="各故障モード・因果連鎖ステップを個別にスコアリング（per_item_score.json）")
    args = parser.parse_args()

    ids = [args.id] if args.id else None
    if args.per_item:
        judge_per_item_all(ids, force=args.force)
    else:
        judge_all(ids, force=args.force)


if __name__ == "__main__":
    main()
