#!/usr/bin/env python3
"""
専門家が直接編集した内容（corrected_text / item_suggested / suggested）を
spec_FTA.md と label.json に上書き適用する。
"""
import json
import re
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"


def apply_spec_corrections(rid: str) -> list[str]:
    """spec_review.json の corrected_text を spec_FTA.md に適用する。"""
    base = DATA_DIR / rid
    review_path = base / "spec_review.json"
    spec_path = base / "spec_FTA.md"
    if not review_path.exists() or not spec_path.exists():
        return []

    review = json.load(open(review_path, encoding="utf-8"))
    spec_text = spec_path.read_text(encoding="utf-8")
    section_revs = review.get("section_reviews", {})

    changed = []
    for num, sr in section_revs.items():
        corrected = (sr.get("corrected_text") or "").strip()
        if not corrected:
            continue
        # ヘッダ行を除去して本文のみ取得
        corrected_body = re.sub(r"^## \d+\..+\n\n?", "", corrected).strip()

        # 対象セクションを正規表現で置換
        pattern = rf"(## {num}\.[^\n]+\n)([\s\S]*?)(?=\n## \d+\.|\Z)"
        match = re.search(pattern, spec_text)
        if not match:
            continue

        original_body = match.group(2).strip()
        if original_body == corrected_body:
            continue  # 変更なし

        new_section = match.group(1) + "\n" + corrected_body + "\n"
        spec_text = spec_text[:match.start()] + new_section + spec_text[match.end():]
        changed.append(f"  sec{num}")

    if changed:
        spec_path.write_text(spec_text, encoding="utf-8")

    return changed


def apply_label_corrections(rid: str) -> list[str]:
    """failure_mode_review の item_suggested と top_event_review の suggested を label.json に適用する。"""
    base = DATA_DIR / rid
    label_path = base / "label.json"
    fm_review_path = base / "failure_mode_review.json"
    te_review_path = base / "top_event_review.json"
    if not label_path.exists():
        return []

    label = json.load(open(label_path, encoding="utf-8"))
    changed = []

    # 故障モードの修正
    if fm_review_path.exists():
        fm_rev = json.load(open(fm_review_path, encoding="utf-8"))
        item_suggested = fm_rev.get("item_suggested", {})
        new_fms = []
        for fm in label.get("failure_modes", []):
            suggested = (item_suggested.get(fm) or "").strip()
            if suggested == "不要":
                changed.append(f"  FM削除: 「{fm}」")
            elif suggested and suggested != fm:
                new_fms.append(suggested)
                changed.append(f"  FM修正: 「{fm}」→「{suggested}」")
            else:
                new_fms.append(fm)
        label["failure_modes"] = new_fms

    # トップ事象の修正
    if te_review_path.exists():
        te_rev = json.load(open(te_review_path, encoding="utf-8"))
        new_tes = []
        for i, er in enumerate(te_rev.get("event_reviews", [])):
            suggested = (er.get("suggested") or "").strip()
            original = er.get("top_event", "")
            # label.json の対応するtop_eventを探して置換
            if i < len(label.get("top_event", [])):
                current = label["top_event"][i]
                if suggested == "不要":
                    changed.append(f"  TE削除: 「{current}」")
                elif suggested and suggested != current:
                    new_tes.append(suggested)
                    changed.append(f"  TE修正: 「{current}」→「{suggested}」")
                else:
                    new_tes.append(current)
            else:
                if suggested:
                    new_tes.append(suggested)
        if new_tes:
            label["top_event"] = new_tes

    if changed:
        with open(label_path, "w", encoding="utf-8") as f:
            json.dump(label, f, ensure_ascii=False, indent=2)
            f.write("\n")

    return changed


def main():
    total_spec = 0
    total_label = 0

    for d in sorted(DATA_DIR.iterdir()):
        if not d.is_dir():
            continue
        rid = d.name

        spec_changes = apply_spec_corrections(rid)
        label_changes = apply_label_corrections(rid)

        if spec_changes or label_changes:
            print(f"\n{rid}")
            if spec_changes:
                print(f"  [spec_FTA.md] {', '.join(spec_changes)}")
                total_spec += 1
            if label_changes:
                for c in label_changes:
                    print(c)
                total_label += 1

    print(f"\n完了: spec修正={total_spec}件, label修正={total_label}件")


if __name__ == "__main__":
    main()
