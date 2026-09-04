---
name: generate-input
description: >
  spec_FTA.md + raw.json から fta-agent 用 input.yaml を生成する。
  label.json は参照しない（故障情報の混入を防ぐため）。
  `/generate-input <recall_id>` で起動。
---

# /convert-input — input.yaml 生成

## 概要

`data/{recall_id}/spec_FTA.md` と `data/{recall_id}/raw.json` から、
fta-agent が受け取る `data/{recall_id}/input.yaml` を生成する。

**重要:** label.json は参照しない。故障情報・故障モード・原因を input.yaml に含めない。

---

## Step 0 — 入力解決

`$ARGUMENTS` から recall_id を取得する。

以下を Read する:
- `data/{recall_id}/spec_FTA.md`
- `data/{recall_id}/raw.json`（top_event の導出にのみ使用）

---

## Step 1 — フィールドの抽出

### product_name
spec_FTA.md の `対象部品：` 行から取得する。見つからない場合は raw.json の `metadata.defect_location` を使う。

### purpose
セクション `## 2. システム内での役割` の本文から正常時の目的・機能を 1 文で表す。
- HTMLコメント（`<!-- ... -->`）は除去してから読む
- 「〜しないようにする」「〜を防ぐ」など故障前提の表現にしない
- 車両全体の目的ではなく対象部品の機能を記述する

### components と functions
セクション `## 3. 構成・関連部品` の箇条書き `- 部品名：機能説明` から抽出する。
- components: 部品名のリスト
- functions: 機能説明のリスト（components と同順）
- HTMLコメントは除去してから読む
- 「記載なし」行は含めない

### top_event
raw.json の `metadata.consequences` の最後の要素から導出する。
ヘッジ表現を除去する（「最悪の場合、」「おそれがある」「可能性がある」「場合がある」）。
consequences が空の場合は `metadata.defect_location + "の不具合"` を使う。

---

## Step 2 — ファイル保存

`data/{recall_id}/input.yaml` に Write する。

保存後:
```
保存しました: data/{recall_id}/input.yaml

次のステップ:
  fta-agent の exp/expNN/input.yaml にコピーして
  /fta-expert で FTA（output.yaml）を生成してください。
  生成後: output.yaml を data/{recall_id}/output.yaml に配置して /judge {recall_id} で評価してください。
```
