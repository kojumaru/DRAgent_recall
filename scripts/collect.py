"""
2026年1〜6月の国交省リコール届出を一括収集するスクリプト。

処理フロー:
  1. recall.html から月別プレスリリースリンクを収集
  2. 各プレスリリースページから PDF URL を取得
  3. PDF を OCR → raw.json + label.json を生成
  4. benchmark/data/{recall_id}/ に保存

実行:
  python benchmark/scripts/collect.py               # 全6ヶ月
  python benchmark/scripts/collect.py --month 1     # 1月のみ
  python benchmark/scripts/collect.py --dry-run     # URLリストのみ表示
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

import os
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

# fta-spec-generator のパスを解決（.env の FTA_SPEC_GENERATOR_ROOT または隣接ディレクトリを想定）
_spec_gen_root = Path(os.environ.get(
    "FTA_SPEC_GENERATOR_ROOT",
    str(Path(__file__).parent.parent.parent / "fta-spec-generator"),
))
sys.path.insert(0, str(_spec_gen_root))

from scripts.pipeline import fetch_pdf, ocr_pdf, extract_recall_metadata, build_aoai_client

BENCHMARK_ROOT = Path(__file__).parent.parent
DATA_DIR = BENCHMARK_ROOT / "data"
MLIT_BASE = "https://www.mlit.go.jp"
RECALL_INDEX_URL = "https://www.mlit.go.jp/jidosha/recall.html"
TARGET_YEAR = 2026
TARGET_MONTHS = list(range(1, 7))  # 1〜6月
REIWA_OFFSET = 2018


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ページ取得・パース
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@dataclass
class RecallPressEntry:
    press_url: str = ""
    title: str = ""
    date_text: str = ""
    month: int = 0
    pdf_urls: list[str] = field(default_factory=list)


def _fetch_html(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; recall-research/1.0)"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    for enc in ["utf-8", "shift_jis", "euc-jp"]:
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


class _LinkParser(HTMLParser):
    """ページ内の全 <a href> を収集する。"""
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href = ""
        self._text = ""
        self._in_a = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "a":
            self._href = dict(attrs).get("href", "")
            self._text = ""
            self._in_a = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_a:
            self.links.append((self._href, self._text.strip()))
            self._in_a = False

    def handle_data(self, data: str) -> None:
        if self._in_a:
            self._text += data


def _collect_press_links(target_months: list[int]) -> list[RecallPressEntry]:
    """recall.html からプレスリリースページの URL を月別に収集する。"""
    print(f"[collect] recall.html を取得中...")
    html = _fetch_html(RECALL_INDEX_URL)
    parser = _LinkParser()
    parser.feed(html)

    press_pattern = re.compile(r"/report/press/jidosha\d+_hh_\d+\.html")
    entries: list[RecallPressEntry] = []
    for href, text in parser.links:
        if not press_pattern.search(href):
            continue
        full_url = MLIT_BASE + href if href.startswith("/") else href
        entries.append(RecallPressEntry(press_url=full_url, title=text))

    print(f"[collect] プレスリリース候補: {len(entries)} 件")
    return entries


def _enrich_with_pdfs(
    entries: list[RecallPressEntry],
    target_months: list[int],
) -> list[RecallPressEntry]:
    """各プレスリリースページから PDF URL・届出日を取得し、月フィルタを適用する。"""
    reiwa = TARGET_YEAR - REIWA_OFFSET
    month_patterns = [f"令和{reiwa}年{m}月" for m in target_months]

    result: list[RecallPressEntry] = []
    for i, entry in enumerate(entries):
        try:
            html = _fetch_html(entry.press_url)
        except Exception as e:
            print(f"  [WARN] {entry.press_url}: {e}")
            continue

        # 届出日を抽出
        date_m = re.search(r"令和\d+年\d+月\d+日", html)
        if not date_m:
            continue
        entry.date_text = date_m.group()

        # 月フィルタ
        matched_month = next(
            (m for m, pat in zip(target_months, month_patterns) if pat in entry.date_text),
            None,
        )
        if matched_month is None:
            continue
        entry.month = matched_month

        # PDF リンク収集
        pdf_parser = _LinkParser()
        pdf_parser.feed(html)
        for href, _ in pdf_parser.links:
            if href.endswith(".pdf"):
                url = MLIT_BASE + href if href.startswith("/") else href
                entry.pdf_urls.append(url)

        if entry.pdf_urls:
            print(f"  [{entry.date_text}] {entry.title[:40]} → PDF {len(entry.pdf_urls)} 件")
            result.append(entry)

        time.sleep(0.5)  # rate limit 対策

    return result


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# recall_id 生成
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _make_recall_id(date_text: str, press_url: str) -> str:
    """「令和8年1月28日」 + press URL の末尾番号 → 'r8-01-28-005649' 形式の ID を生成する。"""
    reiwa_m = re.search(r"令和(\d+)年(\d+)月(\d+)日", date_text)
    if reiwa_m:
        r, mo, d = reiwa_m.groups()
        date_part = f"r{r}-{int(mo):02d}-{int(d):02d}"
    else:
        date_part = "r0-00-00"

    num_m = re.search(r"_(\d+)\.html$", press_url)
    num_part = num_m.group(1) if num_m else "000000"
    return f"{date_part}-{num_part}"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1件分の収集処理
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _process_entry(entry: RecallPressEntry, aoai_client) -> list[str]:
    """1件のプレスリリースを収集・OCR・構造化して data/{recall_id}/ に保存する。

    まとめ届出（複数リコールが1PDFにまとまったもの）の場合は
    {recall_id}-001, {recall_id}-002 ... として個別に保存する。

    Returns:
        保存した recall_id のリスト（失敗時は空リスト）
    """
    recall_id = _make_recall_id(entry.date_text, entry.press_url)

    # 既存チェック：単件 or まとめ届出どちらでも既存があればスキップ
    existing = [
        d.name for d in DATA_DIR.iterdir()
        if d.is_dir() and (d.name == recall_id or d.name.startswith(f"{recall_id}-"))
        and (d / "raw.json").exists()
    ] if DATA_DIR.exists() else []
    if existing:
        print(f"  [SKIP] {recall_id} (既存: {len(existing)} 件)")
        return existing

    # 届出一覧表PDF（最初のPDF）を使う
    list_pdf_url = entry.pdf_urls[0]
    diagram_pdf_url = entry.pdf_urls[1] if len(entry.pdf_urls) > 1 else None

    try:
        pdf_path = fetch_pdf(list_pdf_url, recall_id)
        ocr_text = ocr_pdf(pdf_path, recall_id)
        metadata_list = extract_recall_metadata(ocr_text, aoai_client)
        if not metadata_list:
            print(f"  [ERROR] {recall_id}: Phase1 失敗")
            return []
    except Exception as e:
        print(f"  [ERROR] {recall_id}: {e}")
        return []

    saved_ids: list[str] = []

    if len(metadata_list) == 1:
        # 通常の単件リコール
        out_id = recall_id
        out_dir = DATA_DIR / out_id
        out_dir.mkdir(parents=True, exist_ok=True)
        raw = {
            "recall_id": out_id,
            "press_url": entry.press_url,
            "date_text": entry.date_text,
            "month": entry.month,
            "pdf_urls": entry.pdf_urls,
            "diagram_pdf_url": diagram_pdf_url,
            "metadata": metadata_list[0],
        }
        (out_dir / "raw.json").write_text(
            json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"  [OK] {out_id} → {out_dir / 'raw.json'}")
        saved_ids.append(out_id)
    else:
        # まとめ届出：複数件を個別IDで保存
        print(f"  [まとめ届出] {recall_id}: {len(metadata_list)} 件を個別に保存")
        for i, metadata in enumerate(metadata_list, start=1):
            out_id = f"{recall_id}-{i:03d}"
            out_dir = DATA_DIR / out_id
            out_dir.mkdir(parents=True, exist_ok=True)
            raw = {
                "recall_id": out_id,
                "parent_recall_id": recall_id,
                "press_url": entry.press_url,
                "date_text": entry.date_text,
                "month": entry.month,
                "pdf_urls": entry.pdf_urls,
                "diagram_pdf_url": None,  # まとめ届出に説明図はなし
                "metadata": metadata,
            }
            (out_dir / "raw.json").write_text(
                json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            notifier = metadata.get("notifier") or metadata.get("affected_vehicles", [{}])[0].get("make", "不明")
            print(f"    [{i:03d}] {out_id} ({notifier})")
            saved_ids.append(out_id)

    return saved_ids


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# メイン
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def collect(months: list[int], dry_run: bool = False) -> list[str]:
    """指定月のリコール届出を収集する。

    Args:
        months: 収集対象月リスト（例: [1, 2, 3]）
        dry_run: True の場合は URL 一覧のみ表示して処理しない

    Returns:
        収集した recall_id のリスト
    """
    press_entries = _collect_press_links(months)
    enriched = _enrich_with_pdfs(press_entries, months)

    print(f"\n[collect] 対象件数: {len(enriched)} 件")

    if dry_run:
        for e in enriched:
            rid = _make_recall_id(e.date_text, e.press_url)
            print(f"  {rid}  {e.date_text}  {e.title[:40]}")
            for url in e.pdf_urls:
                print(f"    {url}")
        return []

    aoai_client = build_aoai_client()
    collected_ids: list[str] = []
    for entry in enriched:
        ids = _process_entry(entry, aoai_client)
        collected_ids.extend(ids)
        time.sleep(1)

    print(f"\n[collect] 完了: {len(collected_ids)} recall_id 収集（プレスリリース {len(enriched)} 件）")
    return collected_ids


def main() -> None:
    parser = argparse.ArgumentParser(description="2026年1〜6月のリコール届出を一括収集")
    parser.add_argument("--month", type=int, choices=range(1, 7),
                        help="特定月のみ収集（省略時は1〜6月全件）")
    parser.add_argument("--dry-run", action="store_true",
                        help="URL 一覧のみ表示（ダウンロード・OCR しない）")
    args = parser.parse_args()

    months = [args.month] if args.month else TARGET_MONTHS
    collect(months, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
