"""
ベンチマークビューア用 FastAPI バックエンド

実行:
  cd benchmark/viewer/backend
  uvicorn main:app --reload --port 8001
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import json
import yaml
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

load_dotenv(Path(__file__).parent.parent.parent / ".env")

DATA_DIR = Path(__file__).parent.parent.parent / "data"
PDF_DIR = Path(os.environ.get(
    "FTA_SPEC_GENERATOR_ROOT",
    str(Path(__file__).parent.parent.parent.parent / "fta-spec-generator"),
)) / "dataset" / "pdfs"

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
        if not (d / "output.yaml").exists():
            continue
        raw = json.loads((d / "raw.json").read_text("utf-8"))
        meta = raw.get("metadata", {})
        notifier = meta.get("notifier", "")
        vehicles = meta.get("affected_vehicles", [])
        vehicle_name = vehicles[0].get("model", "") if vehicles else ""
        recalls.append({
            "id": d.name,
            "notifier": notifier,
            "vehicle": vehicle_name,
            "defect_location": meta.get("defect_location", ""),
            "has_review": (d / "review.json").exists(),
        })
    return recalls


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


@app.get("/api/recalls/{recall_id}/pdf")
def get_pdf(recall_id: str):
    # parent_recall_id があればそちらのPDFを使う
    raw_path = DATA_DIR / recall_id / "raw.json"
    if raw_path.exists():
        raw = json.loads(raw_path.read_text("utf-8"))
        ocr_id = raw.get("parent_recall_id", recall_id)
    else:
        ocr_id = recall_id
    pdf_path = PDF_DIR / f"{ocr_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "PDF not found")
    return FileResponse(pdf_path, media_type="application/pdf")


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
