"""
raw.json → label.json 抽出スクリプト。

リコール届出書の構造化データ（raw.json）から、FTA評価用の正解ラベルを抽出する。

出力フォーマット:
  {
    "recall_id": "...",
    "manufacturer": "...",
    "vehicle": "...",
    "target_component": ["部品名1", ...],
    "failure_modes": ["〇〇部位への浸水", "〇〇回路の短絡", ...],
    "top_event": ["意図しないドア開", ...]
  }

実行:
  python benchmark/scripts/extract_label.py                       # 全件
  python benchmark/scripts/extract_label.py --id r8-01-28-005649 # 1件
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

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

SYSTEM_PROMPT = """\
あなたはリコール届出書の解析専門家です。
与えられたリコール届出の構造化データから、FTA評価用の正解ラベルを抽出してください。

## 出力スキーマ（JSONのみ返す、コードブロック不要）

{
  "recall_id": "届出の識別子",
  "manufacturer": "届出者（メーカー名）",
  "vehicle": "対象車種名",
  "target_component": [
    "FTAで必ず登場すべき対象部品名（メイン部品から関連部品まで）"
  ],
  "failure_modes": [
    "『{部品名}が{機能名}を喪失する』の形式で記述する。例：『後席ドア開スイッチ周辺シール部が防水機能を喪失する』"
  ],
  "top_event": [
    "FTAのトップ事象となる最悪の結果（例：火災・走行不能・意図しない動作）"
  ]
}

## 抽出ルール
- target_component: リコール届出書に記載された部品名（別名・略称も含む）。2〜5件
- failure_modes: 「{部品名}が{機能名}を喪失する」の形式で記述する。
  FTAの葉ノード候補となる物理的・化学的な故障現象のみ。根本原因（設計不十分など）は除く。
  各項目は必ず「どの部品において」「どの機能が失われるか」の両方を含む。1〜4件
- top_event: 「最悪の場合〜おそれ」に相当する事象。1〜2件
- 記載がない項目は空配列 [] とする
"""


def extract_label(raw: dict, client: AzureOpenAI) -> dict:
    """raw.json の内容から評価用ラベルを抽出する。

    Args:
        raw: raw.json の内容（dict）
        client: Azure OpenAI クライアント

    Returns:
        label.json 形式の dict
    """
    metadata = raw.get("metadata", {})
    context = json.dumps(metadata, ensure_ascii=False, indent=2)

    response = client.chat.completions.create(
        model=AOAI_DEPLOYMENT,
        max_completion_tokens=2048,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "以下のリコール届出メタデータからFTA評価ラベルを抽出してください。\n\n"
                    f"```json\n{context}\n```"
                ),
            },
        ],
    )
    raw_text = response.choices[0].message.content.strip()
    raw_text = re.sub(r"```(?:json)?|```", "", raw_text).strip()
    try:
        label = json.loads(raw_text)
    except json.JSONDecodeError:
        print(f"  [WARN] JSONパース失敗")
        label = {}

    # recall_id は raw から補完
    label["recall_id"] = raw.get("recall_id", label.get("recall_id", ""))
    return label


def process_one(recall_id: str, client: AzureOpenAI) -> bool:
    """1件の recall_id に対してラベル抽出を実行する。

    Returns:
        成功した場合 True
    """
    raw_path = DATA_DIR / recall_id / "raw.json"
    label_path = DATA_DIR / recall_id / "label.json"

    if not raw_path.exists():
        print(f"  [ERROR] raw.json が見つかりません: {raw_path}")
        return False

    if label_path.exists():
        print(f"  [SKIP] {recall_id} (既存)")
        return True

    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    label = extract_label(raw, client)

    label_path.write_text(json.dumps(label, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  [OK] {recall_id}")
    print(f"       部品: {label.get('target_component', [])}")
    print(f"       故障モード: {label.get('failure_modes', [])}")
    print(f"       トップ事象: {label.get('top_event', [])}")
    return True


def extract_all(recall_ids: list[str] | None = None) -> None:
    """全件または指定 recall_id に対してラベルを抽出する。

    Args:
        recall_ids: 対象 ID リスト。None の場合は data/ 内の全件
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
        print("[extract_label] 対象データがありません")
        return

    print(f"[extract_label] {len(recall_ids)} 件処理中...")
    ok = sum(process_one(rid, client) for rid in recall_ids)
    print(f"[extract_label] 完了: {ok}/{len(recall_ids)} 件")


def main() -> None:
    parser = argparse.ArgumentParser(description="raw.json → label.json 抽出")
    parser.add_argument("--id", metavar="RECALL_ID", help="特定 recall_id のみ処理")
    args = parser.parse_args()

    extract_all([args.id] if args.id else None)


if __name__ == "__main__":
    main()
