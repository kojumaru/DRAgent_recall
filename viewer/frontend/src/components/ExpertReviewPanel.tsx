import { useEffect, useState } from 'react';
import { saveExpertReview } from '../api';
import type { ExpertReview, ExpertReviewSubmission, PerItemScoreEntry } from '../api';

// ---------------------------------------------------------------------------
// 5段階評価基準（画面上部に常時表示）
// ---------------------------------------------------------------------------

const SCORE_CRITERIA: { score: number; label: string; description: string; color: string }[] = [
  { score: 5, label: '完全に含まれている', description: '同一または同義の表現でFTA内に完全に表現されている', color: 'text-green-700' },
  { score: 4, label: 'ほぼ含まれている', description: '言い換え・上位概念・近似表現などで含まれているが、表現や粒度がやや異なる', color: 'text-green-600' },
  { score: 3, label: '間接的に含まれている', description: '関連する記述はあるが直接的な表現ではない（周辺事象として間接的に示唆されている）', color: 'text-yellow-700' },
  { score: 2, label: '部分的にしか含まれていない', description: '部分的にしか表れておらず、重要な側面が欠けている', color: 'text-orange-600' },
  { score: 1, label: 'ほとんど含まれていない', description: 'ほとんど含まれていない（または全く含まれていない）', color: 'text-red-700' },
];

function CriteriaBox() {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-3 rounded border border-blue-200 bg-blue-50">
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-semibold text-blue-800"
        onClick={() => setOpen((v) => !v)}
      >
        <span>評価基準（1〜5）</span>
        <span className="text-[10px]">{open ? '▲ 折り畳む' : '▼ 表示する'}</span>
      </button>
      {open && (
        <div className="border-t border-blue-200 px-3 pb-2">
          {SCORE_CRITERIA.map(({ score, label, description, color }) => (
            <div key={score} className="mt-1.5 flex items-start gap-2 text-[11px]">
              <span className={`shrink-0 rounded px-1 py-0.5 text-[11px] font-bold ${color}`}>
                {score}
              </span>
              <span>
                <span className={`font-semibold ${color}`}>{label}</span>
                <span className="text-neutral-500"> — {description}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1項目分の評価行（ラジオ 1〜5）
// ---------------------------------------------------------------------------

function ScoreRow({
  label,
  index,
  score,
  onChange,
}: {
  label: string;
  index: number;
  score: number | null;
  onChange: (score: number) => void;
}) {
  return (
    <div
      className={`rounded border p-2 ${
        score === null ? 'border-amber-300 bg-amber-50' : 'border-neutral-200 bg-white'
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-neutral-800">
          {index != null ? `${index + 1}. ` : ''}{label}
        </span>
        {score === null && (
          <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">
            未評価
          </span>
        )}
      </div>
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map((v) => (
          <label key={v} className="flex cursor-pointer flex-col items-center gap-0.5">
            <input
              type="radio"
              name={`score_${label}`}
              checked={score === v}
              onChange={() => onChange(v)}
              className="accent-blue-600"
            />
            <span
              className={`text-[11px] font-semibold ${
                score === v ? SCORE_CRITERIA.find((c) => c.score === v)?.color ?? 'text-blue-700' : 'text-neutral-400'
              }`}
            >
              {v}
            </span>
          </label>
        ))}
        {score !== null && (
          <span className={`ml-2 self-center text-[11px] font-medium ${SCORE_CRITERIA.find((c) => c.score === score)?.color}`}>
            — {SCORE_CRITERIA.find((c) => c.score === score)?.label}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

interface Props {
  recallId: string;
  failureModes: string[];
  existingReviews: ExpertReview[];
  onSaved: (review: ExpertReview) => void;
}

export default function ExpertReviewPanel({
  recallId,
  failureModes,
  existingReviews,
  onSaved,
}: Props) {
  const [reviewer, setReviewer] = useState('');
  const [fmScores, setFmScores] = useState<(number | null)[]>(() => failureModes.map(() => null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);

  // レビュアー名が変わったら既存レビューを復元
  useEffect(() => {
    const existing = existingReviews.find((r) => r.reviewer === reviewer);
    if (existing) {
      setFmScores(failureModes.map((item) => existing.failure_modes.find((e) => e.item === item)?.score ?? null));
    } else {
      setFmScores(failureModes.map(() => null));
    }
  }, [reviewer]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalItems = failureModes.length;
  const answeredCount = fmScores.filter((s) => s !== null).length;

  const handleSave = async () => {
    if (!reviewer.trim()) {
      setError('レビュアー名を入力してください。');
      return;
    }
    setSaving(true);
    setError(null);
    setSavedMsg(false);
    try {
      const body: ExpertReviewSubmission = {
        reviewer,
        failure_modes: failureModes.map((item, i) => ({ item, score: fmScores[i] ?? 0 })),
      };
      const saved = await saveExpertReview(recallId, body);
      onSaved(saved);
      setSavedMsg(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const currentReview = existingReviews.find((r) => r.reviewer === reviewer);

  return (
    <section>
      <h2 className="mb-2 text-sm font-bold text-neutral-800">専門家評価（5段階）</h2>

      <p className="mb-3 text-[11px] leading-relaxed text-neutral-500">
        右のFTAツリーを参照しながら、正解ラベルの各故障モードがFTAにどの程度含まれているかを1〜5で評価してください。
        トップ事象は当然含まれるため評価対象外です。
      </p>

      <CriteriaBox />

      {/* レビュアー名 */}
      <div className="mb-3">
        <label className="mb-1 block text-xs font-semibold text-neutral-500">
          レビュアー名（必須）
        </label>
        <input
          type="text"
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
          placeholder="例: 田中太郎"
          className="w-full rounded border border-neutral-300 px-2 py-1 text-[13px]"
        />
        {existingReviews.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {existingReviews.map((r) => (
              <button
                key={r.reviewer}
                onClick={() => setReviewer(r.reviewer)}
                className={`rounded border px-2 py-0.5 text-[11px] ${
                  reviewer === r.reviewer
                    ? 'border-blue-400 bg-blue-50 text-blue-700'
                    : 'border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50'
                }`}
              >
                {r.reviewer}
                <span className="ml-1 text-[10px] text-green-600">✓ 評価済</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 進捗 */}
      <div className="mb-2 text-[12px] font-semibold">
        <span className={answeredCount === totalItems ? 'text-green-700' : 'text-amber-700'}>
          評価済み {answeredCount} / {totalItems} 件
        </span>
      </div>

      {/* 故障モード（5段階） */}
      {failureModes.length > 0 ? (
        <div className="mb-3">
          <h3 className="mb-0.5 text-xs font-bold text-neutral-700">故障モード</h3>
          <p className="mb-1.5 text-[11px] text-neutral-500">
            リコールで報告された各故障モードが、生成FTAにどの程度含まれているか評価してください。
          </p>
          <div className="flex flex-col gap-1.5">
            {failureModes.map((item, i) => (
              <ScoreRow
                key={item}
                label={item}
                index={i}
                score={fmScores[i]}
                onChange={(v) => setFmScores((prev) => { const next = [...prev]; next[i] = v; return next; })}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="mb-3 text-[11px] text-neutral-400">このリコールには故障モードのラベルがありません。</p>
      )}

      {/* 保存 */}
      {failureModes.length > 0 && answeredCount < totalItems && (
        <p className="mb-1.5 text-[11px] text-amber-700">
          未評価の項目が {totalItems - answeredCount} 件あります（保存は可能ですが、全件評価を推奨します）。
        </p>
      )}
      {error && <p className="mb-1.5 text-[12px] text-red-600">{error}</p>}
      {savedMsg && <p className="mb-1.5 text-[12px] text-green-700">保存しました。</p>}

      <button
        onClick={handleSave}
        disabled={saving || !reviewer.trim()}
        className="rounded bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? '保存中...' : '保存'}
      </button>

      {currentReview && (
        <p className="mt-1.5 text-[11px] text-neutral-400">
          前回保存: {currentReview.reviewed_at}
        </p>
      )}

      {/* 複数人の評価一覧 */}
      {existingReviews.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-neutral-500 hover:text-neutral-700">
            評価済み専門家一覧（{existingReviews.length} 人）
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5 pl-2">
            {existingReviews.map((r) => (
              <div key={r.reviewer} className="rounded border border-neutral-200 bg-neutral-50 p-2 text-[11px]">
                <div className="font-semibold text-neutral-700">{r.reviewer}</div>
                <div className="text-neutral-500">{r.reviewed_at}</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {r.failure_modes.map((f) => (
                    <span key={f.item} className="text-neutral-600">
                      {f.item}: <span className="font-semibold">{f.score}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
