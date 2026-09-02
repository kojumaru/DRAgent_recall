"""
国土交通省リコール届出書 → 部品仕様書生成パイプライン

処理フロー:
  1. PDF取得（URLまたはローカルパス）
  2. Azure Document Intelligence (prebuilt-layout) でOCR → markdown
  3. Phase 1: LLMでリコールメタ情報・不具合内容を構造化抽出
  4. Phase 2: 対象部品ごとにFTAベンチマーク用仕様書を生成
  5. recall/dataset/specs/{recall_id}.json に保存

実行例:
  # ローカルPDFを指定
  python recall/scripts/pipeline.py --pdf /path/to/recall.pdf --id 2026-toyota-0128

  # URLから直接取得（公開PDFのみ）
  python recall/scripts/pipeline.py --url https://... --id 2026-toyota-0128

出力:
  recall/dataset/ocr_cache/{recall_id}.txt  （OCRテキストキャッシュ）
  recall/dataset/specs/{recall_id}.json     （部品仕様書JSON）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.ai.documentintelligence.models import AnalyzeDocumentRequest
from azure.core.credentials import AzureKeyCredential
from dotenv import load_dotenv
from openai import AzureOpenAI

load_dotenv()

# ── パス定義 ────────────────────────────────────────────────────────
RECALL_ROOT = Path(__file__).parent.parent  # recall/
RECALL_PDF_DIR = RECALL_ROOT / "dataset" / "pdfs"
RECALL_OCR_DIR = RECALL_ROOT / "dataset" / "ocr_cache"
RECALL_SPEC_DIR = RECALL_ROOT / "dataset" / "specs"

# ── Azure 設定 ──────────────────────────────────────────────────────
DI_ENDPOINT = os.environ.get("AZURE_DOCINT_ENDPOINT", "")
DI_KEY = os.environ.get("AZURE_DOCINT_KEY", "")

AOAI_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
AOAI_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")
AOAI_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-5.2")
AOAI_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2025-04-01-preview")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 1: PDF取得
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def fetch_pdf(source: str, recall_id: str) -> Path:
    """URLまたはローカルパスからPDFを取得してローカルに保存する。"""
    RECALL_PDF_DIR.mkdir(parents=True, exist_ok=True)
    dest = RECALL_PDF_DIR / f"{recall_id}.pdf"

    if source.startswith("http://") or source.startswith("https://"):
        if dest.exists():
            print(f"[PDF] キャッシュ済み: {dest}")
            return dest
        print(f"[PDF] ダウンロード中: {source}")
        urllib.request.urlretrieve(source, dest)
        print(f"[PDF] 保存: {dest}")
    else:
        src_path = Path(source)
        if not src_path.exists():
            raise FileNotFoundError(f"PDFファイルが見つかりません: {source}")
        if not dest.exists() or dest.stat().st_mtime < src_path.stat().st_mtime:
            import shutil
            shutil.copy2(src_path, dest)
        print(f"[PDF] ローカルPDF使用: {dest}")

    return dest


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 2: Azure Document Intelligence OCR
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def ocr_pdf(pdf_path: Path, recall_id: str) -> str:
    """Azure DIでPDFをOCRし、テキストを返す（キャッシュあり）。"""
    RECALL_OCR_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = RECALL_OCR_DIR / f"{recall_id}.txt"

    if cache_path.exists():
        print(f"[OCR] キャッシュ済み: {cache_path}")
        return cache_path.read_text(encoding="utf-8")

    if not DI_ENDPOINT or not DI_KEY:
        raise EnvironmentError("AZURE_DOCINT_ENDPOINT / AZURE_DOCINT_KEY が未設定です")

    print(f"[OCR] Azure Document Intelligence で処理中: {pdf_path.name}")
    client = DocumentIntelligenceClient(DI_ENDPOINT, AzureKeyCredential(DI_KEY))
    poller = client.begin_analyze_document(
        "prebuilt-layout",
        body=AnalyzeDocumentRequest(bytes_source=pdf_path.read_bytes()),
        locale="ja",
        output_content_format="markdown",
    )
    result = poller.result()
    text = result.content or ""

    # figureタグ・コメントを除去してクリーニング
    text = clean_ocr_text(text)

    cache_path.write_text(text, encoding="utf-8")
    print(f"[OCR] 完了 ({len(text)} 文字) → {cache_path}")
    return text


def clean_ocr_text(text: str) -> str:
    """<figure>タグ・HTMLコメントを除去し、連続空行を圧縮する。"""
    text = re.sub(r"<figure>.*?</figure>", "", text, flags=re.DOTALL)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 3: Phase 1 - リコールメタ情報の構造化抽出
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PHASE1_SYSTEM_PROMPT = """\
あなたは日本の自動車リコール届出書を解析する専門家です。
国土交通省への自動車リコール届出書（PDFのOCRテキスト）から情報を抽出してください。

## 重要：まとめ届出の扱い

「少数台数のリコール届出の公表」など、複数社・複数件のリコールを1枚のPDFにまとめた
ものの場合は、**件数分の要素を持つJSON配列**として返してください。
通常の単一リコールの場合も**1要素の配列**として返してください。

## 出力スキーマ（コードブロック不要、JSON配列のみ返す）

[
  {
    "notification_number": "届出番号",
    "notification_date": "届出日 (YYYY-MM-DD形式。令和8年=2026年、令和7年=2025年、令和6年=2024年で換算)",
    "notifier": "届出者名（例: トヨタ自動車株式会社）",
    "recall_type": "リコール or 改善対策 or 技術サービスキャンペーン",
    "affected_vehicles": [
      {
        "make": "メーカー名",
        "model": "車名",
        "type_designation": "型式",
        "model_years": ["製造期間 例: 2020-01-01 to 2023-12-31"],
        "affected_count": "対象台数（数値文字列）"
      }
    ],
    "defect_system": "不具合が発生するシステム・装置名（例: 燃料装置、操舵装置）",
    "defect_location": "不具合部位（例: 燃料タンク、ステアリングギヤ）",
    "defect_description": "不具合の内容（原文に近い形で）",
    "root_cause": "不具合の原因（原文に近い形で）",
    "consequences": ["最悪の場合の影響・結果（箇条書き）"],
    "parts": [
      {
        "part_name": "部品名",
        "part_number": "部品番号（記載があれば）",
        "system_path": ["システム階層 例: ['燃料装置', '燃料タンク']"]
      }
    ],
    "correction_summary": "改善措置の概要",
    "correction_detail": "改善措置の詳細"
  }
]

## 注意事項
- 必ずJSON配列（[...]）で返すこと。単一リコールでも1要素の配列にする
- テキストに記載がない項目はnullを設定する
- affected_countは数値文字列（例: "12345"）
- system_pathは部品の階層を表す配列（最大3階層）
- 複数の部品が記載されている場合はpartsに全て列挙する
"""


def extract_recall_metadata(ocr_text: str, client: AzureOpenAI) -> list[dict]:
    """Phase 1: リコール届出書のメタ情報を構造化抽出する。

    Returns:
        list[dict]: 単一リコールでも1要素リスト、まとめPDFは複数要素リスト
    """
    print("[Phase1] リコールメタ情報を抽出中...")
    response = client.chat.completions.create(
        model=AOAI_DEPLOYMENT,
        max_completion_tokens=8192,
        messages=[
            {"role": "system", "content": PHASE1_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "以下のリコール届出書のOCRテキストから情報を抽出してください。\n\n"
                    f"---\n{ocr_text}\n---"
                ),
            },
        ],
    )
    raw = response.choices[0].message.content.strip()
    result = parse_json_response(raw)
    # 後方互換: dictが返った場合はリストに包む
    if isinstance(result, dict):
        result = [result]
    return result if isinstance(result, list) else []


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 4: Phase 2 - 部品仕様書の生成
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PHASE2_SYSTEM_PROMPT = """\
あなたは自動車工学の専門家として、リコール届出書の情報を元に
FTAベンチマーク用の部品仕様書を生成します。

リコール届出書のテキストと、抽出済みのメタ情報を参照して、
指定された部品についての詳細な仕様書をJSONで生成してください。

## 出力スキーマ（コードブロック不要、JSONのみ返す）

{
  "part_name": "部品名",
  "system_path": ["システム階層配列"],
  "specification": {
    "function": "正常時の機能・役割（FTA評価者が参照できる詳細な説明）",
    "structure": "部品の構造・材質・配置・隣接部品との関係",
    "operating_conditions": "通常の動作条件・使用環境（温度、圧力、負荷等）",
    "design_requirements": "設計要件・品質基準（記載があれば）"
  },
  "failure": {
    "failure_mode": "不具合の形態（例: 亀裂・腐食・脱落・漏れ）",
    "root_cause": "根本原因（設計不良・製造不良・材料不良等を明確に）",
    "mechanism": "故障メカニズム（物理的・化学的プロセスの説明）",
    "trigger_conditions": "不具合が顕在化する条件・タイミング",
    "symptoms": "外観上・走行上の症状・異常現象",
    "consequences": [
      "直接的影響",
      "二次的影響",
      "最悪の場合の影響（安全上のリスク）"
    ],
    "failure_rate_context": "不具合発生件数・率（記載があれば）",
    "detectability": "運転者・整備士による検知可能性"
  },
  "correction": {
    "measure_type": "対策の種類（部品交換・改良品への交換・ソフトウェア更新等）",
    "measure_detail": "対策の詳細",
    "inspection_method": "点検方法（記載があれば）"
  },
  "fta_relevance": {
    "top_event": "FTAのトップ事象（最上位の望ましくない事象）",
    "key_failure_chain": ["故障チェーン（原因→中間事象→トップ事象の順）"],
    "gate_logic": "主要なゲートロジック（AND/OR）の説明"
  },
  "source_quotes": [
    "根拠となるリコール届出書の原文引用（1〜3件）"
  ]
}

## 注意事項
- specificationのfunctionは「正常時に何をする部品か」を自動車工学的に記述する
- failure.mechanismは物理的なプロセス（腐食・疲労・熱膨張等）を使って説明する
- fta_relevanceはFTA生成エージェントの評価基準として使われるため詳細に記述する
- key_failure_chainは原因から結果への連鎖を配列で表現する（3〜5段階）
- 記載がない項目はnullを設定する
"""


def generate_part_spec(
    part_info: dict,
    recall_metadata: dict,
    ocr_text: str,
    client: AzureOpenAI,
) -> dict:
    """Phase 2: 1部品の仕様書を生成する。"""
    part_name = part_info.get("part_name", "不明部品")
    print(f"  [Phase2] {part_name} の仕様書を生成中...")

    context = (
        f"## リコール届出書メタ情報\n"
        f"届出者: {recall_metadata.get('notifier', '不明')}\n"
        f"届出日: {recall_metadata.get('notification_date', '不明')}\n"
        f"不具合部位: {recall_metadata.get('defect_location', '不明')}\n"
        f"不具合内容: {recall_metadata.get('defect_description', '不明')}\n"
        f"不具合原因: {recall_metadata.get('root_cause', '不明')}\n"
        f"影響: {', '.join(recall_metadata.get('consequences', []))}\n"
        f"改善措置: {recall_metadata.get('correction_detail', '不明')}\n\n"
        f"## 対象部品\n"
        f"部品名: {part_name}\n"
        f"システム: {' > '.join(part_info.get('system_path', []))}\n\n"
        f"## リコール届出書 原文（OCR）\n"
        f"---\n{ocr_text}\n---"
    )

    response = client.chat.completions.create(
        model=AOAI_DEPLOYMENT,
        max_completion_tokens=4096,
        messages=[
            {"role": "system", "content": PHASE2_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"以下の情報を元に、「{part_name}」の部品仕様書を生成してください。\n\n"
                    f"{context}"
                ),
            },
        ],
    )
    raw = response.choices[0].message.content.strip()
    spec = parse_json_response(raw)
    # part_number は Phase 1 から引き継ぐ
    if "part_number" in part_info and part_info["part_number"]:
        spec["part_number"] = part_info["part_number"]
    return spec


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ユーティリティ
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def parse_json_response(raw: str) -> dict | list:
    """LLMレスポンスからJSONをパースする（コードブロック除去付き）。"""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        cleaned = re.sub(r"```(?:json)?|```", "", raw).strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            print(f"[WARN] JSONパース失敗（最初の300文字）:\n{raw[:300]}")
            return {}


def build_aoai_client() -> AzureOpenAI:
    if not AOAI_KEY:
        raise EnvironmentError("AZURE_OPENAI_API_KEY が未設定です")
    return AzureOpenAI(
        azure_endpoint=AOAI_ENDPOINT,
        api_key=AOAI_KEY,
        api_version=AOAI_API_VERSION,
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# メインパイプライン
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def run_pipeline(source: str, recall_id: str) -> tuple[Path, Path]:
    """
    フルパイプラインを実行する。

    出力ファイル:
      {recall_id}_raw.json  : 届出書の事実のみ（metadata + source_quotes）
      {recall_id}_spec.json : GPT推論による部品仕様書（specification / fta_relevance 等）

    Args:
        source: PDFのローカルパスまたはURL
        recall_id: リコールの識別子（出力ファイル名に使用）

    Returns:
        (raw_path, spec_path) の tuple
    """
    RECALL_SPEC_DIR.mkdir(parents=True, exist_ok=True)
    raw_path  = RECALL_SPEC_DIR / f"{recall_id}_raw.json"
    spec_path = RECALL_SPEC_DIR / f"{recall_id}_spec.json"

    # Step 1: PDF取得
    pdf_path = fetch_pdf(source, recall_id)

    # Step 2: OCR
    ocr_text = ocr_pdf(pdf_path, recall_id)

    # Azure OpenAI クライアント
    client = build_aoai_client()

    # Step 3: Phase 1 - メタ情報抽出（届出書の事実ベース）
    metadata = extract_recall_metadata(ocr_text, client)
    if not metadata:
        print("[ERROR] Phase 1 でメタ情報の抽出に失敗しました")
        sys.exit(1)

    print(f"[Phase1] 完了")
    print(f"  届出者: {metadata.get('notifier', '不明')}")
    print(f"  不具合部位: {metadata.get('defect_location', '不明')}")
    parts_list = metadata.get("parts", [])
    print(f"  対象部品数: {len(parts_list)}")

    # Step 4: Phase 2 - 部品仕様書生成（GPT推論）
    print(f"[Phase2] 部品仕様書を生成中...")
    raw_parts  = []
    spec_parts = []
    for i, part_info in enumerate(parts_list):
        part_id = f"P{i+1:03d}"
        full = generate_part_spec(part_info, metadata, ocr_text, client)
        full["part_id"] = part_id

        # _raw: 届出書に直接記載されている情報のみ
        raw_parts.append({
            "part_id": part_id,
            "part_name": full.get("part_name"),
            "part_number": full.get("part_number"),
            "system_path": full.get("system_path"),
            "source_quotes": full.get("source_quotes", []),
        })

        # _spec: GPTが推論・補完した仕様情報
        spec_parts.append({
            "part_id": part_id,
            "part_name": full.get("part_name"),
            "system_path": full.get("system_path"),
            "specification": full.get("specification"),
            "failure": full.get("failure"),
            "correction": full.get("correction"),
            "fta_relevance": full.get("fta_relevance"),
        })

    # _raw.json: 事実ベース（メタ情報 + 原文引用）
    raw_output = {
        "recall_id": recall_id,
        "metadata": metadata,
        "parts": raw_parts,
        "_note": "届出書の記載事実のみを構造化したファイル",
    }
    raw_path.write_text(json.dumps(raw_output, ensure_ascii=False, indent=2), encoding="utf-8")

    # _spec.json: GPT推論による仕様書
    spec_output = {
        "recall_id": recall_id,
        "parts": spec_parts,
        "_note": "LLMが自動車工学知識から推論・補完した仕様書（要レビュー）",
    }
    spec_path.write_text(json.dumps(spec_output, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n[完了]")
    print(f"  事実ベース : {raw_path}")
    print(f"  推論仕様書 : {spec_path}")
    print(f"  部品数: {len(raw_parts)}")
    return raw_path, spec_path


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CLI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def main() -> None:
    parser = argparse.ArgumentParser(
        description="国土交通省リコール届出書から部品仕様書を生成するパイプライン"
    )
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--pdf", metavar="PATH", help="ローカルPDFファイルパス")
    source_group.add_argument("--url", metavar="URL", help="PDF公開URL")
    parser.add_argument(
        "--id",
        metavar="RECALL_ID",
        required=True,
        help="リコール識別子（例: 2026-toyota-0128）",
    )
    args = parser.parse_args()

    source = args.pdf or args.url
    run_pipeline(source, args.id)


if __name__ == "__main__":
    main()
