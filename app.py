"""
FTAベンチマーク GUI（Streamlit）

画面構成:
  左サイドバー : リコール選択（月タブ + チェックボックス）
  メインエリア :
    [データ収集] タブ  : 収集状況・実行ボタン
    [FTA生成]   タブ  : input.yaml 確認・生成ボタン
    [評価結果]  タブ  : スコアダッシュボード・詳細

実行:
  streamlit run benchmark/app.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv
import streamlit as st

# パス設定
BENCHMARK_ROOT = Path(__file__).parent
DATA_DIR = BENCHMARK_ROOT / "data"
SCRIPTS_DIR = BENCHMARK_ROOT / "scripts"

load_dotenv(BENCHMARK_ROOT / ".env")
FTA_SPEC_GENERATOR_ROOT = Path(os.environ.get(
    "FTA_SPEC_GENERATOR_ROOT",
    str(BENCHMARK_ROOT.parent / "fta-spec-generator"),
))

st.set_page_config(
    page_title="FTA ベンチマーク",
    page_icon="🌳",
    layout="wide",
)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ユーティリティ
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MONTH_LABELS = {1: "1月", 2: "2月", 3: "3月", 4: "4月", 5: "5月", 6: "6月"}


def _load_json(path: Path) -> dict | None:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def _all_recalls() -> list[dict]:
    """data/ 内の全リコール情報をまとめて返す。"""
    recalls = []
    if not DATA_DIR.exists():
        return recalls
    for d in sorted(DATA_DIR.iterdir()):
        if not d.is_dir():
            continue
        raw = _load_json(d / "raw.json")
        label = _load_json(d / "label.json")
        score = _load_json(d / "score.json")
        has_spec = (d / "spec_FTA.md").exists()
        has_input = (d / "input.yaml").exists()
        has_output = (d / "output.yaml").exists()

        meta = raw.get("metadata", {}) if raw else {}
        recalls.append({
            "recall_id": d.name,
            "date_text": raw.get("date_text", "") if raw else "",
            "month": raw.get("month", 0) if raw else 0,
            "manufacturer": meta.get("notifier", ""),
            "vehicle": (meta.get("affected_vehicles") or [{}])[0].get("model", ""),
            "defect_location": meta.get("defect_location", ""),
            "has_raw": raw is not None,
            "has_label": label is not None,
            "has_spec": has_spec,
            "has_input": has_input,
            "has_output": has_output,
            "has_score": score is not None,
            "score": score,
            "label": label,
        })
    return recalls


def _status_badge(ok: bool) -> str:
    return "✅" if ok else "⬜"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# サイドバー：リコール選択
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _sidebar(recalls: list[dict]) -> list[str]:
    """サイドバーでリコールをチェックボックス選択し、選択済み recall_id を返す。"""
    st.sidebar.title("📋 リコール選択")

    selected_ids: list[str] = []

    if not recalls:
        st.sidebar.info("データがありません。まず「データ収集」タブで収集してください。")
        return selected_ids

    # 月フィルタ
    months_present = sorted({r["month"] for r in recalls if r["month"] > 0})
    selected_months = st.sidebar.multiselect(
        "月フィルタ",
        options=months_present,
        default=months_present,
        format_func=lambda m: MONTH_LABELS.get(m, f"{m}月"),
    )

    # 全選択・全解除
    col1, col2 = st.sidebar.columns(2)
    select_all = col1.button("全選択", use_container_width=True)
    deselect_all = col2.button("全解除", use_container_width=True)

    if "checked" not in st.session_state:
        st.session_state.checked = {}

    filtered = [r for r in recalls if r["month"] in selected_months]

    if select_all:
        for r in filtered:
            st.session_state.checked[r["recall_id"]] = True
    if deselect_all:
        for r in filtered:
            st.session_state.checked[r["recall_id"]] = False

    st.sidebar.markdown("---")

    # 月ごとにグループ化して表示
    by_month: dict[int, list[dict]] = {}
    for r in filtered:
        by_month.setdefault(r["month"], []).append(r)

    for month in sorted(by_month):
        st.sidebar.markdown(f"**{MONTH_LABELS.get(month, f'{month}月')}**")
        for r in by_month[month]:
            rid = r["recall_id"]
            label = f"{r['manufacturer']} {r['vehicle']} ({r['defect_location'][:15] if r['defect_location'] else ''})"
            # パイプライン状況バッジ
            badge = (
                f"{_status_badge(r['has_raw'])}raw "
                f"{_status_badge(r['has_label'])}label "
                f"{_status_badge(r['has_spec'])}spec "
                f"{_status_badge(r['has_input'])}input "
                f"{_status_badge(r['has_output'])}FTA "
                f"{_status_badge(r['has_score'])}score"
            )
            checked = st.session_state.checked.get(rid, False)
            new_val = st.sidebar.checkbox(
                f"{label}\n`{badge}`",
                value=checked,
                key=f"cb_{rid}",
            )
            st.session_state.checked[rid] = new_val
            if new_val:
                selected_ids.append(rid)

    st.sidebar.markdown(f"---\n選択中: **{len(selected_ids)}** 件")
    return selected_ids


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# タブ 1: データ収集
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _tab_collect(selected_ids: list[str], recalls: list[dict]) -> None:
    st.header("データ収集")
    st.markdown("国交省リコール届出書を収集し、raw.json・label.json を生成します。")

    col1, col2 = st.columns(2)
    target_month = col1.selectbox(
        "収集対象月",
        options=[0] + list(range(1, 7)),
        format_func=lambda m: "全件（1〜6月）" if m == 0 else MONTH_LABELS[m],
    )
    dry_run = col2.checkbox("ドライラン（URL確認のみ）", value=True)

    if st.button("🔍 リコール収集を実行", type="primary"):
        cmd = [sys.executable, str(SCRIPTS_DIR / "collect.py")]
        if target_month > 0:
            cmd += ["--month", str(target_month)]
        if dry_run:
            cmd += ["--dry-run"]

        with st.spinner("収集中..."):
            result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(BENCHMARK_ROOT.parent))
        st.code(result.stdout + result.stderr)

    st.markdown("---")
    st.subheader("収集済みラベル抽出")
    st.markdown("raw.json から label.json（FTA評価用正解ラベル）を生成します。")

    target_ids = selected_ids if selected_ids else [r["recall_id"] for r in recalls if r["has_raw"] and not r["has_label"]]
    st.caption(f"対象: {len(target_ids)} 件")

    if st.button("📝 ラベル抽出を実行"):
        cmd = [sys.executable, str(SCRIPTS_DIR / "extract_label.py")]
        with st.spinner("ラベル抽出中..."):
            result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(BENCHMARK_ROOT.parent))
        st.code(result.stdout + result.stderr)

    # 収集状況テーブル
    st.markdown("---")
    st.subheader("収集状況")
    if recalls:
        rows = []
        for r in recalls:
            rows.append({
                "recall_id": r["recall_id"],
                "日付": r["date_text"],
                "届出者": r["manufacturer"],
                "車種": r["vehicle"],
                "不具合部位": r["defect_location"],
                "raw": _status_badge(r["has_raw"]),
                "label": _status_badge(r["has_label"]),
                "spec": _status_badge(r["has_spec"]),
                "input": _status_badge(r["has_input"]),
                "FTA": _status_badge(r["has_output"]),
                "score": _status_badge(r["has_score"]),
            })
        st.dataframe(rows, use_container_width=True, height=400)
    else:
        st.info("データがありません。収集を実行してください。")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# タブ 2: 仕様書 & FTA生成
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _tab_generate(selected_ids: list[str], recalls: list[dict]) -> None:
    st.header("仕様書 & FTA生成")

    # 仕様書生成
    st.subheader("① 仕様書生成（spec_FTA.md）")
    st.markdown("選択したリコールに対して `agent.py` を実行し、部品正常仕様書を生成します。")

    targets_spec = [r for r in recalls if r["recall_id"] in selected_ids and r["has_raw"] and not r["has_spec"]]
    st.caption(f"未生成: {len(targets_spec)} 件")

    if st.button("📄 仕様書を生成", disabled=len(targets_spec) == 0):
        for r in targets_spec:
            rid = r["recall_id"]
            raw = _load_json(DATA_DIR / rid / "raw.json") or {}
            diagram_url = raw.get("diagram_pdf_url")
            raw_path = DATA_DIR / rid / "raw.json"
            diagram_arg = []

            # 改善箇所説明図がある場合はダウンロード
            if diagram_url:
                diagram_path = DATA_DIR / rid / "diagram.pdf"
                if not diagram_path.exists():
                    import urllib.request
                    try:
                        urllib.request.urlretrieve(diagram_url, diagram_path)
                    except Exception:
                        pass
                if diagram_path.exists():
                    diagram_arg = ["--diagram", str(diagram_path)]

            cmd = [
                sys.executable,
                str(FTA_SPEC_GENERATOR_ROOT / "scripts" / "agent.py"),
                "--raw", str(raw_path),
                "--id", f"benchmark/{rid}",
                *diagram_arg,
            ]
            with st.spinner(f"{rid} の仕様書を生成中..."):
                result = subprocess.run(cmd, capture_output=True, text=True,
                                        cwd=str(BENCHMARK_ROOT.parent))
            # spec_FTA.md を benchmark/data/{rid}/ にコピー
            src = FTA_SPEC_GENERATOR_ROOT / "dataset" / "specs" / f"benchmark/{rid}" / "spec_FTA.md"
            dst = DATA_DIR / rid / "spec_FTA.md"
            if src.exists():
                dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
            st.write(f"✅ {rid}" if dst.exists() else f"❌ {rid}")

    st.markdown("---")
    st.subheader("② input.yaml 生成")
    st.markdown("spec_FTA.md + label.json から FTAエージェント用の input.yaml を生成します。")

    targets_input = [r for r in recalls if r["recall_id"] in selected_ids and r["has_spec"] and r["has_label"]
                     and not (DATA_DIR / r["recall_id"] / "input.yaml").exists()]
    st.caption(f"未生成: {len(targets_input)} 件")

    if st.button("📋 input.yaml を生成", disabled=len(targets_input) == 0):
        cmd = [sys.executable, str(SCRIPTS_DIR / "convert_input.py")]
        with st.spinner("input.yaml 生成中..."):
            result = subprocess.run(cmd, capture_output=True, text=True,
                                    cwd=str(BENCHMARK_ROOT.parent))
        st.code(result.stdout + result.stderr)

    st.markdown("---")
    st.subheader("③ FTA生成（output.yaml）")
    st.markdown(
        "FTA生成エージェント（`fta-expert` skill）は `pj-fta-agent-repo` で実行してください。\n\n"
        "生成後、`output.yaml` をそれぞれの `benchmark/data/{recall_id}/` に配置してください。"
    )

    # 選択中リコールの input.yaml 内容を表示
    if selected_ids:
        selected_recall = st.selectbox("確認するリコール", options=selected_ids)
        spec_path = DATA_DIR / selected_recall / "spec_FTA.md"
        if spec_path.exists():
            with st.expander("spec_FTA.md を表示"):
                st.markdown(spec_path.read_text(encoding="utf-8"))
        input_path = DATA_DIR / selected_recall / "input.yaml"
        if input_path.exists():
            with st.expander("input.yaml を表示"):
                st.code(input_path.read_text(encoding="utf-8"), language="yaml")
        output_path = DATA_DIR / selected_recall / "output.yaml"
        if output_path.exists():
            with st.expander("output.yaml を表示"):
                st.code(output_path.read_text(encoding="utf-8"), language="yaml")
        else:
            st.info(f"`benchmark/data/{selected_recall}/output.yaml` を配置してください。")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# タブ 3: 評価結果
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _tab_results(selected_ids: list[str], recalls: list[dict]) -> None:
    st.header("評価結果")

    # 評価実行
    targets_judge = [r for r in recalls if r["recall_id"] in selected_ids and r["has_output"] and r["has_label"]]
    col1, col2 = st.columns([3, 1])
    col1.caption(f"評価可能: {len(targets_judge)} 件（output.yaml と label.json が揃ったもの）")
    force = col2.checkbox("スコアを再計算")

    if st.button("⚖️ LLM as judge 評価を実行", disabled=len(targets_judge) == 0):
        cmd = [sys.executable, str(SCRIPTS_DIR / "judge.py")]
        if force:
            cmd += ["--force"]
        with st.spinner("評価中..."):
            result = subprocess.run(cmd, capture_output=True, text=True,
                                    cwd=str(BENCHMARK_ROOT.parent))
        st.code(result.stdout + result.stderr)

    st.markdown("---")

    # スコアサマリー
    scored = [r for r in recalls if r["has_score"] and (not selected_ids or r["recall_id"] in selected_ids)]
    if not scored:
        st.info("評価結果がありません。output.yaml を配置し、評価を実行してください。")
        return

    # 集計
    avg_comp = sum(r["score"]["component_match"] for r in scored) / len(scored)
    avg_fail = sum(r["score"]["failure_mode_match"] for r in scored) / len(scored)
    avg_top  = sum(r["score"]["top_event_match"] for r in scored) / len(scored)
    avg_all  = sum(r["score"]["overall"] for r in scored) / len(scored)

    st.subheader("📊 集計スコア")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("部品一致", f"{avg_comp:.2f}")
    c2.metric("故障モード一致", f"{avg_fail:.2f}")
    c3.metric("トップ事象一致", f"{avg_top:.2f}")
    c4.metric("Overall", f"{avg_all:.2f}")

    # 個別スコアテーブル
    st.subheader("個別スコア")
    rows = []
    for r in scored:
        s = r["score"]
        rows.append({
            "recall_id": r["recall_id"],
            "届出者": r["manufacturer"],
            "車種": r["vehicle"],
            "部品一致": s.get("component_match", "-"),
            "故障モード一致": s.get("failure_mode_match", "-"),
            "トップ事象一致": s.get("top_event_match", "-"),
            "Overall": s.get("overall", "-"),
        })
    st.dataframe(rows, use_container_width=True)

    # 詳細表示
    st.subheader("詳細")
    selected_detail = st.selectbox(
        "詳細を見るリコール",
        options=[r["recall_id"] for r in scored],
        key="detail_select",
    )
    detail_recall = next((r for r in scored if r["recall_id"] == selected_detail), None)
    if detail_recall:
        col_a, col_b = st.columns(2)

        with col_a:
            st.markdown("**正解ラベル**")
            if detail_recall["label"]:
                label = detail_recall["label"]
                st.markdown(f"**部品**: {', '.join(label.get('target_component', []))}")
                st.markdown(f"**故障モード**: {', '.join(label.get('failure_modes', []))}")
                st.markdown(f"**トップ事象**: {', '.join(label.get('top_event', []))}")
                st.markdown("**因果連鎖**:")
                chain = label.get("causal_chain", [])
                if chain:
                    st.markdown(" → ".join(chain))

        with col_b:
            st.markdown("**評価スコア & 根拠**")
            s = detail_recall["score"]
            st.metric("部品一致", f"{s.get('component_match', 0):.2f}")
            st.metric("故障モード一致", f"{s.get('failure_mode_match', 0):.2f}")
            st.metric("トップ事象一致", f"{s.get('top_event_match', 0):.2f}")
            reasoning = s.get("reasoning", {})
            if reasoning:
                st.markdown("**判定根拠**")
                for key, val in reasoning.items():
                    st.markdown(f"- **{key}**: {val}")

        # FTA output
        output_path = DATA_DIR / selected_detail / "output.yaml"
        if output_path.exists():
            with st.expander("生成FTA（output.yaml）"):
                st.code(output_path.read_text(encoding="utf-8"), language="yaml")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# メイン
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def main() -> None:
    st.title("🌳 FTA ベンチマークシステム")
    st.caption("2026年1〜6月 国交省リコール届出 × FTA生成エージェント評価")

    recalls = _all_recalls()
    selected_ids = _sidebar(recalls)

    tab1, tab2, tab3 = st.tabs(["📥 データ収集", "⚙️ 仕様書 & FTA生成", "📊 評価結果"])

    with tab1:
        _tab_collect(selected_ids, recalls)
    with tab2:
        _tab_generate(selected_ids, recalls)
    with tab3:
        _tab_results(selected_ids, recalls)


if __name__ == "__main__":
    main()
