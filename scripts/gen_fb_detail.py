#!/usr/bin/env python3
"""
専門家FBの詳細対照表を生成するスクリプト。
コメントがある場合（承認済みでも）、対象の仕様書/故障モード/トップ事象の内容を必ず表示する。
"""
import json
import os
import re
import sys
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
OUT_FILE = Path(__file__).parent.parent / "docs" / "fb_detail_20260904.md"

SEC_TITLES = {
    "1": "対象部品の特定",
    "2": "システム内での役割",
    "3": "構成・関連部品",
    "4": "作用荷重条件 / 入力仕様 / 入力条件 / 作用環境入力",
    "5": "強度・変形要件 / 出力仕様 / 機能・性能要件",
    "6": "正常保持状態 / 正常動作シーケンス",
    "7": "使用環境・要求条件",
}

VERDICT_ICON = {"approved": "✅", "needs_fix": "⚠️", "skipped": "—"}


def parse_spec_sections(spec_text: str) -> dict[str, str]:
    """spec_FTA.md から各セクションのテキストを抽出する。"""
    sections = {}
    for num in SEC_TITLES:
        m = re.search(
            rf"## {num}\..+?\n([\s\S]*?)(?=\n## |\Z)", spec_text
        )
        if m:
            content = m.group(1).replace(r"<!--[\s\S]*?-->", "").strip()
            # HTMLコメントを除去
            content = re.sub(r"<!--[\s\S]*?-->", "", content).strip()
            sections[num] = content
    return sections


def recall_ids_with_reviews() -> list[str]:
    ids = []
    for d in sorted(DATA_DIR.iterdir()):
        if not d.is_dir():
            continue
        if (d / "spec_review.json").exists() or (d / "failure_mode_review.json").exists():
            ids.append(d.name)
    return ids


def load_json(path: Path):
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def fmt_verdict(v: str) -> str:
    return VERDICT_ICON.get(v, v)


def section_title(num: str, spec_text: str) -> str:
    """仕様書から実際のセクション見出しを取得する。"""
    m = re.search(rf"## {num}\.(.+)", spec_text or "")
    if m:
        return m.group(1).strip()
    return SEC_TITLES.get(num, f"セクション{num}")


def render_recall(rid: str, lines: list[str]):
    base = DATA_DIR / rid
    raw = load_json(base / "raw.json")
    spec_text = (base / "spec_FTA.md").read_text(encoding="utf-8") if (base / "spec_FTA.md").exists() else ""
    spec_sections = parse_spec_sections(spec_text)
    label = load_json(base / "label.json")
    spec_rev = load_json(base / "spec_review.json")
    fm_rev = load_json(base / "failure_mode_review.json")
    te_rev = load_json(base / "top_event_review.json")

    if not raw:
        return

    meta = raw.get("metadata", {})
    vehicles = meta.get("affected_vehicles", [{}])
    make = vehicles[0].get("make", "") if vehicles else ""
    models = " / ".join(v.get("model", "") for v in vehicles[:4] if v.get("model"))
    vehicle_str = f"{make} {models}".strip() if make or models else ""
    manufacturer = meta.get("notifier", "")
    parts = label.get("target_component", []) if label else []

    # 全体判定
    spec_v = fmt_verdict(spec_rev.get("verdict", "")) if spec_rev else "—"
    fm_v = fmt_verdict(fm_rev.get("verdict", "")) if fm_rev else "—"
    te_v = "—"
    if te_rev and te_rev.get("event_reviews"):
        all_te = [r.get("verdict", "") for r in te_rev["event_reviews"]]
        te_v = fmt_verdict("needs_fix" if "needs_fix" in all_te else "approved")

    reviewer = (spec_rev or fm_rev or {}).get("reviewer", "")

    lines.append(f"## {rid}")
    lines.append(f"**車両**: {vehicle_str}  ")
    lines.append(f"**対象部品**: {', '.join(parts)}  ")
    if reviewer:
        lines.append(f"**レビュアー**: {reviewer}  ")
    lines.append(f"**判定**: 仕様書 {spec_v} / 故障モード {fm_v} / トップ事象 {te_v}")
    lines.append("")

    # ── リコール原文 ──────────────────────────────────────────────
    lines.append("### 📄 リコール原文（不具合内容・原因・結果）")
    lines.append("")
    defect = meta.get("defect_description", "")
    cause = meta.get("root_cause", "") or meta.get("defect_cause", "")
    consequences = meta.get("consequences", [])
    result_chain = " → ".join(consequences) if consequences else ""
    if defect:
        lines.append(f"**不具合の状況**: {defect}")
        lines.append("")
    if cause:
        lines.append(f"**原因**: {cause}")
        lines.append("")
    if result_chain:
        lines.append(f"**結果**: {result_chain}")
        lines.append("")

    # ── 仕様書 ──────────────────────────────────────────────────
    lines.append("### 🔧 仕様書出力 → FB")
    lines.append("")

    if spec_rev:
        overall_comment = (spec_rev.get("comment") or "").strip()
        section_revs = spec_rev.get("section_reviews", {})

        # 全体コメントがある場合は先に表示
        if overall_comment:
            lines.append(f"**全体FB ({spec_v})**: {overall_comment}")
            lines.append("")

        # セクション別: needs_fix OR コメントあり の場合は仕様書本文も表示
        any_section_shown = False
        for num in sorted(section_revs.keys(), key=lambda x: int(x)):
            sr = section_revs[num]
            sv = sr.get("verdict", "")
            sc = (sr.get("comment") or "").strip()
            corrected = (sr.get("corrected_text") or "").strip()
            show = (sv == "needs_fix") or bool(sc) or bool(corrected)
            if show:
                any_section_shown = True
                title = section_title(num, spec_text)
                content = spec_sections.get(num, "（仕様書なし）")
                lines.append(f"**セクション {num}「{title}」**")
                # AI出力（仕様書本文）を引用表示
                lines.append("*AI出力:*")
                for l in content.splitlines():
                    lines.append(f"> {l}" if l.strip() else ">")
                lines.append("")
                fb_icon = fmt_verdict(sv)
                if sc:
                    lines.append(f"**FB ({fb_icon})**: {sc}")
                else:
                    lines.append(f"**FB ({fb_icon})**: （コメントなし）")
                # 専門家修正テキストがあれば表示
                if corrected:
                    # corrected_textはセクションヘッダ込みのことがあるので除去
                    corrected_body = re.sub(r"^## \d+\..+\n", "", corrected).strip()
                    lines.append("")
                    lines.append("*専門家修正後:*")
                    for l in corrected_body.splitlines():
                        lines.append(f"> {l}" if l.strip() else ">")
                lines.append("")

        # 全体コメントがあるのにセクション別に何も表示されなかった場合→仕様書全体を表示
        if overall_comment and not any_section_shown:
            lines.append("**仕様書本文（全セクション）**:")
            lines.append("")
            for num in sorted(spec_sections.keys(), key=lambda x: int(x)):
                title = section_title(num, spec_text)
                content = spec_sections[num]
                lines.append(f"**{num}. {title}**")
                for l in content.splitlines():
                    lines.append(f"> {l}" if l.strip() else ">")
                lines.append("")

        if not overall_comment and not any_section_shown:
            lines.append("（承認済み・コメントなし）")
            lines.append("")
    else:
        lines.append("（レビューなし）")
        lines.append("")

    # ── 故障モード ────────────────────────────────────────────
    lines.append("### ⚡ 故障モード出力 → FB")
    lines.append("")

    if fm_rev:
        item_reviews = fm_rev.get("item_reviews", {})
        item_suggested = fm_rev.get("item_suggested", {})
        missing = fm_rev.get("missing_items", [])
        fm_comment = (fm_rev.get("comment") or "").strip()

        if item_reviews:
            # 専門家修正案があるかどうか確認
            has_suggested = any(
                (item_suggested.get(k) or "").strip() and (item_suggested.get(k) or "").strip() != k
                for k in item_reviews
            )
            if has_suggested:
                lines.append("| 故障モード（AI出力） | 判定 | 専門家修正案 |")
                lines.append("|---|---|---|")
                for fm_text, verdict in item_reviews.items():
                    suggested_fm = (item_suggested.get(fm_text) or "").strip()
                    if suggested_fm and suggested_fm != fm_text:
                        lines.append(f"| {fm_text} | {fmt_verdict(verdict)} | {suggested_fm} |")
                    else:
                        lines.append(f"| {fm_text} | {fmt_verdict(verdict)} | — |")
            else:
                lines.append("| 故障モード（AI出力） | 判定 |")
                lines.append("|---|---|")
                for fm_text, verdict in item_reviews.items():
                    lines.append(f"| {fm_text} | {fmt_verdict(verdict)} |")
            lines.append("")

        if missing:
            lines.append(f"**不足している故障モード**: {', '.join(missing)}")
            lines.append("")

        if fm_comment:
            lines.append(f"**FBコメント**: {fm_comment}")
            lines.append("")

        if not item_reviews and not fm_comment:
            lines.append("（承認済み・コメントなし）")
            lines.append("")
    else:
        lines.append("（レビューなし）")
        lines.append("")

    # ── トップ事象 ────────────────────────────────────────────
    lines.append("### 🏁 トップ事象出力 → FB")
    lines.append("")

    if te_rev:
        event_reviews = te_rev.get("event_reviews", [])
        any_comment = any((r.get("comment") or "").strip() or (r.get("suggested") or "").strip() for r in event_reviews)
        any_fix = any(r.get("verdict") == "needs_fix" for r in event_reviews)

        if event_reviews and (any_comment or any_fix):
            for er in event_reviews:
                te_text = er.get("top_event", "")
                ev = er.get("verdict", "")
                suggested = (er.get("suggested") or "").strip()
                ec = (er.get("comment") or "").strip()
                ev_icon = fmt_verdict(ev)
                lines.append(f"**{ev_icon} {te_text}**")
                if suggested:
                    lines.append(f"  → 修正案: {suggested}")
                if ec:
                    lines.append(f"  → FB: {ec}")
                lines.append("")
        elif event_reviews:
            # コメントなし・全承認→簡潔に
            te_texts = [er.get("top_event", "") for er in event_reviews]
            lines.append(f"（承認済み）{' / '.join(te_texts)}")
            lines.append("")
        else:
            lines.append("（レビューなし）")
            lines.append("")
    else:
        lines.append("（レビューなし）")
        lines.append("")

    lines.append("---")
    lines.append("")


def main():
    ids = recall_ids_with_reviews()
    print(f"{len(ids)} 件を処理します...")

    lines = []
    lines.append("# 専門家FBの詳細対照表（2026年9月4日分）")
    lines.append("")
    lines.append("各リコール案件について、**リコール原文（OCR抽出）→ AIの出力 → 専門家FB** を対照しています。")
    lines.append("コメントがある場合（承認済みでも）、対象の仕様書/故障モード/トップ事象の内容を表示しています。")
    lines.append("")
    lines.append("---")
    lines.append("")

    for rid in ids:
        print(f"  {rid} ...")
        render_recall(rid, lines)

    OUT_FILE.parent.mkdir(exist_ok=True)
    OUT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n完了: {OUT_FILE}")


if __name__ == "__main__":
    main()
