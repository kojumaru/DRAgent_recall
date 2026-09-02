---
name: generate-label
description: >
  raw.json から FTA評価用の正解ラベル（label.json）を生成する。
  target_component / failure_modes / top_event / causal_chain の全フィールドを対話的に抽出する。
  `/extract-label <recall_id>` で起動。recall_id 省略時は data/ を一覧して選ばせる。
---

# /extract-label — 正解ラベル全体の生成

## 概要

raw.json からFTA評価に必要な全正解ラベルを抽出・確認して `data/{recall_id}/label.json` に保存する。

| フィールド | 意味 |
|---|---|
| target_component | FTAに必ず登場すべき部品名（2〜5件） |
| failure_modes | `{部品名}が{機能名}を喪失する` 形式（1〜4件） |
| top_event | FTAのトップ事象（最悪の結果）（1〜2件） |
| causal_chain | 根本原因→トップ事象の因果連鎖（順序通り、3〜7ステップ） |

---

## Step 0 — 入力解決

`$ARGUMENTS` に recall_id が渡された場合はそれを使う。
渡されなかった場合は `data/` 配下のディレクトリを列挙してユーザーに選ばせる。

以下を Read する:
- `data/{recall_id}/raw.json`
- `data/{recall_id}/label.json`（既存の場合は現在の内容を表示してから更新確認する）

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

候補を列挙してユーザーに確認し、修正があれば反映する。

---

## Step 3 — failure_modes の抽出

形式: **`{部品名}が{機能名}を喪失する`** で 1〜4 件。

**ルール:**
- 物理・化学的な現象レベルで記述する（「固着」「膨潤」「短絡」等の具体的な現象）
- 根本原因（「設計が不十分」「品質管理が不十分」等）は含めない
- トップ事象（「ドアが開く」等の最終結果）は含めない
- 因果の連鎖を部品ごとに分解する（中間の故障モードも含める）

**部品カテゴリ別の機能名リファレンス:**

| 部品カテゴリ | よくある機能名 |
|---|---|
| シール・パッキン・グロメット | 防水機能、水密機能、気密機能 |
| 電気配線・ハーネス | 電気的絶縁機能、導通機能、信号伝達機能 |
| スイッチ・センサ | 信号出力機能、検知機能、接点導通機能 |
| ブラケット・ボルト・締結部品 | 構造保持機能、締結機能、固定機能 |
| ホース・パイプ | 流体密封機能、圧力保持機能、流路確保機能 |
| バルブ・逆止弁 | 流量制御機能、逆流防止機能 |
| ブレーキ部品 | 制動力発生機能、制動力保持機能 |
| ECU・制御基板 | 演算機能、制御信号出力機能 |

候補を列挙してユーザーに確認し、修正があれば反映する。

---

## Step 4 — top_event の抽出

`metadata.consequences` の最も深刻な事象を抽出する。

ヘッジ表現を除去した簡潔な形式にする:
- 「最悪の場合、〜おそれがある」→「〜」
- 「〜可能性がある」→「〜」
- 「〜場合がある」→「〜」

抽出後、以下の形式でユーザーに提示する:

```
【トップ事象候補】

1. {トップ事象}
   根拠: {metadata.consequences の対応記述}

この内容でよいですか？ 追加・変更・削除があれば教えてください。
（他に考えられるトップ事象〔別の重大結果・二次被害など〕があれば追加できます）
```

ユーザーの回答を受けて top_event リストを確定する。

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
  "failure_modes": ["{部品名}が{機能名}を喪失する", ...],
  "top_event": ["トップ事象"],
  "causal_chain": ["根本原因", "中間事象", "...", "トップ事象"]
}
```

保存後:
```
保存しました: data/{recall_id}/label.json
次: /convert-input {recall_id} で input.yaml を生成してください
```
