# fta-evaluator

FTA生成結果の評価・スコアリング・ビューワー。**データ収集は行わない**（fta-spec-generator が収集）。

## スキル構成（Claude Code が直接実行する）

Python スクリプトは廃止し、スキルで代替する。`objective_eval.py` のみ決定論的計算のため残す。

| スキル | コマンド | 役割 | 対応する旧スクリプト |
|---|---|---|---|
| extract-label | `/extract-label <recall_id>` | raw.json → label.json（全フィールド対話抽出） | extract_label.py |
| failure-mode | `/failure-mode <recall_id>` | label.json の failure_modes のみ更新 | — |
| convert-input | `/convert-input <recall_id>` | spec_FTA.md + raw.json → input.yaml | convert_input.py |
| judge | `/judge <recall_id>` | output.yaml vs label.json の評価 | judge.py |

スキルの定義ファイル: [`skills/`](./skills/)

## 残す Python スクリプト

- `scripts/objective_eval.py` — 決定論的評価（部品/故障モード含有チェック・因果連鎖被覆率 DP）。LLM 不使用のため残す。`/judge` スキルから内部的に呼び出す。
- `scripts/app.py` — Streamlit GUI（将来的にスキル化を検討）
- `scripts/viewer/` — FastAPI + React ビューワー

## データフロー

```
（fta-spec-generator で収集）
fta-spec-generator/dataset/recalls/{recall_id}/raw.json
  ↓（data/ にコピー）
data/{recall_id}/raw.json

/extract-label {recall_id}
  → data/{recall_id}/label.json

（fta-spec-generator で生成）
/spec-gen {recall_id}
  → fta-spec-generator/dataset/specs/{recall_id}/spec_FTA.md
  ↓（data/ にコピー）
data/{recall_id}/spec_FTA.md

/convert-input {recall_id}
  → data/{recall_id}/input.yaml

（fta-agent で FTA生成）
fta-agent exp/expNN/input.yaml → output.yaml
  ↓（data/ にコピー）
data/{recall_id}/output.yaml

/judge {recall_id}
  → data/{recall_id}/score.json
  → data/{recall_id}/per_item_score.json
  → data/{recall_id}/objective.json（objective_eval.py 経由）

スコアが低い場合:
  fta-spec-generator で /skill-improve を実行
  → fta-spec-generator/skills/spec-gen.md を改善
  → /spec-gen で再生成 → /convert-input → /judge のループ
```

## ディレクトリ構成

```
fta-evaluator/
├── skills/
│   ├── extract-label.md  — /extract-label スキル
│   ├── failure-mode.md   — /failure-mode スキル（failure_modes のみ更新）
│   ├── convert-input.md  — /convert-input スキル
│   └── judge.md          — /judge スキル
├── scripts/
│   ├── objective_eval.py — 決定論的評価（残す）
│   ├── extract_label.py  — 廃止予定（/extract-label スキルで代替）
│   ├── convert_input.py  — 廃止予定（/convert-input スキルで代替）
│   ├── judge.py          — 廃止予定（/judge スキルで代替）
│   └── app.py            — Streamlit GUI
└── data/{recall_id}/
    ├── raw.json           — fta-spec-generator からコピー
    ├── label.json         — /extract-label が生成
    ├── spec_FTA.md        — fta-spec-generator からコピー
    ├── input.yaml         — /convert-input が生成
    ├── output.yaml        — fta-agent からコピー
    ├── score.json         — /judge が生成
    ├── per_item_score.json — /judge が生成
    └── objective.json     — /judge → objective_eval.py が生成
```

## 環境変数

`.env.example` 参照。Azure OpenAI（judge 用）が必要。Azure Document Intelligence は不要。
