# fta-evaluator

FTA（故障の木解析）の評価・スコアリング・ビューワー。
`fta-spec-generator` が収集した `raw.json` を取り込み、ラベル生成 → input.yaml 生成 → 評価 → Web表示 の一連を担う。

---

## プログラム構成

```
fta-evaluator/
├── scripts/
│   ├── extract_label.py     # raw.json → label.json（正解ラベル生成）
│   ├── convert_input.py     # spec_FTA.md + label.json → input.yaml
│   ├── judge.py             # LLM as judge: output.yaml vs label.json → score.json
│   ├── objective_eval.py    # 決定論的客観評価（部品/故障モード含有・因果連鎖被覆率）
│   └── coverage.py          # LLMスコア vs 専門家スコアのCoverage計算
├── skills/
│   └── failure-mode.md      # 故障モードラベル生成スキル（/failure-mode コマンド）
├── viewer/
│   ├── backend/             # FastAPI（ポート8000）
│   │   └── main.py
│   └── frontend/            # React + Vite（ポート5173）
│       ├── src/
│       └── package.json
├── data/{recall_id}/        # 各リコールのデータ
│   ├── raw.json             # fta-spec-generatorからコピー
│   ├── label.json           # extract_label.py 出力
│   ├── spec_FTA.md          # fta-spec-generatorからコピー
│   ├── input.yaml           # convert_input.py 出力
│   ├── output.yaml          # fta-agentからコピー
│   ├── score.json           # judge.py 出力
│   ├── objective.json       # objective_eval.py 出力
│   └── review.json          # 専門家レビュー（ビューワーから入力）
└── requirements.txt
```

---

## セットアップ

### Python依存関係

```bash
cd fta-evaluator
pip install -r requirements.txt
cp .env.example .env   # Azure OpenAI接続情報を記入（Document Intelligenceは不要）
```

### 環境変数（`.env`）

| 変数名 | 内容 |
|--------|------|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI エンドポイント |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI APIキー |
| `AZURE_OPENAI_DEPLOYMENT` | デプロイ名（例: `gpt-5.2`） |
| `AZURE_OPENAI_API_VERSION` | APIバージョン（例: `2025-04-01-preview`） |
| `FTA_SPEC_GENERATOR_ROOT` | fta-spec-generatorのパス（デフォルト: `../fta-spec-generator`） |

### フロントエンド依存関係

```bash
cd fta-evaluator/viewer/frontend
npm install
```

---

## 評価スクリプトの使い方

### 1. 正解ラベル生成（extract_label.py）

`data/{recall_id}/raw.json` から故障モード・因果連鎖の正解ラベルを生成する。

```bash
cd fta-evaluator

# 全件
python scripts/extract_label.py

# 1件のみ
python scripts/extract_label.py --id r8-01-28-005649
```

出力: `data/{recall_id}/label.json`

#### Claudeスキルで生成（推奨）

Claude Codeで以下を実行（対話的に確認しながら生成）:

```
/failure-mode <recall_id>
```

---

### 2. input.yaml 生成（convert_input.py）

`spec_FTA.md` + `label.json` を fta-agent 用の入力形式に変換する。

```bash
# 全件
python scripts/convert_input.py

# 1件のみ
python scripts/convert_input.py --id r8-01-28-005649
```

出力: `data/{recall_id}/input.yaml`

---

### 3. 評価（judge.py / objective_eval.py）

fta-agent が生成した `output.yaml` を評価する。

```bash
# LLM as judge（主観評価）
python scripts/judge.py
python scripts/judge.py --id r8-01-28-005649

# 客観評価（LLM不使用・決定論的）
python scripts/objective_eval.py
python scripts/objective_eval.py --id r8-01-28-005649

# 客観評価（埋め込みによる意味照合あり）
python scripts/objective_eval.py --embedding azure
python scripts/objective_eval.py --embedding local
```

出力: `data/{recall_id}/score.json`、`data/{recall_id}/objective.json`

---

### 4. Coverage計算（coverage.py）

LLMジャッジスコアと専門家スコアの一致率を算出する。

```bash
python scripts/coverage.py
python scripts/coverage.py --id r8-01-28-005649
```

---

## ビューワー（Webサイト）の起動

リコール元・仕様書・FTAツリー・評価結果をブラウザで確認できる。

### 前提条件

- Python 3.10 以上
- Node.js 18 以上 / npm

### 起動手順

**ターミナル1（バックエンド）:**

```bash
cd fta-evaluator/viewer/backend
pip install fastapi uvicorn python-dotenv pyyaml
uvicorn main:app --reload --port 8000
```

**ターミナル2（フロントエンド）:**

```bash
cd fta-evaluator/viewer/frontend
npm install   # 初回のみ
npm run dev
```

**ブラウザで開く:**

```
http://localhost:5173
```

### ビューワーで確認できる内容

- **リコール一覧**: `data/` 配下の全リコールをリスト表示
- **リコール元PDF**: 国交省届出書の内容（raw.json）
- **部品正常仕様書**: spec_FTA.md
- **FTAツリー**: output.yaml をインタラクティブなツリーで可視化
- **評価結果**: score.json / objective.json のスコア
- **専門家レビュー**: ブラウザ上から review.json に入力可能
