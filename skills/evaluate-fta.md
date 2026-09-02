---
name: evaluate-fta
description: >
  output.yaml（FTA生成結果）と label.json（正解ラベル）を比較して評価スコアを算出する。
  3軸総合評価（score.json）・項目別評価（per_item_score.json）・客観評価（objective_eval.py）を実行する。
  `/judge <recall_id>` で起動。recall_id 省略時は data/ を一覧して選ばせる。
---

# /judge — FTA評価（LLM judge + 客観評価）

## 概要

生成されたFTA（output.yaml）が正解ラベル（label.json）をどの程度捉えているかを評価する。

| 評価種別 | 出力ファイル | 方式 |
|---|---|---|
| 3軸総合評価 | score.json | LLM judge（1〜5） |
| 項目別評価 | per_item_score.json | LLM judge（failure_modes / causal_chain 各項目） |
| 客観評価 | objective.json | 決定論的（LLM不使用）|

---

## Step 0 — 入力解決

`$ARGUMENTS` に recall_id が渡された場合はそれを使う。
渡されなかった場合は `data/` 配下のディレクトリを列挙してユーザーに選ばせる。

以下を Read する:
- `data/{recall_id}/label.json`
- `data/{recall_id}/output.yaml`

どちらか一方でも存在しない場合はエラーを表示して終了する。

---

## Step 1 — FTAノードの収集

output.yaml から全 event ノードのラベル（label / label_detail）を再帰的に収集して一覧化する:

```
製品名: {product_name}
FTAノード一覧:
  - {label1}（{label_detail1}）
  - {label2}
  ...
```

---

## Step 2 — 3軸総合評価

label.json の各フィールドとFTAノード一覧を比較して採点する。

**評価軸:**

| 軸 | 評価内容 |
|---|---|
| component_match | target_component の各部品がFTAのいずれかのノードに含まれるか |
| failure_mode_match | failure_modes の各故障モードがFTAのいずれかのノードに含まれるか |
| top_event_match | top_event がFTAのトップ事象（最上位ノード）と一致または近似するか |

**採点基準（各軸 1〜5）— スコア境界の判定フロー:**

failure_mode_match は各故障モードについて以下の順で判定し、最初に Yes になったスコアを採用する:
- (1) FTAノードと故障モードが意味的に同じ現象か？ → **5（同一現象）**
- (2) FTAノードが故障モードの直接原因か？（そのノードがなければ故障モードも起きない） → **4（直接原因）**
- (3) FTAノードが故障モードの遠因か？（複数ステップを経て故障モードにつながる） → **3（遠因）**
- (4) FTAノードが故障モードの結果か？（故障モードが起きた後に現れる現象） → **2（結果）**
- (5) いずれにも該当しない → **1（無関係）**

component_match・top_event_match も同じフローで判定する。

overall = 3軸の単純平均（小数点以下1桁に丸める）

`data/{recall_id}/score.json` に Write する:
```json
{
  "component_match": 1〜5,
  "failure_mode_match": 1〜5,
  "top_event_match": 1〜5,
  "overall": 3軸平均,
  "reasoning": {
    "component_match": "一致した部品名・不一致の部品名を明記",
    "failure_mode_match": "一致した故障モード・不一致を明記",
    "top_event_match": "FTAのトップ事象と正解の比較を明記"
  }
}
```

---

## Step 3 — 項目別評価

label.json の failure_modes と causal_chain の各項目を個別に 1〜5 で評価する。

**採点基準（専門家評価と共通の判定フロー）:**
- 5（同一現象）: FTAノードと評価項目が意味的に同じ現象を指している
- 4（直接原因）: FTAノードが評価項目の直接原因（そのノードがなければ評価項目も起きない）
- 3（遠因）: FTAノードが評価項目の遠因（複数ステップを経て評価項目につながる）
- 2（結果）: FTAノードが評価項目の結果（評価項目が起きた後に現れる現象）
- 1（無関係）: いずれにも該当しない

`data/{recall_id}/per_item_score.json` に Write する:
```json
{
  "failure_modes": [
    {"item": "入力と同じ文字列", "score": 1〜5},
    ...
  ],
  "causal_chain": [
    {"item": "入力と同じ文字列", "score": 1〜5},
    ...
  ]
}
```

---

## Step 4 — 客観評価の実行

決定論的評価（LLM不使用）を Bash で実行する:

```bash
cd /Users/yoshidakouji/epicai/fta-evaluator
python scripts/objective_eval.py --id {recall_id}
```

実行後 `data/{recall_id}/objective.json` を Read して結果を表示する。

---

## Step 5 — 評価サマリの表示

```
【評価サマリ: {recall_id}】

LLM Judge（score.json）:
  部品一致     : {component_match}/5  {reasoning.component_match の要約}
  故障モード   : {failure_mode_match}/5  {reasoning.failure_mode_match の要約}
  トップ事象   : {top_event_match}/5  {reasoning.top_event_match の要約}
  総合         : {overall}/5

客観評価（objective.json）:
  部品見逃しなし     : {OK/NG}  missing: {missing parts}
  故障モード見逃しなし: {OK/NG}  missing: {missing modes}
  因果連鎖被覆率     : {coverage:.0%}  未照合: {unmatched steps}

スコアが低い場合（overall < 3.5 または客観評価に NG）:
  fta-spec-generator で /skill-improve を実行して spec-gen.md を改善してください。
```
