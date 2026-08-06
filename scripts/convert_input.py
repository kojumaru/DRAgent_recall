"""
spec_FTA.md + raw.json → input.yaml 変換スクリプト。

spec_FTA.md をルールベースでパースして input.yaml を生成する。
LLM 呼び出し不要。label.json は一切参照しない。

input.yaml スキーマ:
  product_name: 製品名
  purpose: 製品の目的（1文）
  functions: 主要機能リスト
  components: 構成部品リスト
  top_event: TOP事象（raw.json の consequences から導出）

spec_FTA.md の構造（セクション1〜3）:
  # 部品正常仕様書
  対象部品：<product_name>
  ## 1. 対象部品の特定
  ## 2. システム内での役割   ← purpose
  ## 3. 構成・関連部品       ← components（箇条書き「- 部品名：機能説明」）

実行:
  python benchmark/scripts/convert_input.py --id r8-01-28-005649
  python benchmark/scripts/convert_input.py  # 全件
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

BENCHMARK_ROOT = Path(__file__).parent.parent
DATA_DIR = BENCHMARK_ROOT / "data"

# top_event 抽出時に除去するヘッジ表現
_HEDGE_PREFIXES = ["最悪の場合、", "最悪の場合 ", "場合によっては、"]
_HEDGE_SUFFIXES = ["おそれがある", "可能性がある", "ことがある", "場合がある"]


def _extract_section(text: str, section_num: int) -> str:
    """spec_FTA.md から指定セクションの本文を取得する。"""
    pattern = rf"## {section_num}\..+?\n(.*?)(?=\n## |\Z)"
    m = re.search(pattern, text, re.DOTALL)
    return m.group(1).strip() if m else ""


def _parse_bullet_items(section_text: str) -> tuple[list[str], list[str]]:
    """「- 部品名：機能説明」形式の箇条書きから部品名と機能説明を分離する。"""
    components, functions = [], []
    for line in section_text.splitlines():
        line = line.strip()
        if not line.startswith("- "):
            continue
        content = line[2:]
        if "：" in content:
            part, func = content.split("：", 1)
            components.append(part.strip())
            functions.append(func.strip())
        else:
            components.append(content.strip())
    return components, functions


def _derive_top_event(consequences: list[str]) -> str:
    """consequences リストから最も深刻な事象を取り出してトップ事象文字列を返す。"""
    if not consequences:
        return ""
    # 最後の consequence が最も深刻な想定
    text = consequences[-1]
    for prefix in _HEDGE_PREFIXES:
        text = text.removeprefix(prefix)
    for suffix in _HEDGE_SUFFIXES:
        if text.endswith(suffix):
            text = text[: -len(suffix)]
    return text.strip()


def convert_one(spec_text: str, meta: dict, raw: dict | None = None) -> dict:
    """spec_FTA.md と raw.json の metadata から input.yaml の内容を生成する。"""
    # product_name: 「対象部品：...」行から取得
    product_name = ""
    for line in spec_text.splitlines():
        if line.startswith("対象部品："):
            product_name = line.removeprefix("対象部品：").strip()
            break
    if not product_name:
        product_name = meta.get("defect_location", "不明")

    # purpose: セクション2の本文（1段落）
    purpose = _extract_section(spec_text, 2)

    # components / functions: セクション3の箇条書き
    sec3 = _extract_section(spec_text, 3)
    components, functions = _parse_bullet_items(sec3)

    # top_event: raw.json の consequences から導出
    top_event = _derive_top_event(meta.get("consequences", []))
    if not top_event:
        top_event = meta.get("defect_location", "不明") + "の不具合"

    result: dict = {
        "product_name": product_name,
        "purpose": purpose,
        "functions": functions,
        "components": components,
        "top_event": top_event,
    }

    # diagram_pdf_url: raw.json にあれば追加
    if raw and raw.get("diagram_pdf_url"):
        result["diagram_pdf_url"] = raw["diagram_pdf_url"]

    return result


def process_one(recall_id: str, force: bool = False) -> bool:
    """1件の recall_id に対して input.yaml を生成する。"""
    base = DATA_DIR / recall_id
    spec_path = base / "spec_FTA.md"
    raw_path = base / "raw.json"
    input_path = base / "input.yaml"

    if not spec_path.exists():
        print(f"  [SKIP] {recall_id}: spec_FTA.md なし")
        return False
    if not raw_path.exists():
        print(f"  [SKIP] {recall_id}: raw.json なし")
        return False
    if input_path.exists() and not force:
        print(f"  [SKIP] {recall_id}: input.yaml 既存")
        return True

    spec_text = re.sub(r"<!--.*?-->", "", spec_path.read_text(encoding="utf-8"), flags=re.DOTALL)
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    meta = raw.get("metadata", {})

    data = convert_one(spec_text, meta, raw)

    input_path.write_text(
        yaml.dump(data, allow_unicode=True, default_flow_style=False, sort_keys=False),
        encoding="utf-8",
    )
    print(f"  [OK] {recall_id}")
    print(f"       product_name: {data.get('product_name', '')}")
    print(f"       top_event:    {data.get('top_event', '')}")
    return True


def convert_all(recall_ids: list[str] | None = None, force: bool = False) -> None:
    """全件または指定 recall_id に対して input.yaml を生成する。"""
    if recall_ids is None:
        recall_ids = [d.name for d in DATA_DIR.iterdir() if d.is_dir()]
    if not recall_ids:
        print("[convert_input] 対象データがありません")
        return

    print(f"[convert_input] {len(recall_ids)} 件処理中...")
    ok = sum(process_one(rid, force=force) for rid in recall_ids)
    print(f"[convert_input] 完了: {ok}/{len(recall_ids)} 件")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="spec_FTA.md + raw.json → input.yaml 変換（LLM不要・label.json不使用）"
    )
    parser.add_argument("--id", metavar="RECALL_ID", help="特定 recall_id のみ処理")
    parser.add_argument("--force", action="store_true", help="既存 input.yaml を上書き")
    args = parser.parse_args()

    convert_all([args.id] if args.id else None, force=args.force)


if __name__ == "__main__":
    main()
