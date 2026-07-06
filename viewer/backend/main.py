"""
ベンチマークビューア用 FastAPI バックエンド

実行:
  cd benchmark/viewer/backend
  uvicorn main:app --reload --port 8001
"""

from __future__ import annotations

import os
from pathlib import Path

import json
import yaml
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

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

    return {
        "tree_id": data.get("tree_id", recall_id),
        "product_name": data.get("product_name", ""),
        "purpose": data.get("purpose", ""),
        "top_event": "",
        "components": data.get("components", []),
        "functions": data.get("functions") or [],
        "nodes": flat_nodes,
    }
