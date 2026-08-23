#!/usr/bin/env python3
"""
専門家レビュー用 静的HTML生成スクリプト
対象: spec_FTA.md + label.json が揃っているリコール全件

実行: python3 scripts/export_html.py
出力: review/ ディレクトリ（index.html + {recall_id}.html × N件）
"""
import json
import re
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
OUTPUT_DIR = Path(__file__).parent.parent / "review"


def strip_html_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL).strip()


GOOGLE_FORM_URL = "https://docs.google.com/forms/d/e/XXXXX/viewform"  # ← 作成後に差し替え


def load_recall(recall_id: str) -> dict | None:
    d = DATA_DIR / recall_id
    # spec_FTA.md + label.json + input.yaml が揃っているものだけ
    if not (d / "raw.json").exists() or not (d / "spec_FTA.md").exists() \
            or not (d / "label.json").exists() or not (d / "input.yaml").exists():
        return None
    raw = json.loads((d / "raw.json").read_text("utf-8"))
    spec = strip_html_comments((d / "spec_FTA.md").read_text("utf-8"))
    label = json.loads((d / "label.json").read_text("utf-8"))
    return {"recall_id": recall_id, "raw": raw, "spec": spec, "label": label}


def _css_head(title: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  .spec-content h1{{font-size:1.2rem;font-weight:700;margin:1rem 0 .5rem;border-bottom:2px solid #3b82f6;padding-bottom:.25rem}}
  .spec-content h2{{font-size:1.05rem;font-weight:700;margin:1rem 0 .4rem;border-bottom:1px solid #e5e7eb;padding-bottom:.2rem}}
  .spec-content p{{margin:.5rem 0;line-height:1.7}}
  .spec-content ul{{list-style:disc;padding-left:1.5rem;margin:.5rem 0}}
  .spec-content li{{margin:.2rem 0;line-height:1.6}}
</style>
</head>
<body class="bg-gray-50 text-gray-800 text-sm">
"""
FOOT = "</body></html>"


def make_index(recalls: list[dict]) -> str:
    rows = ""
    for r in recalls:
        m = r["raw"].get("metadata", {})
        notifier = m.get("notifier", "")
        veh = m.get("affected_vehicles", [{}])
        vehicle = f"{veh[0].get('maker', veh[0].get('model', ''))}" if veh else ""
        defect = m.get("defect_location", "")
        rid = r["recall_id"]
        fm_count = len(r["label"].get("failure_modes", []))
        rows += f"""<tr class="hover:bg-blue-50 cursor-pointer" onclick="location.href='{rid}.html'">
          <td class="px-4 py-3 font-mono">{rid}</td>
          <td class="px-4 py-3">{notifier}</td>
          <td class="px-4 py-3">{vehicle}</td>
          <td class="px-4 py-3">{defect}</td>
          <td class="px-4 py-3 text-center">{fm_count}件</td>
          <td class="px-4 py-3 text-center">
            <a href="{rid}.html" class="bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 text-xs">レビューする →</a>
          </td></tr>"""

    return _css_head("リコールFTA 専門家レビュー") + f"""
<div class="max-w-5xl mx-auto px-4 py-8">
  <h1 class="text-2xl font-bold mb-1">リコールFTA 専門家レビュー</h1>
  <p class="text-gray-500 mb-6">{len(recalls)} 件のリコールについて、仕様書・故障モード・トップ事象を確認してください。</p>

  <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6 text-blue-800">
    <p class="font-bold mb-2">📋 レビュー手順</p>
    <ol class="list-decimal list-inside space-y-1">
      <li>下の一覧から任意のリコールを選んで「レビューする」をクリック</li>
      <li>ページ上部でリコール内容・仕様書・故障モード・トップ事象を確認</li>
      <li>ページ下部のフィードバック欄に評価を入力</li>
      <li>「フィードバックを生成」ボタンを押してSlack・メールに貼り付け</li>
    </ol>
  </div>

  <div class="bg-white rounded-xl shadow overflow-hidden">
    <table class="w-full">
      <thead class="bg-gray-100 text-xs uppercase text-gray-500">
        <tr>
          <th class="px-4 py-3 text-left">届出番号</th>
          <th class="px-4 py-3 text-left">届出者</th>
          <th class="px-4 py-3 text-left">車種</th>
          <th class="px-4 py-3 text-left">不具合部位</th>
          <th class="px-4 py-3 text-center">故障モード数</th>
          <th class="px-4 py-3 text-center">操作</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">{rows}</tbody>
    </table>
  </div>
</div>
""" + FOOT


def make_recall_page(r: dict) -> str:
    rid = r["recall_id"]
    m = r["raw"].get("metadata", {})
    label = r["label"]
    spec = r["spec"]

    notifier = m.get("notifier", "")
    veh = m.get("affected_vehicles", [{}])
    vehicle = f"{veh[0].get('maker', '')} {veh[0].get('model', '')}".strip() if veh else ""
    defect_location = m.get("defect_location", "")
    defect_desc = m.get("defect_description", "")
    root_cause = m.get("root_cause", m.get("defect_cause", ""))
    consequences = m.get("consequences", [])

    failure_modes = label.get("failure_modes", [])
    top_events = label.get("top_event", [])

    consequences_html = "".join(f"<li>{c}</li>" for c in consequences)
    fm_html = "".join(f"<li class='py-1'>{fm}</li>" for fm in failure_modes)
    te_html = "".join(f"<li class='py-1'>{te}</li>" for te in top_events)

    fm_json = json.dumps(failure_modes, ensure_ascii=False)
    te_json = json.dumps(top_events, ensure_ascii=False)
    spec_json = json.dumps(spec, ensure_ascii=False)
    google_form_url = GOOGLE_FORM_URL

    return _css_head(f"レビュー: {rid}") + f"""
<div class="max-w-4xl mx-auto px-4 py-6">
  <div class="mb-4 flex items-center gap-3">
    <a href="index.html" class="text-blue-600 hover:underline">← 一覧に戻る</a>
    <span class="text-gray-300">|</span>
    <span class="font-mono text-gray-600">{rid}</span>
  </div>

  <!-- リコール概要 -->
  <section class="bg-white rounded-xl shadow p-6 mb-5">
    <h2 class="text-lg font-bold mb-4 text-gray-700 border-b pb-2">📄 リコール概要</h2>
    <div class="grid grid-cols-2 gap-x-6 gap-y-2 mb-4">
      <div><span class="text-gray-500">届出者：</span><span class="font-medium">{notifier}</span></div>
      <div><span class="text-gray-500">対象車種：</span><span class="font-medium">{vehicle}</span></div>
      <div class="col-span-2"><span class="text-gray-500">不具合部位：</span><span class="font-medium">{defect_location}</span></div>
    </div>
    <div class="mb-3">
      <p class="text-gray-500 mb-1">不具合内容：</p>
      <p class="bg-gray-50 rounded p-3 leading-relaxed">{defect_desc}</p>
    </div>
    <div class="mb-3">
      <p class="text-gray-500 mb-1">原因：</p>
      <p class="bg-gray-50 rounded p-3 leading-relaxed">{root_cause}</p>
    </div>
    <div>
      <p class="text-gray-500 mb-1">想定される結果：</p>
      <ul class="bg-gray-50 rounded p-3 list-disc list-inside space-y-1">{consequences_html}</ul>
    </div>
  </section>

  <!-- 部品正常仕様書 -->
  <section class="bg-white rounded-xl shadow p-6 mb-5">
    <div class="flex items-center justify-between mb-4 border-b pb-2">
      <h2 class="text-lg font-bold text-gray-700">📋 部品正常仕様書</h2>
      <span class="bg-amber-100 text-amber-700 text-xs px-2 py-1 rounded-full">AI生成・要確認</span>
    </div>
    <div id="spec-content" class="spec-content leading-relaxed text-gray-800"></div>
  </section>

  <!-- 故障モード -->
  <section class="bg-white rounded-xl shadow p-6 mb-5">
    <div class="flex items-center justify-between mb-4 border-b pb-2">
      <h2 class="text-lg font-bold text-gray-700">⚠️ 故障モード（正解ラベル候補）</h2>
      <span class="bg-amber-100 text-amber-700 text-xs px-2 py-1 rounded-full">AI生成・要確認</span>
    </div>
    <p class="text-gray-500 mb-3">形式: 「{{部品名}}が{{機能名}}を喪失する」</p>
    <ul class="list-disc list-inside space-y-1 bg-gray-50 rounded p-4">{fm_html}</ul>
  </section>

  <!-- トップ事象 -->
  <section class="bg-white rounded-xl shadow p-6 mb-5">
    <div class="flex items-center justify-between mb-4 border-b pb-2">
      <h2 class="text-lg font-bold text-gray-700">🔴 トップ事象</h2>
      <span class="bg-amber-100 text-amber-700 text-xs px-2 py-1 rounded-full">AI生成・要確認</span>
    </div>
    <p class="text-gray-500 mb-3">FTAで最終的に防ぐべき重大事象</p>
    <ul class="list-disc list-inside space-y-1 bg-gray-50 rounded p-4">{te_html}</ul>
  </section>

  <!-- フィードバック -->
  <section class="bg-white rounded-xl shadow p-6 mb-8" id="feedback">
    <h2 class="text-lg font-bold text-gray-700 mb-2 border-b pb-2">✏️ フィードバック入力</h2>
    <p class="text-gray-500 mb-5">上の内容を確認したら、下のボタンからGoogleフォームを開いて回答してください。</p>

    <a href="{google_form_url}&entry.RECALL_ID={rid}"
       target="_blank"
       class="inline-block bg-blue-600 text-white px-8 py-3 rounded-lg hover:bg-blue-700 font-bold text-base shadow">
      📋 Googleフォームを開いて回答する →
    </a>

    <div class="mt-6 p-4 bg-gray-50 rounded-lg text-gray-600 text-xs">
      <p class="font-semibold mb-1">フォームで入力する内容：</p>
      <ul class="list-disc list-inside space-y-1">
        <li>お名前</li>
        <li>届出番号（自動入力される場合あり）</li>
        <li>仕様書の評価（問題なし / 要修正）＋コメント</li>
        <li>故障モードの評価（各項目ごとに OK / 要修正）＋不足モード</li>
        <li>トップ事象の評価（OK / 要修正）＋修正案</li>
        <li>全体コメント</li>
      </ul>
    </div>
  </section>
</div>

<script>
// Render markdown spec
document.getElementById('spec-content').innerHTML = marked.parse({spec_json});
</script>
""" + FOOT


def main():
    OUTPUT_DIR.mkdir(exist_ok=True)

    recalls = []
    for d in sorted(DATA_DIR.iterdir()):
        if not d.is_dir():
            continue
        r = load_recall(d.name)
        if r:
            recalls.append(r)

    print(f"対象: {len(recalls)} 件")

    # index.html
    (OUTPUT_DIR / "index.html").write_text(make_index(recalls), encoding="utf-8")
    print("生成: review/index.html")

    # 各リコールページ
    for r in recalls:
        path = OUTPUT_DIR / f"{r['recall_id']}.html"
        path.write_text(make_recall_page(r), encoding="utf-8")
        print(f"生成: review/{r['recall_id']}.html")

    print(f"\n✅ 完了: review/ に {len(recalls) + 1} ファイル生成")
    print(f"  → review/index.html をブラウザで開いてください")


if __name__ == "__main__":
    main()
