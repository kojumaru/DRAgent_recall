---
name: generate-label
description: >
  raw.json から FTA評価用の正解ラベル（label.json）を生成する。
  target_component / failure_modes / top_event / causal_chain の全フィールドを抽出する。
  `/generate-label <recall_id>` で起動。
---

# /generate-label — 正解ラベル全体の生成

## 概要

raw.json からFTA評価に必要な全正解ラベルを抽出・確認して `data/{recall_id}/label.json` に保存する。

| フィールド    | 意味                                                                |
| ------------- | ------------------------------------------------------------------- |
| failure_modes | `{部品名}が{事象}` 形式（届出から読み取れる故障モードの数だけ生成） |
| top_event     | FTAのトップ事象（最悪の結果）（1〜2件）                             |

---

## Step 0 — 入力解決

`$ARGUMENTS` から recall_id を取得する。

以下を Read する:

- `data/{recall_id}/raw.json`
- `data/{recall_id}/label.json`（既存の場合は現在の内容を把握した上で更新する）

---

## Step 1 — リコール内容の整理

raw.json の metadata から以下を表示する:

```
【リコール概要】
届出番号  : {recall_id}
届出者    : {metadata.notifier}
対象車種  : {affected_vehicles[0].maker} {affected_vehicles[0].model}
不具合部位: {metadata.defect_location}
不具合内容: {metadata.defect_description}
部品リスト: {metadata.parts[].part_name}
不具合原因: {metadata.defect_cause}
最悪事象  : {metadata.consequences[-1]}
```

---

## Step 2 — target_component の抽出

リコールで実際に問題となった部品を 2〜5 件抽出する。

**ルール:**

- `parts[].part_name` を主ソースとする
- 別名・略称・周辺部品も含めてよい
- 抽象的な表現（「電気回路」等）より具体的な部品名を優先する

---

## Step 3 — failure_modes の抽出

形式: **`{部品名}が{事象}`** で 1〜4 件。

### 形式選択ルール

**リコール情報の表現を変えすぎないこと。** 届出書に記載の事象をなるべくそのまま使う。

**禁止事項:**

- raw.json（届出書）に記載のない事象を推測で追加しない
- 根本原因（「設計が不十分」等）を含めない
- トップ事象（最終結果）を含めない
- 意味的に類似する事象を別の故障モードとして列挙しない。意味的に類似する場合は自動車の故障原因により近いものを採用する

### label.json への書き込み

`data/{recall_id}/label.json` を Read して現在の内容を把握し、
`failure_modes` フィールドのみを差し替えて Write する。

他のフィールド（target_component, top_event 等）はそのまま保持する。

```json
{
  "recall_id": "...",
  "manufacturer": "...",
  "vehicle": "...",
  "target_component": [...],
  "failure_modes": [
    "{部品名A}が{事象A}",
    "{部品名B}が{事象B}",
    ...
  ],
  "top_event": [...]
}
```

---

## Step 4 — top_event の抽出

`metadata.consequences` の最も深刻な事象を抽出する。

ヘッジ表現を除去した簡潔な形式にする:

- 「最悪の場合、〜おそれがある」→「〜」
- 「〜可能性がある」→「〜」
- 「〜場合がある」→「〜」

---

## Step 5 — causal_chain の抽出

根本原因 → 中間事象 → トップ事象 の順序で 3〜7 ステップ。

**ルール:**

- 届出書に記載のある中間ステップはすべて含める（推測で補わない）
- 最終ステップは top_event と対応する表現にする
- 根本原因（設計不備・材質選定・製造ばらつき等）から始める

---

## Step 6 — label.json への書き込み

全フィールドの確認が取れたら `data/{recall_id}/label.json` に Write する:

```json
{
  "recall_id": "...",
  "manufacturer": "...",
  "vehicle": "...",
  "target_component": ["部品名1", "部品名2", ...],
  "failure_modes": ["{部品名}が{事象}", ...],
  "top_event": ["トップ事象"],
  "causal_chain": ["根本原因", "中間事象", "...", "トップ事象"]
}
```

保存後:

```
保存しました: data/{recall_id}/label.json
次: /generate-input {recall_id} で input.yaml を生成してください
```
