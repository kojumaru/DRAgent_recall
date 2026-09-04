"""
ベンチマークビューア用 FastAPI バックエンド

実行:
  cd benchmark/viewer/backend
  uvicorn main:app --reload --port 8001
"""

from __future__ import annotations

import os
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

import io
import json
import yaml
import zipfile
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv(Path(__file__).parent.parent.parent / ".env")

DATA_DIR = Path(os.environ.get("DATA_DIR", str(Path(__file__).parent.parent.parent / "data")))
PDF_DIR = Path(os.environ.get(
    "FTA_SPEC_GENERATOR_ROOT",
    str(Path(__file__).parent.parent.parent.parent / "fta-spec-generator"),
)) / "dataset" / "pdfs"

FTA_AGENT_ROOT = Path(os.environ.get(
    "FTA_AGENT_ROOT",
    str(Path(__file__).resolve().parent.parent.parent.parent / "fta-agent"),
))
BMK_CASES = FTA_AGENT_ROOT / "cases"

SPEC_GEN_ROOT = Path(os.environ.get(
    "FTA_SPEC_GENERATOR_ROOT",
    str(Path(__file__).parent.parent.parent.parent / "fta-spec-generator"),
))
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "/opt/homebrew/bin/claude")

# skill-improve ジョブ管理（in-memory）
_skill_improve_jobs: dict[str, dict] = {}  # recall_id → {status, output, started_at}
BMK_SESSIONS = FTA_AGENT_ROOT / "sessions"


def _bmk_sessions_for_case(case_id: str) -> list[Path]:
    """指定ケースIDに紐づくセッションディレクトリ一覧（更新時刻降順）。"""
    result = []
    if not BMK_SESSIONS.exists():
        return result
    for s in BMK_SESSIONS.iterdir():
        if not s.is_dir():
            continue
        session_md = s / "session.md"
        if session_md.exists() and case_id in session_md.read_text("utf-8"):
            result.append(s)
    return sorted(result, key=lambda p: p.stat().st_mtime, reverse=True)


def _bmk_latest_round(session: Path) -> Path | None:
    """セッション内の最新 ROUND-#### ディレクトリ（tree.yaml 有り）。"""
    rounds = sorted(
        [r for r in session.iterdir() if r.is_dir() and r.name.startswith("ROUND-")],
        reverse=True,
    )
    for r in rounds:
        if (r / "tree.yaml").exists():
            return r
    return None


def _bmk_latest_round_any(case_id: str) -> Path | None:
    """全セッション中で最新の ROUND-#### （tree.yaml あり）。"""
    for s in _bmk_sessions_for_case(case_id):
        r = _bmk_latest_round(s)
        if r:
            return r
    return None


def _coverage_to_per_item(cov: dict) -> dict:
    """recall_coverage.json → PerItemScore 形式。新旧両フォーマット対応。"""

    def _score(entry: dict) -> int:
        s = entry.get("llm_score")
        if s is not None:
            return max(1, min(5, int(s)))
        return 4 if entry.get("covered") else 2

    fm = [
        {"item": e.get("mode", ""), "score": _score(e)}
        for e in cov.get("failure_modes", [])
        if e.get("mode")
    ]
    cc = [
        {"item": e.get("step", ""), "score": _score(e)}
        for e in cov.get("causal_chain_detail", [])
        if e.get("step") and not e.get("skipped")
    ]
    return {
        "recall_id": cov.get("recall_id", ""),
        "failure_modes": fm,
        "causal_chain": cc,
    }

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _nested_to_flat(node, parent_id: str | None, step: int, order_index: int, counter: list[int]) -> list[dict]:
    """nested child YAML → flat node list (parent_id 参照形式)"""
    counter[0] += 1
    node_id = str(counter[0])
    flat = {
        "id": node_id,
        "label": node.get("label", ""),
        "label_detail": node.get("label_detail") or None,
        "parent_id": parent_id,
        "step": step,
        "order_index": order_index,
        "component": node.get("component") or None,
        "type": node.get("type", "event"),
        "sub_type": node.get("sub_type", "basic"),
    }
    result = [flat]

    child = node.get("child")
    if child:
        if isinstance(child, dict):
            child = [child]
        for i, c in enumerate(child):
            result.extend(_nested_to_flat(c, parent_id=node_id, step=step + 1, order_index=i, counter=counter))

    return result


@app.get("/api/recalls")
def list_recalls():
    recalls = []
    for d in sorted(DATA_DIR.iterdir()):
        if not d.is_dir():
            continue
        if not (d / "raw.json").exists():
            continue
        raw = json.loads((d / "raw.json").read_text("utf-8"))
        meta = raw.get("metadata", {})
        notifier = meta.get("notifier", "")
        vehicles = meta.get("affected_vehicles", [])
        vehicle_name = vehicles[0].get("model", "") if vehicles else ""
        spec_review_improved = False
        if (d / "spec_review.json").exists():
            sr = json.loads((d / "spec_review.json").read_text("utf-8"))
            spec_review_improved = bool(sr.get("skill_improved_at"))
        recalls.append({
            "id": d.name,
            "notifier": notifier,
            "vehicle": vehicle_name,
            "defect_location": meta.get("defect_location", ""),
            "notification_date": meta.get("notification_date", raw.get("date_text", "")),
            "has_diagram_pdf": bool(raw.get("diagram_pdf_url")),
            "has_review": (d / "review.json").exists(),
            "has_spec": (d / "spec_FTA.md").exists(),
            "has_label": (d / "label.json").exists(),
            "has_input": (d / "input.yaml").exists(),
            "has_fta": (d / "output.yaml").exists() or any(d.glob("output_*.yaml")),
            "fta_count": len([f for f in [d / "output.yaml"] + list(d.glob("output_*.yaml")) if f.exists()]),
            "has_spec_review": (d / "spec_review.json").exists(),
            "spec_review_improved": spec_review_improved,
            "has_diagram_masked": (d / "diagram_masked.png").exists(),
            "has_diagram_original": (d / "diagram_original.png").exists(),
            "has_top_event_review": (d / "top_event_review.json").exists(),
            "has_failure_mode_review": (d / "failure_mode_review.json").exists(),
        })
    return recalls


REVIEW_FILES = [
    "review.json",
    "spec_review.json",
    "failure_mode_review.json",
    "top_event_review.json",
    "expert_reviews.json",
    "skill_feedback.json",
]


@app.get("/api/export/reviews")
def export_reviews():
    """レビュー済みデータを ZIP にまとめてダウンロードする。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for d in sorted(DATA_DIR.iterdir()):
            if not d.is_dir() or not (d / "raw.json").exists():
                continue
            for fname in REVIEW_FILES:
                p = d / fname
                if p.exists():
                    zf.write(p, arcname=f"{d.name}/{fname}")
    buf.seek(0)
    filename = f"fta_reviews_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.get("/api/recalls/{recall_id}")
def get_recall(recall_id: str):
    base = DATA_DIR / recall_id
    if not base.exists():
        raise HTTPException(404, "not found")

    result: dict = {}

    if (base / "raw.json").exists():
        result["raw"] = json.loads((base / "raw.json").read_text("utf-8"))
    if (base / "label.json").exists():
        result["label"] = json.loads((base / "label.json").read_text("utf-8"))
    if (base / "spec_FTA.md").exists():
        result["spec"] = (base / "spec_FTA.md").read_text("utf-8")
    if (base / "score.json").exists():
        result["score"] = json.loads((base / "score.json").read_text("utf-8"))

    return result


@app.get("/api/recalls/{recall_id}/diagram_masked")
def get_recall_diagram_masked(recall_id: str):
    p = DATA_DIR / recall_id / "diagram_masked.png"
    if p.exists():
        return FileResponse(p, media_type="image/png")
    raise HTTPException(404, "diagram_masked.png not found")


@app.get("/api/recalls/{recall_id}/diagram_original")
def get_recall_diagram_original(recall_id: str):
    p = DATA_DIR / recall_id / "diagram_original.png"
    if p.exists():
        return FileResponse(p, media_type="image/png")
    raise HTTPException(404, "diagram_original.png not found")


@app.get("/api/recalls/{recall_id}/pdf")
def get_pdf(recall_id: str):
    from fastapi.responses import RedirectResponse
    # data/{recall_id}/recall.pdf を優先
    local_pdf = DATA_DIR / recall_id / "recall.pdf"
    if local_pdf.exists():
        return FileResponse(local_pdf, media_type="application/pdf")
    # 旧来の PDF_DIR からも探す
    raw_path = DATA_DIR / recall_id / "raw.json"
    raw = json.loads(raw_path.read_text("utf-8")) if raw_path.exists() else {}
    ocr_id = raw.get("parent_recall_id", recall_id)
    pdf_path = PDF_DIR / f"{ocr_id}.pdf"
    if pdf_path.exists():
        return FileResponse(pdf_path, media_type="application/pdf")
    # フォールバック: pdf_urls[0] にリダイレクト
    pdf_urls = raw.get("pdf_urls") or []
    if pdf_urls:
        return RedirectResponse(url=pdf_urls[0])
    raise HTTPException(404, "PDF not found")


@app.get("/api/recalls/{recall_id}/diagram")
def get_diagram(recall_id: str):
    """部品図PDFを返す。ローカルキャッシュがあればそれを、なければダウンロードしてキャッシュ。"""
    import urllib.request
    from fastapi.responses import RedirectResponse

    raw_path = DATA_DIR / recall_id / "raw.json"
    if not raw_path.exists():
        raise HTTPException(404, "raw.json not found")
    raw = json.loads(raw_path.read_text("utf-8"))
    diagram_url = raw.get("diagram_pdf_url")
    if not diagram_url:
        raise HTTPException(404, "diagram_pdf_url not set in raw.json")

    # ローカルキャッシュを確認
    cached = PDF_DIR / f"{recall_id}_diagram.pdf"
    if not cached.exists():
        try:
            urllib.request.urlretrieve(diagram_url, cached)
        except Exception:
            return RedirectResponse(url=diagram_url)

    return FileResponse(cached, media_type="application/pdf")


@app.get("/api/recalls/{recall_id}/fta")
def get_fta(recall_id: str):
    output_path = DATA_DIR / recall_id / "output.yaml"
    if not output_path.exists():
        raise HTTPException(404, "output.yaml not found")

    data = yaml.safe_load(output_path.read_text("utf-8"))
    raw_nodes = data.get("nodes", [])
    counter = [0]
    flat_nodes = []
    for i, node in enumerate(raw_nodes):
        flat_nodes.extend(_nested_to_flat(node, parent_id=None, step=0, order_index=i, counter=counter))

    input_path = DATA_DIR / recall_id / "input.yaml"
    input_data = yaml.safe_load(input_path.read_text("utf-8")) if input_path.exists() else {}

    return {
        "tree_id": data.get("tree_id", recall_id),
        "product_name": input_data.get("product_name", data.get("product_name", "")),
        "purpose": input_data.get("purpose", data.get("purpose", "")),
        "top_event": input_data.get("top_event", ""),
        "components": input_data.get("components", data.get("components", [])),
        "functions": input_data.get("functions") or data.get("functions") or [],
        "nodes": flat_nodes,
    }



@app.get("/api/recalls/{recall_id}/review")
def get_review(recall_id: str):
    """専門家レビュー結果を返す。未レビューなら null を返す（404にしない）。"""
    path = DATA_DIR / recall_id / "review.json"
    if not path.exists():
        return None
    return json.loads(path.read_text("utf-8"))


class ReviewItemCheck(BaseModel):
    """1項目分の見逃しフラグ訂正（"false_negative" = 自動判定の誤り）。"""
    key: str
    status: str


class ReviewSubmission(BaseModel):
    """専門家レビューの保存リクエストボディ。"""
    reviewer: str
    verdict: str  # "good" | "needs_fix"
    comment: str = ""
    item_checks: dict[str, str] = {}


@app.post("/api/recalls/{recall_id}/review")
def save_review(recall_id: str, body: ReviewSubmission):
    """専門家レビュー結果を review.json に保存する。"""
    base = DATA_DIR / recall_id
    if not base.exists():
        raise HTTPException(404, "recall not found")
    if not body.reviewer.strip():
        raise HTTPException(400, "reviewer は必須です")

    review = {
        "reviewer": body.reviewer,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "verdict": body.verdict,
        "comment": body.comment,
        "item_checks": body.item_checks,
    }
    (base / "review.json").write_text(
        json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return review


# ---------------------------------------------------------------------------
# 項目別スコア（LLM per-item judge）
# ---------------------------------------------------------------------------

@app.get("/api/recalls/{recall_id}/per_item_score")
def get_per_item_score(recall_id: str):
    """LLM の項目別スコア（per_item_score.json）を返す。未計算なら 404。"""
    path = DATA_DIR / recall_id / "per_item_score.json"
    if not path.exists():
        raise HTTPException(404, "per_item_score.json not found（judge.py --per-item を実行してください）")
    return json.loads(path.read_text("utf-8"))


# ---------------------------------------------------------------------------
# 専門家評価（5段階、複数人）
# ---------------------------------------------------------------------------

class ExpertScoreItem(BaseModel):
    item: str
    score: int  # 1〜5


class ExpertReviewSubmission(BaseModel):
    reviewer: str
    failure_modes: list[ExpertScoreItem] = []


@app.get("/api/recalls/{recall_id}/expert_reviews")
def get_expert_reviews(recall_id: str):
    """全専門家のレビューリストを返す（expert_reviews.json）。"""
    path = DATA_DIR / recall_id / "expert_reviews.json"
    if not path.exists():
        return []
    return json.loads(path.read_text("utf-8"))


# ---------------------------------------------------------------------------
# 仕様書レビュー（spec_review.json）
# ---------------------------------------------------------------------------

class SpecSectionReview(BaseModel):
    verdict: str  # "approved" | "needs_fix" | "skipped"
    comment: str = ""
    corrected_text: str = ""

class SpecReviewSubmission(BaseModel):
    reviewer: str
    verdict: str  # "approved" | "needs_fix" | "skipped"
    comment: str = ""
    section_reviews: dict[str, SpecSectionReview] = {}  # key: "1"〜"7"

@app.get("/api/recalls/{recall_id}/spec_review")
def get_spec_review(recall_id: str):
    """仕様書レビュー結果を返す。未レビューなら null。"""
    path = DATA_DIR / recall_id / "spec_review.json"
    if not path.exists():
        return None
    return json.loads(path.read_text("utf-8"))

@app.post("/api/recalls/{recall_id}/spec_review")
def save_spec_review(recall_id: str, body: SpecReviewSubmission):
    """仕様書レビュー結果を spec_review.json に保存する。"""
    base = DATA_DIR / recall_id
    if not base.exists():
        raise HTTPException(404, "recall not found")
    if not body.reviewer.strip():
        raise HTTPException(400, "reviewer は必須です")

    review = {
        "reviewer": body.reviewer,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "verdict": body.verdict,
        "comment": body.comment,
        "section_reviews": {k: v.model_dump() for k, v in body.section_reviews.items()},
    }
    (base / "spec_review.json").write_text(
        json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return review


@app.post("/api/recalls/{recall_id}/spec_review/mark_improved")
def mark_spec_review_improved(recall_id: str):
    """spec_review.json に skill_improved_at タイムスタンプを記録する。"""
    path = DATA_DIR / recall_id / "spec_review.json"
    if not path.exists():
        raise HTTPException(404, "spec_review.json not found")
    review = json.loads(path.read_text("utf-8"))
    review["skill_improved_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8")
    return review


# ---------------------------------------------------------------------------
# skill-improve 実行エンドポイント
# ---------------------------------------------------------------------------

def _run_skill_improve(recall_id: str, job_id: str) -> None:
    """バックグラウンドスレッドで claude -p "/skill-improve {recall_id}" を実行する。"""
    try:
        env = os.environ.copy()
        env.pop("CLAUDECODE", None)  # ネストしたClaudeセッション禁止を回避
        result = subprocess.run(
            [CLAUDE_BIN, "-p", f"/skill-improve {recall_id}"],
            cwd=str(SPEC_GEN_ROOT),
            capture_output=True,
            text=True,
            timeout=600,
            env=env,
        )
        output = result.stdout + result.stderr
        if result.returncode == 0:
            _skill_improve_jobs[recall_id] = {
                "job_id": job_id,
                "status": "done",
                "output": output,
                "finished_at": datetime.now(timezone.utc).isoformat(),
            }
            # spec_review.json に skill_improved_at を自動記録
            path = DATA_DIR / recall_id / "spec_review.json"
            if path.exists():
                review = json.loads(path.read_text("utf-8"))
                review["skill_improved_at"] = datetime.now(timezone.utc).isoformat()
                path.write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            _skill_improve_jobs[recall_id] = {
                "job_id": job_id,
                "status": "error",
                "output": output,
                "finished_at": datetime.now(timezone.utc).isoformat(),
            }
    except subprocess.TimeoutExpired:
        _skill_improve_jobs[recall_id] = {
            "job_id": job_id, "status": "error", "output": "タイムアウト（10分）",
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        _skill_improve_jobs[recall_id] = {
            "job_id": job_id, "status": "error", "output": str(e),
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }


@app.post("/api/recalls/{recall_id}/skill_improve")
def start_skill_improve(recall_id: str):
    """skill-improve をバックグラウンドで実行開始する。"""
    if not (DATA_DIR / recall_id).exists():
        raise HTTPException(404, "recall not found")
    existing = _skill_improve_jobs.get(recall_id, {})
    if existing.get("status") == "running":
        return existing  # すでに実行中
    job_id = str(uuid.uuid4())[:8]
    job = {"job_id": job_id, "status": "running", "output": "", "started_at": datetime.now(timezone.utc).isoformat()}
    _skill_improve_jobs[recall_id] = job
    threading.Thread(target=_run_skill_improve, args=(recall_id, job_id), daemon=True).start()
    return job


@app.get("/api/recalls/{recall_id}/skill_improve")
def get_skill_improve_status(recall_id: str):
    """skill-improve の実行状況を返す。未実行なら null。"""
    return _skill_improve_jobs.get(recall_id)


# ---------------------------------------------------------------------------
# スキル改善フィードバック（skill_feedback.json）
# ---------------------------------------------------------------------------

class SkillFeedbackSubmission(BaseModel):
    reviewer: str
    category: str  # "source_access" | "source_priority" | "instruction" | "format" | "coverage"
    description: str
    suggestion: str = ""

@app.get("/api/recalls/{recall_id}/skill_feedback")
def get_skill_feedback(recall_id: str):
    """スキル改善フィードバック一覧を返す。"""
    path = DATA_DIR / recall_id / "skill_feedback.json"
    if not path.exists():
        return []
    return json.loads(path.read_text("utf-8"))

@app.post("/api/recalls/{recall_id}/skill_feedback")
def save_skill_feedback(recall_id: str, body: SkillFeedbackSubmission):
    """スキル改善フィードバックを skill_feedback.json に追記する。"""
    base = DATA_DIR / recall_id
    if not base.exists():
        raise HTTPException(404, "recall not found")
    if not body.reviewer.strip():
        raise HTTPException(400, "reviewer は必須です")

    path = base / "skill_feedback.json"
    feedbacks: list[dict] = json.loads(path.read_text("utf-8")) if path.exists() else []

    entry = {
        "reviewer": body.reviewer,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "category": body.category,
        "description": body.description,
        "suggestion": body.suggestion,
        "recall_id": recall_id,
    }
    feedbacks.append(entry)
    path.write_text(json.dumps(feedbacks, ensure_ascii=False, indent=2), encoding="utf-8")
    return entry


# ---------------------------------------------------------------------------
# 故障モードレビュー
# ---------------------------------------------------------------------------

class FailureModeReviewSubmission(BaseModel):
    reviewer: str
    verdict: str  # "approved" | "needs_fix"
    item_reviews: dict[str, str] = {}   # {mode: "approved"|"needs_fix"}
    item_suggested: dict[str, str] = {}  # {mode: "修正後テキスト"}
    missing_items: list[str] = []
    comment: str = ""


def _save_json_to(path: Path, data: dict) -> dict:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


@app.get("/api/recalls/{recall_id}/failure_mode_review")
def get_failure_mode_review(recall_id: str):
    path = DATA_DIR / recall_id / "failure_mode_review.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else None


@app.post("/api/recalls/{recall_id}/failure_mode_review")
def save_failure_mode_review(recall_id: str, body: FailureModeReviewSubmission):
    base = DATA_DIR / recall_id
    if not base.exists(): raise HTTPException(404, "recall not found")
    if not body.reviewer.strip(): raise HTTPException(400, "reviewer は必須です")
    return _save_json_to(base / "failure_mode_review.json", {
        "reviewer": body.reviewer,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "verdict": body.verdict,
        "item_reviews": body.item_reviews,
        "item_suggested": body.item_suggested,
        "missing_items": body.missing_items,
        "comment": body.comment,
    })


# ---------------------------------------------------------------------------
# トップ事象レビュー
# ---------------------------------------------------------------------------

class TopEventEventReview(BaseModel):
    top_event: str
    verdict: str  # "approved" | "needs_fix"
    suggested: str = ""
    comment: str = ""

class TopEventReviewSubmission(BaseModel):
    reviewer: str
    event_reviews: list[TopEventEventReview]


def _migrate_top_event_review(data: dict) -> dict:
    """旧フォーマット（verdict/suggested_top_event）を新フォーマットに変換する。"""
    if "event_reviews" in data:
        return data
    # 旧フォーマット: top_event が不明なので空文字で保持
    return {
        "reviewer": data.get("reviewer", ""),
        "reviewed_at": data.get("reviewed_at", ""),
        "event_reviews": [{
            "top_event": data.get("suggested_top_event", ""),
            "verdict": data.get("verdict", "approved"),
            "suggested": data.get("suggested_top_event", ""),
            "comment": data.get("comment", ""),
        }],
    }


@app.get("/api/recalls/{recall_id}/top_event_review")
def get_top_event_review(recall_id: str):
    path = DATA_DIR / recall_id / "top_event_review.json"
    if not path.exists():
        return None
    return _migrate_top_event_review(json.loads(path.read_text("utf-8")))


@app.post("/api/recalls/{recall_id}/top_event_review")
def save_top_event_review(recall_id: str, body: TopEventReviewSubmission):
    base = DATA_DIR / recall_id
    if not base.exists(): raise HTTPException(404, "recall not found")
    if not body.reviewer.strip(): raise HTTPException(400, "reviewer は必須です")
    data = {
        "reviewer": body.reviewer,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "event_reviews": [e.model_dump() for e in body.event_reviews],
    }
    return _save_json_to(base / "top_event_review.json", data)


@app.get("/api/recalls/{recall_id}/fta")
def get_recall_fta(recall_id: str, index: int = 0):
    """FTA output を返す。index=0 は output.yaml、index>0 は output_{index}.yaml。"""
    base = DATA_DIR / recall_id
    path = base / "output.yaml" if index == 0 else base / f"output_{index}.yaml"
    if not path.exists():
        raise HTTPException(404, f"output yaml not found for index {index}")
    data = yaml.safe_load(path.read_text("utf-8"))
    return _fta_yaml_to_nodes(data)


@app.get("/api/recalls/{recall_id}/fta/list")
def list_recall_ftas(recall_id: str):
    """利用可能な FTA ファイルのインデックス一覧を返す。"""
    base = DATA_DIR / recall_id
    indices = []
    if (base / "output.yaml").exists():
        indices.append(0)
    i = 1
    while (base / f"output_{i}.yaml").exists():
        indices.append(i)
        i += 1
    return indices


# ---------------------------------------------------------------------------
# ベンチマーク（fta-agent/cases + sessions）
# ---------------------------------------------------------------------------

@app.get("/api/benchmark/cases")
def list_benchmark_cases():
    if not BMK_CASES.exists():
        return []
    cases = []
    for d in sorted(BMK_CASES.iterdir()):
        if not d.is_dir():
            continue
        label_path = d / "recall_label.json"
        if not label_path.exists():
            continue
        label = json.loads(label_path.read_text("utf-8"))
        input_path = d / "input.yaml"
        input_data = yaml.safe_load(input_path.read_text("utf-8")) if input_path.exists() else {}
        sessions = _bmk_sessions_for_case(d.name)
        has_fta = any(_bmk_latest_round(s) is not None for s in sessions)
        cases.append({
            "id": d.name,
            "notifier": "",
            "vehicle": input_data.get("product_name", d.name),
            "defect_location": input_data.get("top_event", ""),
            "has_review": (d / "expert_reviews.json").exists(),
            "has_spec": (d / "spec_FTA.md").exists(),
            "has_fta": has_fta,
            "has_spec_review": (d / "spec_review.json").exists(),
            "has_diagram_masked": (d / "diagram_masked.png").exists(),
            "has_diagram_original": (d / "diagram_original.png").exists(),
            "has_top_event_review": (d / "top_event_review.json").exists(),
            "has_failure_mode_review": (d / "failure_mode_review.json").exists(),
        })
    return cases


@app.get("/api/benchmark/cases/{case_id}")
def get_benchmark_case(case_id: str):
    case_dir = BMK_CASES / case_id
    if not case_dir.exists():
        raise HTTPException(404, "case not found")
    label = json.loads((case_dir / "recall_label.json").read_text("utf-8")) if (case_dir / "recall_label.json").exists() else {}
    input_path = case_dir / "input.yaml"
    inp = yaml.safe_load(input_path.read_text("utf-8")) if input_path.exists() else {}
    spec_path = case_dir / "spec_FTA.md"
    spec = spec_path.read_text("utf-8") if spec_path.exists() else None

    return {
        "raw": {
            "recall_id": case_id,
            "date_text": "",
            "metadata": {
                "notification_number": case_id,
                "notifier": "",
                "defect_system": inp.get("product_purpose", ""),
                "defect_location": inp.get("top_event", ""),
                "defect_description": inp.get("product_purpose", ""),
                "root_cause": "",
                "consequences": [],
                "correction_summary": "",
                "affected_vehicles": [{"make": "", "model": inp.get("product_name", ""), "type_designation": "", "affected_count": ""}],
            },
        },
        "label": {
            "target_component": [c.split("：")[0].split(":")[0] for c in inp.get("components", [])],
            "failure_modes": label.get("failure_modes", []),
            "top_event": [inp.get("top_event", "")] if inp.get("top_event") else [],
            "causal_chain": label.get("causal_chain", []),
        },
        "spec": spec,
    }


@app.get("/api/benchmark/cases/{case_id}/pdf")
def get_benchmark_pdf(case_id: str):
    case_dir = BMK_CASES / case_id
    for name in ("recall_report.pdf", "recall.pdf"):
        p = case_dir / name
        if p.exists():
            return FileResponse(p, media_type="application/pdf")
    raise HTTPException(404, "PDF not found")


@app.get("/api/benchmark/cases/{case_id}/diagram_masked")
def get_benchmark_diagram_masked(case_id: str):
    case_dir = BMK_CASES / case_id
    p = case_dir / "diagram_masked.png"
    if p.exists():
        return FileResponse(p, media_type="image/png")
    raise HTTPException(404, "diagram_masked.png not found")


@app.get("/api/benchmark/cases/{case_id}/diagram_original")
def get_benchmark_diagram_original(case_id: str):
    case_dir = BMK_CASES / case_id
    p = case_dir / "diagram_original.png"
    if p.exists():
        return FileResponse(p, media_type="image/png")
    raise HTTPException(404, "diagram_original.png not found")


@app.get("/api/benchmark/cases/{case_id}/spec_review")
def get_benchmark_spec_review(case_id: str):
    path = BMK_CASES / case_id / "spec_review.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else None


@app.post("/api/benchmark/cases/{case_id}/spec_review")
def save_benchmark_spec_review(case_id: str, body: SpecReviewSubmission):
    case_dir = BMK_CASES / case_id
    if not case_dir.exists():
        raise HTTPException(404, "case not found")
    if not body.reviewer.strip():
        raise HTTPException(400, "reviewer は必須です")
    review = {
        "reviewer": body.reviewer,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "verdict": body.verdict,
        "comment": body.comment,
        "section_reviews": {k: v.model_dump() for k, v in body.section_reviews.items()},
    }
    return _save_json_to(case_dir / "spec_review.json", review)


@app.get("/api/benchmark/cases/{case_id}/fta")
def get_benchmark_fta(case_id: str):
    case_dir = BMK_CASES / case_id
    if not case_dir.exists():
        raise HTTPException(404, "case not found")
    latest = _bmk_latest_round_any(case_id)
    if not latest:
        raise HTTPException(404, "no FTA tree found")
    data = yaml.safe_load((latest / "tree.yaml").read_text("utf-8"))
    # tree.yaml は単一ルートネスト形式（nodes キーなし）
    raw_nodes = [data] if isinstance(data, dict) else (data if isinstance(data, list) else [])
    counter = [0]
    flat_nodes: list[dict] = []
    for i, node in enumerate(raw_nodes):
        flat_nodes.extend(_nested_to_flat(node, parent_id=None, step=0, order_index=i, counter=counter))
    # input.yaml は ROUND内 skills/ を優先
    inp_path = latest / "skills" / "input.yaml"
    if not inp_path.exists():
        inp_path = case_dir / "input.yaml"
    inp = yaml.safe_load(inp_path.read_text("utf-8")) if inp_path.exists() else {}
    return {
        "tree_id": case_id,
        "product_name": inp.get("product_name", case_id),
        "purpose": inp.get("product_purpose", ""),
        "top_event": inp.get("top_event", ""),
        "components": inp.get("components", []),
        "functions": [],
        "nodes": flat_nodes,
    }


@app.get("/api/benchmark/cases/{case_id}/per_item_score")
def get_benchmark_per_item_score(case_id: str):
    latest = _bmk_latest_round_any(case_id)
    if not latest:
        raise HTTPException(404, "no rounds found")
    cov_path = latest / "recall_coverage.json"
    if not cov_path.exists():
        raise HTTPException(404, "recall_coverage.json not found")
    return _coverage_to_per_item(json.loads(cov_path.read_text("utf-8")))


@app.get("/api/benchmark/cases/{case_id}/expert_reviews")
def get_benchmark_expert_reviews(case_id: str):
    path = BMK_CASES / case_id / "expert_reviews.json"
    if not path.exists():
        return []
    return json.loads(path.read_text("utf-8"))


@app.get("/api/benchmark/cases/{case_id}/failure_mode_review")
def get_benchmark_failure_mode_review(case_id: str):
    path = BMK_CASES / case_id / "failure_mode_review.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else None


@app.post("/api/benchmark/cases/{case_id}/failure_mode_review")
def save_benchmark_failure_mode_review(case_id: str, body: FailureModeReviewSubmission):
    case_dir = BMK_CASES / case_id
    if not case_dir.exists(): raise HTTPException(404, "case not found")
    if not body.reviewer.strip(): raise HTTPException(400, "reviewer は必須です")
    return _save_json_to(case_dir / "failure_mode_review.json", {
        "reviewer": body.reviewer,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "verdict": body.verdict,
        "item_reviews": body.item_reviews,
        "item_suggested": body.item_suggested,
        "missing_items": body.missing_items,
        "comment": body.comment,
    })


@app.get("/api/benchmark/cases/{case_id}/top_event_review")
def get_benchmark_top_event_review(case_id: str):
    path = BMK_CASES / case_id / "top_event_review.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else None


@app.post("/api/benchmark/cases/{case_id}/top_event_review")
def save_benchmark_top_event_review(case_id: str, body: TopEventReviewSubmission):
    case_dir = BMK_CASES / case_id
    if not case_dir.exists(): raise HTTPException(404, "case not found")
    if not body.reviewer.strip(): raise HTTPException(400, "reviewer は必須です")
    return _save_json_to(case_dir / "top_event_review.json", {
        "reviewer": body.reviewer,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "verdict": body.verdict,
        "suggested_top_event": body.suggested_top_event,
        "comment": body.comment,
    })


@app.post("/api/benchmark/cases/{case_id}/expert_reviews")
def save_benchmark_expert_review(case_id: str, body: ExpertReviewSubmission):
    case_dir = BMK_CASES / case_id
    if not case_dir.exists():
        raise HTTPException(404, "case not found")
    if not body.reviewer.strip():
        raise HTTPException(400, "reviewer は必須です")
    path = case_dir / "expert_reviews.json"
    reviews: list[dict] = json.loads(path.read_text("utf-8")) if path.exists() else []
    entry = {
        "reviewer": body.reviewer,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "failure_modes": [i.model_dump() for i in body.failure_modes],
    }
    idx = next((i for i, r in enumerate(reviews) if r["reviewer"] == body.reviewer), None)
    if idx is not None:
        reviews[idx] = entry
    else:
        reviews.append(entry)
    path.write_text(json.dumps(reviews, ensure_ascii=False, indent=2), encoding="utf-8")
    return entry


# ---------------------------------------------------------------------------
# フロントエンド静的ファイル配信（本番デプロイ用）
# ---------------------------------------------------------------------------

_DIST = Path(__file__).parent.parent / "frontend" / "dist"
if _DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        return FileResponse(str(_DIST / "index.html"))


@app.post("/api/recalls/{recall_id}/expert_reviews")
def save_expert_review(recall_id: str, body: ExpertReviewSubmission):
    """専門家の5段階評価を expert_reviews.json に追記・上書き保存する。

    同一レビュアー名が既に存在する場合は上書き、新規の場合は追記する。
    """
    base = DATA_DIR / recall_id
    if not base.exists():
        raise HTTPException(404, "recall not found")
    if not body.reviewer.strip():
        raise HTTPException(400, "reviewer は必須です")

    path = base / "expert_reviews.json"
    reviews: list[dict] = json.loads(path.read_text("utf-8")) if path.exists() else []

    entry = {
        "reviewer": body.reviewer,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "failure_modes": [i.model_dump() for i in body.failure_modes],
    }

    # 同一レビュアーなら上書き
    idx = next((i for i, r in enumerate(reviews) if r["reviewer"] == body.reviewer), None)
    if idx is not None:
        reviews[idx] = entry
    else:
        reviews.append(entry)

    path.write_text(json.dumps(reviews, ensure_ascii=False, indent=2), encoding="utf-8")
    return entry
