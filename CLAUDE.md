# recall-fta

**すべてのスキルとデータの中心リポジトリ。** Claude Code はここから起動する。

## スキル一覧

| スキル | コマンド | 役割 | 入力 → 出力 |
|---|---|---|---|
| generate-spec | `/generate-spec <recall_id>` | 仕様書生成 | raw.json → spec_FTA.md |
| generate-label | `/generate-label <recall_id>` | 正解ラベル生成 | raw.json → label.json |
| generate-input | `/generate-input <recall_id>` | FTA入力生成 | spec_FTA.md + raw.json → input.yaml |
| evaluate-fta | `/evaluate-fta <recall_id>` | FTA評価 | output.yaml + label.json → score.json |

スキル定義: [`skills/`](./skills/)

## データフロー

```
【収集】
scripts/collect_recalls.py
  → data/{recall_id}/raw.json + data/{recall_id}/recall.pdf

【生成】（Claude Code を recall-fta/ で起動）
/generate-spec {recall_id}        → data/{recall_id}/spec_FTA.md
/generate-label {recall_id}       → data/{recall_id}/label.json
/generate-input {recall_id}       → data/{recall_id}/input.yaml

【FTA生成】（fta-agent、触らない）
input.yaml → fta-agent → output.yaml
  → data/{recall_id}/output.yaml にコピー

【評価】
/evaluate-fta {recall_id}    → data/{recall_id}/score.json

【専門家レビュー】
viewer（https://dragent-recall.onrender.com）で spec/label/input を確認
  → ZIPエクスポート → Slack でエンジニアに共有

【スキル改善】
エンジニアが受け取ったレビューデータをもとに Claude と対話して skills/*.md を直接編集
```

## ディレクトリ構成

```
recall-fta/
├── skills/
│   ├── generate-spec.md          — 仕様書生成
│   ├── generate-label.md         — 正解ラベル生成
│   ├── generate-input.md         — FTA入力（input.yaml）生成
│   └── evaluate-fta.md           — FTA評価
├── scripts/
│   ├── collect_recalls.py  — 国交省サイト巡回 → raw.json 収集
│   └── pipeline.py         — PDF取得・OCR・メタ情報抽出（collect_recalls.py が import）
├── data/{recall_id}/
│   ├── raw.json           — 収集済みリコールデータ
│   ├── recall.pdf         — リコール届出書PDF
│   ├── spec_FTA.md        — /generate-spec が生成
│   ├── label.json         — /generate-label が生成
│   ├── input.yaml         — /generate-input が生成
│   ├── output.yaml        — fta-agent が生成（コピー）
│   └── score.json         — /evaluate-fta が生成
└── viewer/
    ├── backend/main.py    — FastAPI（Render にデプロイ済み）
    └── frontend/          — React ビューワー
```

## 環境変数

`.env.example` 参照。Azure OpenAI（仕様書生成・judge用）+ Azure Document Intelligence（OCR用）が必要。
