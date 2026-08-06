"""
客観評価スクリプト（LLM judge を使わない決定論的評価）。

label.json（正解ラベル、＝実際に起きたリコールの内容）と output.yaml（FTA生成結果）
を比較し、LLMを呼ばずに再現可能な指標を算出して objective.json に保存する。

## 評価する指標

- component  : リコールされた部品が、FTAの中に含まれているか（含む/含まない）
- failure_mode: リコールされた故障モードが、FTAの中に含まれているか（含む/含まない）
- causal_chain: リコールで実際に起きた因果の流れ（根本原因→トップ事象）が、
                FTAの 葉→トップ パス上に順序を保って何割現れるか

## 設計方針（意図的にやらないこと）

- **完全一致は求めない**。表記ゆれを許容し、意味が近ければ「含む」と判定する。
- **precision（生成側の余剰チェック）は測らない**。FTAが正解にない周辺の
  故障モードや部品を挙げること自体は、網羅的な分析として正当な振る舞い
  であり、減点対象にしない。見るのは「リコールされたものが漏れなく
  含まれているか」の一点。

## 照合方法（何をもって「含まれている」と判定するか）

**既定は文字列類似度（difflib）**。「見た目の一致」しか見ないため、言い換え
（「浸水」と「水の侵入」等）を見逃す弱点はあるが、無関係な語同士を誤って
一致と判定するリスクは低い。見逃しはレビュー画面で必ず人の目に触れるため
安全側に倒れる、という理由でこれを既定にしている。

`--embedding azure` / `--embedding local` で埋め込みによる意味照合を
試すこともできるが、**実測で汎用の多言語埋め込みモデルが「別部品だが
構文が似ている」ペアを高スコアで誤って一致判定する**ことを確認している
（例: 「リレー付電気配線（追加ハーネス）」と「スイッチ周辺シール部」が
類似度0.8超）。この種の誤検出は「含まれている」扱いのまま専門家レビューを
素通りするため、危険側に倒れる。ドメインに合った埋め込みモデルが見つかる
までは使わないことを推奨する。

- `--embedding azure`: 環境変数 AZURE_OPENAI_ENDPOINT/API_KEY が必要。
  デプロイ名は AZURE_OPENAI_EMBEDDING_DEPLOYMENT（未設定時 "text-embedding-3-large"）
- `--embedding local`: sentence-transformers。環境変数 LOCAL_EMBEDDING_MODEL
  （未設定時 "paraphrase-multilingual-mpnet-base-v2"）。API不要・無料・オフライン動作

使用した方式・モデルを変えると数値の絶対水準（閾値の妥当性）が変わるため、
**同一方式・同一モデルで比較する場合のみスコアの比較に意味がある**。

実行:
  python scripts/objective_eval.py --id r8-01-28-005649
  python scripts/objective_eval.py                       # 全件（文字列類似度）
  python scripts/objective_eval.py --embedding local      # ローカル埋め込みを試す（注意点は上記）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dotenv import load_dotenv

load_dotenv()

BENCHMARK_ROOT = Path(__file__).parent.parent
DATA_DIR = BENCHMARK_ROOT / "data"

AOAI_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
AOAI_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")
AOAI_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2025-04-01-preview")
AOAI_EMBEDDING_DEPLOYMENT = os.environ.get(
    "AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-large"
)
# ローカル埋め込み（sentence-transformers）。Azure側にデプロイがなくても
# 会社の管理者を待たずに使える代替手段。日本語対応の多言語モデルを既定にする
LOCAL_EMBEDDING_MODEL = os.environ.get(
    "LOCAL_EMBEDDING_MODEL", "paraphrase-multilingual-mpnet-base-v2"
)

# 類似度の閾値。方式ごとにベクトル分布が異なるため別々に持つ
EMBEDDING_THRESHOLD = 0.60
LOCAL_EMBEDDING_THRESHOLD = 0.60
STRING_THRESHOLD = 0.55

# 照合前の正規化で除去する記号（括弧・区切り記号など表記ゆれ要因）
_PUNCT_RE = re.compile(r"[\s、。，．,.・()（）「」『』\[\]／/：:；;－\-]+")


# ---------------------------------------------------------------------------
# テキスト照合
# ---------------------------------------------------------------------------


def _normalize(text: str) -> str:
    """照合用にテキストを正規化する（NFKC・小文字化・記号除去）。

    Args:
        text: 元テキスト

    Returns:
        正規化済みテキスト
    """
    text = unicodedata.normalize("NFKC", text).lower()
    return _PUNCT_RE.sub("", text)


class TextMatcher:
    """日本語短文の照合器。既定は文字列類似度（difflib）。

    埋め込み（azure / local）は明示的にオプトインした場合のみ使う。実測で、
    汎用の多言語埋め込みモデルは「別部品だが構文が似ている」ペアを高スコアで
    誤って一致判定してしまうことを確認した（例: 「リレー付電気配線（追加ハーネス）」
    と「スイッチ周辺シール部」が類似度0.8超）。この種の誤判定（false positive）は
    「含まれている」扱いのまま専門家レビューで見逃されるため、危険側に倒れる。

    文字列類似度は逆に「言い換え」を拾えない（false negative）が、見逃しは
    レビュー画面で「missing」として必ず人の目に触れるため安全側に倒れる。
    このトレードオフから、既定は文字列類似度とする。

    使用した方式（string / azure / local）とモデル名は結果に記録する。
    """

    def __init__(self, method: str = "string") -> None:
        """照合器を初期化する。

        Args:
            method: "string"（既定）/ "azure" / "local"。
                    "azure"/"local" は明示指定時のみ埋め込みを試み、
                    失敗した場合は "string" にフォールバックする。
        """
        self._cache: dict[str, list[float]] = {}
        self._client = None
        self._local_model = None
        self.method = "string"
        self.model_name: str | None = None
        self.threshold = STRING_THRESHOLD

        if method == "azure":
            if not (AOAI_KEY and AOAI_ENDPOINT):
                print("  [WARN] AZURE_OPENAI_ENDPOINT/API_KEY が未設定、文字列類似度を使用")
                return
            from openai import AzureOpenAI

            self._client = AzureOpenAI(
                azure_endpoint=AOAI_ENDPOINT,
                api_key=AOAI_KEY,
                api_version=AOAI_API_VERSION,
            )
            self.method = "azure"
            self.model_name = AOAI_EMBEDDING_DEPLOYMENT
            self.threshold = EMBEDDING_THRESHOLD
        elif method == "local":
            self._init_local()

    def _init_local(self) -> None:
        """ローカル埋め込み（sentence-transformers）の読み込みを試みる。

        失敗した場合（未インストール等）は文字列類似度のまま据え置く。
        """
        try:
            from sentence_transformers import SentenceTransformer

            self._local_model = SentenceTransformer(LOCAL_EMBEDDING_MODEL)
            self.method = "local"
            self.model_name = LOCAL_EMBEDDING_MODEL
            self.threshold = LOCAL_EMBEDDING_THRESHOLD
        except Exception as e:
            print(f"  [WARN] ローカル埋め込みの読み込み失敗、文字列類似度へフォールバック: {e}")

    def prepare(self, texts: list[str]) -> None:
        """埋め込みをバッチ取得してキャッシュする（method="string" の場合は何もしない）。

        失敗した場合は文字列類似度にフォールバックする。

        Args:
            texts: 照合に使う全テキスト
        """
        todo = sorted({t for t in texts if t and t not in self._cache})
        if not todo:
            return

        if self.method == "azure":
            try:
                for i in range(0, len(todo), 100):
                    batch = todo[i : i + 100]
                    resp = self._client.embeddings.create(
                        model=AOAI_EMBEDDING_DEPLOYMENT, input=batch
                    )
                    for t, d in zip(batch, resp.data):
                        self._cache[t] = d.embedding
            except Exception as e:
                print(f"  [WARN] Azure埋め込み取得失敗、文字列類似度へフォールバック: {e}")
                self._client = None
                self.method = "string"
                self.model_name = None
                self.threshold = STRING_THRESHOLD
                self._cache.clear()
        elif self.method == "local":
            try:
                vectors = self._local_model.encode(todo, convert_to_numpy=True)
                for t, v in zip(todo, vectors):
                    self._cache[t] = v.tolist()
            except Exception as e:
                print(f"  [WARN] ローカル埋め込み取得失敗、文字列類似度へフォールバック: {e}")
                self._local_model = None
                self.method = "string"
                self.model_name = None
                self.threshold = STRING_THRESHOLD
                self._cache.clear()

    def similarity(self, a: str, b: str) -> float:
        """2テキストの類似度を返す（包含なら 1.0）。

        Args:
            a: テキスト1
            b: テキスト2

        Returns:
            類似度（0.0〜1.0）
        """
        na, nb = _normalize(a), _normalize(b)
        if not na or not nb:
            return 0.0
        if len(na) >= 2 and len(nb) >= 2 and (na in nb or nb in na):
            return 1.0
        va, vb = self._cache.get(a), self._cache.get(b)
        if va is not None and vb is not None:
            dot = sum(x * y for x, y in zip(va, vb))
            norm_a = sum(x * x for x in va) ** 0.5
            norm_b = sum(x * x for x in vb) ** 0.5
            return dot / (norm_a * norm_b) if norm_a and norm_b else 0.0
        return SequenceMatcher(None, na, nb).ratio()

    def best_match(self, query: str, candidates: list[str]) -> tuple[str | None, float]:
        """候補中で最も類似するテキストを返す。

        Args:
            query: 照合したいテキスト
            candidates: 候補テキスト群

        Returns:
            (最良候補（閾値未満なら None）, 類似度)
        """
        best, best_score = None, 0.0
        for c in candidates:
            s = self.similarity(query, c)
            if s > best_score:
                best, best_score = c, s
        if best_score >= self.threshold:
            return best, round(best_score, 3)
        return None, round(best_score, 3)


# ---------------------------------------------------------------------------
# FTA からの情報収集
# ---------------------------------------------------------------------------


def _collect_node_fields(fta_yaml: dict) -> dict:
    """FTA から照合に使うテキスト群とパス情報を収集する。

    トップレベルの `components:`（部品の目次・宣言リスト）は含めない。
    木の中で実際にその部品の故障を分析していなくても目次に名前を書くだけで
    「含まれている」と誤判定されてしまう抜け穴になるため、ここでは各ノードに
    実際に付与された `component:` 属性（＝そのノードで実際に扱った部品）だけを
    証拠として使う。

    Args:
        fta_yaml: output.yaml をパースした dict

    Returns:
        event_labels / label_details / node_components / component_to_labels
        （component属性値 → それを持つノードのラベル一覧）/ paths
        （トップ→葉の事象ラベル列のリスト）を持つ dict
    """
    event_labels: list[str] = []
    label_details: list[str] = []
    node_components: set[str] = set()
    component_to_labels: dict[str, list[str]] = {}
    paths: list[list[str]] = []

    def walk(node: object, trail: list[str]) -> None:
        """ノードを辿り、事象ラベルとトップ→葉のパスを収集する。

        Args:
            node: 現在のノード
            trail: ルートからここまでの事象ラベル列
        """
        if isinstance(node, list):
            for item in node:
                walk(item, trail)
            return
        if not isinstance(node, dict):
            return
        if node.get("type") != "event":
            # gate: 子（事象リスト）へ辿るだけで、パスには積まない
            if node.get("child"):
                walk(node["child"], trail)
            return

        label = node.get("label", "")
        event_labels.append(label)
        if node.get("label_detail"):
            label_details.append(node["label_detail"])
        if node.get("component"):
            node_components.add(node["component"])
            component_to_labels.setdefault(node["component"], []).append(label)
        trail = trail + [label]
        if node.get("child"):
            walk(node["child"], trail)
        else:
            # 葉事象（basic/undeveloped、または child のない individual）でパス確定
            paths.append(trail)

    walk(fta_yaml.get("nodes", []), [])
    return {
        "event_labels": event_labels,
        "label_details": label_details,
        "node_components": sorted(node_components),
        "component_to_labels": component_to_labels,
        "paths": paths,
    }


# ---------------------------------------------------------------------------
# 含有チェック（component / failure_mode）
# ---------------------------------------------------------------------------


def _containment_check(
    gt_items: list[str],
    search_pool: list[str],
    matcher: TextMatcher,
    component_to_labels: dict[str, list[str]] | None = None,
) -> dict:
    """正解の各要素が、生成側テキスト群のどこかに含まれているかを判定する。

    完全一致は求めず、意味的に近ければ「含む」と判定する。生成側に正解
    以外の要素がどれだけあるか（precision 相当）は評価しない —
    FTAが周辺の故障モードや部品を広く挙げること自体は正当な振る舞い。

    何割含まれていたかという度合い（coverage比率）も測らない。大量に
    生成されたリーフの中に、実際にリコールされたものが1件でも欠けて
    いれば見逃しであり、割合で薄めて良い性質のものではないため、
    「全件含まれていたか（all_found）」の合否のみを見る。

    Args:
        gt_items: 正解ラベルの要素（例: target_component）
        search_pool: 生成側のテキスト（ノードラベル・詳細説明など）
        matcher: 照合器
        component_to_labels: component属性値 → それを持つノードのラベル一覧。
            一致先がノードのラベルそのものではなく component 属性だった場合、
            木の図には表示されない値になるため、実際に対応するノードラベルを
            found エントリに付与して「木のどこにあるか」を辿れるようにする

    Returns:
        all_found（全件含まれていれば True）と found / missing の一覧を持つ dict
    """
    component_to_labels = component_to_labels or {}
    found, missing = [], []
    for gt in gt_items:
        best, score = matcher.best_match(gt, search_pool)
        if best is not None:
            entry = {"gt": gt, "matched_text": best, "score": score}
            node_labels = component_to_labels.get(best)
            if node_labels:
                entry["matched_node_labels"] = node_labels
            found.append(entry)
        else:
            missing.append({"gt": gt, "best_score": score})

    return {
        "all_found": (not missing) if gt_items else None,
        "n_total": len(gt_items),
        "n_found": len(found),
        "found": found,
        "missing": missing,
    }


def _chain_coverage(chain: list[str], paths: list[list[str]], matcher: TextMatcher) -> dict:
    """因果連鎖がFTAのパス上に順序を保って現れる被覆率を算出する。

    label.causal_chain は 根本原因→トップ事象 の順、FTAパスは トップ→葉 の順
    なので、パスを反転（葉→トップ = 原因→結果）してから、LCS 型の DP で
    順序を保った最大一致数を求める。全パス中の最良値を coverage とする。

    Args:
        chain: 正解の因果連鎖（根本原因→トップ事象）
        paths: FTAの トップ→葉 事象ラベル列
        matcher: 照合器

    Returns:
        coverage / matched_steps / total_steps / best_path / unmatched を持つ dict
    """
    if not chain:
        return {"coverage": None, "matched_steps": 0, "total_steps": 0}

    best_cov, best_detail = -1.0, None
    for path in paths:
        seq = list(reversed(path))  # 葉→トップ = 原因→結果 の向きに揃える
        n, m = len(chain), len(seq)
        # dp[i][j] = chain[:i] と seq[:j] の順序保存最大一致数
        dp = [[0] * (m + 1) for _ in range(n + 1)]
        for i in range(1, n + 1):
            for j in range(1, m + 1):
                hit = matcher.similarity(chain[i - 1], seq[j - 1]) >= matcher.threshold
                dp[i][j] = max(
                    dp[i - 1][j],
                    dp[i][j - 1],
                    dp[i - 1][j - 1] + (1 if hit else 0),
                )
        cov = dp[n][m] / n
        if cov > best_cov:
            # 一致ペアを復元して詳細を残す
            pairs = []
            i, j = n, m
            while i > 0 and j > 0:
                if (
                    dp[i][j] == dp[i - 1][j - 1] + 1
                    and matcher.similarity(chain[i - 1], seq[j - 1]) >= matcher.threshold
                ):
                    pairs.append({"chain": chain[i - 1], "node": seq[j - 1]})
                    i, j = i - 1, j - 1
                elif dp[i - 1][j] >= dp[i][j - 1]:
                    i -= 1
                else:
                    j -= 1
            pairs.reverse()
            matched_chain = {p["chain"] for p in pairs}
            best_cov = cov
            best_detail = {
                "coverage": round(cov, 3),
                "matched_steps": dp[n][m],
                "total_steps": n,
                "best_path": path,
                "matched": pairs,
                "unmatched": [c for c in chain if c not in matched_chain],
            }
    if best_detail is None:
        best_detail = {
            "coverage": 0.0,
            "matched_steps": 0,
            "total_steps": len(chain),
            "best_path": [],
            "matched": [],
            "unmatched": list(chain),
        }
    return best_detail


def evaluate_matching(label: dict, fta_yaml: dict, matcher: TextMatcher) -> dict:
    """含有チェックと因果連鎖被覆率をまとめて算出する。

    Args:
        label: label.json の内容
        fta_yaml: output.yaml の内容
        matcher: 照合器

    Returns:
        component / failure_mode / causal_chain の指標を持つ dict
    """
    fields = _collect_node_fields(fta_yaml)
    # トップレベルの components: 目次は使わない（実際にノードで分析された
    # 部品のみを根拠にする。理由は _collect_node_fields の docstring 参照）
    search_pool = fields["event_labels"] + fields["label_details"] + fields["node_components"]

    gt_components = label.get("target_component") or []
    gt_modes = label.get("failure_modes") or []
    gt_chain = label.get("causal_chain") or []

    # 埋め込みを一括取得（キャッシュ）
    matcher.prepare(gt_components + gt_modes + gt_chain + search_pool)

    component = _containment_check(
        gt_components, search_pool, matcher, component_to_labels=fields["component_to_labels"]
    )
    failure_mode = _containment_check(gt_modes, search_pool, matcher)
    causal_chain = _chain_coverage(gt_chain, fields["paths"], matcher)

    return {
        "matcher": matcher.method,
        "embedding_model": matcher.model_name,
        "threshold": matcher.threshold,
        "component": component,
        "failure_mode": failure_mode,
        "causal_chain": causal_chain,
    }


# ---------------------------------------------------------------------------
# 実行制御
# ---------------------------------------------------------------------------


def process_one(recall_id: str, matcher: TextMatcher, force: bool = False) -> dict | None:
    """1件の recall_id に対して客観評価を実行し objective.json に保存する。

    Args:
        recall_id: 対象 ID
        matcher: 照合器
        force: 既存 objective.json を上書きする

    Returns:
        評価結果 dict（スキップ時は None）
    """
    base = DATA_DIR / recall_id
    label_path = base / "label.json"
    output_path = base / "output.yaml"
    result_path = base / "objective.json"

    if not output_path.exists():
        print(f"  [SKIP] {recall_id}: output.yaml なし（FTA未生成）")
        return None
    if not label_path.exists():
        print(f"  [SKIP] {recall_id}: label.json なし")
        return None
    if result_path.exists() and not force:
        print(f"  [SKIP] {recall_id}: objective.json 既存")
        return json.loads(result_path.read_text(encoding="utf-8"))

    try:
        fta_yaml = yaml.safe_load(output_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        print(f"  [NG] {recall_id}: YAMLパース失敗（{e}）")
        return None

    label = json.loads(label_path.read_text(encoding="utf-8"))
    matching = evaluate_matching(label, fta_yaml, matcher)

    result = {"recall_id": recall_id, "matching": matching}
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    cc = matching["causal_chain"].get("coverage")
    print(
        f"  [OK] {recall_id}"
        f"  部品={_fmt_bool(matching['component']['all_found'])}"
        f"  故障モード={_fmt_bool(matching['failure_mode']['all_found'])}"
        f"  因果連鎖={_fmt(cc)}"
    )
    return result


def _fmt(v: float | None) -> str:
    """数値を表示用に整形する（None は '-'）。

    Args:
        v: 数値または None

    Returns:
        表示文字列
    """
    return f"{v:.2f}" if v is not None else "-"


def _fmt_bool(v: bool | None) -> str:
    """合否フラグを表示用に整形する（None は '-'）。

    Args:
        v: True/False または None

    Returns:
        表示文字列
    """
    if v is None:
        return "-"
    return "OK" if v else "NG"


def _summarize(results: list[dict]) -> None:
    """全件の集計値を表示する。

    合否指標（component / failure_mode）は「全件のリコールを見逃さず含めた
    ケースの割合（pass rate）」として集計する。個々の項目を薄めて平均する
    のではなく、1件でも見逃しがあれば NG というケース単位の合否を数える。

    Args:
        results: process_one の結果リスト
    """
    if not results:
        print("[objective] 対象データがありません")
        return

    def pass_rate(key_fn) -> str:
        """all_found の合格率を計算する（None は対象外）。"""
        vals = [v for r in results if (v := key_fn(r["matching"])) is not None]
        n_pass = sum(1 for v in vals if v)
        return f"{n_pass}/{len(vals)} ({n_pass / len(vals):.1%})" if vals else "-"

    def mean(key_fn) -> str:
        """指標の平均を計算する（None は除外）。"""
        vals = [v for r in results if (v := key_fn(r["matching"])) is not None]
        return f"{sum(vals) / len(vals):.3f} (n={len(vals)})" if vals else "-"

    print(f"\n[objective] {len(results)} 件評価")
    print(f"  部品        見逃しなし率: {pass_rate(lambda m: m['component']['all_found'])}")
    print(f"  故障モード  見逃しなし率: {pass_rate(lambda m: m['failure_mode']['all_found'])}")
    print(f"  因果連鎖 coverage       : {mean(lambda m: m['causal_chain'].get('coverage'))}")


def main() -> None:
    """CLI エントリポイント。"""
    parser = argparse.ArgumentParser(description="客観指標（見逃しなし率・因果連鎖被覆率）でFTAを評価")
    parser.add_argument("--id", metavar="RECALL_ID", help="特定 recall_id のみ処理")
    parser.add_argument("--force", action="store_true", help="既存 objective.json を上書き")
    parser.add_argument(
        "--embedding",
        choices=["azure", "local"],
        default=None,
        help="埋め込みによる意味照合を試す（既定は文字列類似度。誤検出リスクの注意点はモジュールdocstring参照）",
    )
    args = parser.parse_args()

    matcher = TextMatcher(method=args.embedding or "string")
    label = f"{matcher.method}:{matcher.model_name}" if matcher.model_name else matcher.method
    print(f"[objective] 照合方式: {label}（閾値 {matcher.threshold}）")

    recall_ids = [args.id] if args.id else sorted(d.name for d in DATA_DIR.iterdir() if d.is_dir())
    results = []
    for rid in recall_ids:
        r = process_one(rid, matcher, force=args.force)
        if r is not None:
            results.append(r)
    _summarize(results)


if __name__ == "__main__":
    main()
