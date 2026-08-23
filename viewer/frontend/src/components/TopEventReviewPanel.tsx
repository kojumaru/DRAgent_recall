import { useState } from 'react';
import { saveTopEventReview } from '../api';
import type { TopEventReview, TopEventEventReview } from '../api';

type Verdict = 'approved' | 'needs_fix';

const VERDICT_STYLES: Record<Verdict, { bg: string; text: string; label: string }> = {
  approved:  { bg: 'bg-green-100 border-green-400',  text: 'text-green-800',  label: '✓ 正しい' },
  needs_fix: { bg: 'bg-red-100 border-red-400',      text: 'text-red-800',    label: '✗ 要修正' },
};

function VerdictButton({
  current, value, onClick,
}: { current: Verdict | null; value: Verdict; onClick: () => void }) {
  const style = VERDICT_STYLES[value];
  const active = current === value;
  return (
    <button
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] font-semibold transition-all ${
        active ? `${style.bg} ${style.text}` : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-400'
      }`}
    >
      {style.label}
    </button>
  );
}

export default function TopEventReviewPanel({
  recallId,
  topEvents,
  existingReview,
  onSaved,
  apiBase = '/api/recalls',
}: {
  recallId: string;
  topEvents: string[];
  existingReview: TopEventReview | null;
  onSaved: (r: TopEventReview) => void;
  apiBase?: string;
}) {
  const [reviewer, setReviewer] = useState(existingReview?.reviewer ?? '');
  const [itemReviews, setItemReviews] = useState<Record<string, Verdict | null>>(() => {
    const init: Record<string, Verdict | null> = {};
    for (const te of topEvents) {
      const existing = existingReview?.event_reviews?.find((e) => e.top_event === te);
      init[te] = (existing?.verdict as Verdict) ?? null;
    }
    return init;
  });
  const [suggested, setSuggested] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const te of topEvents) {
      const existing = existingReview?.event_reviews?.find((e) => e.top_event === te);
      init[te] = existing?.suggested ?? '';
    }
    return init;
  });
  const [missingInput, setMissingInput] = useState('');
  const [missingItems, setMissingItems] = useState<string[]>(existingReview?.missing_items ?? []);
  const [comment, setComment] = useState(existingReview?.comment ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reviewedCount = Object.values(itemReviews).filter((v) => v !== null).length;
  const allDone = topEvents.length > 0 && reviewedCount === topEvents.length;

  const overallVerdict = (): 'approved' | 'needs_fix' =>
    Object.values(itemReviews).some((v) => v === 'needs_fix') || missingItems.length > 0
      ? 'needs_fix'
      : 'approved';

  const approveAll = () => {
    setItemReviews((prev) => {
      const next = { ...prev };
      for (const te of topEvents) next[te] = 'approved';
      return next;
    });
  };

  const addMissing = () => {
    const trimmed = missingInput.trim();
    if (!trimmed || missingItems.includes(trimmed)) return;
    setMissingItems((prev) => [...prev, trimmed]);
    setMissingInput('');
  };

  const handleSave = async () => {
    if (!reviewer.trim()) { setError('レビュアー名を入力してください'); return; }
    setSaving(true); setError('');
    try {
      const event_reviews: TopEventEventReview[] = topEvents.map((te) => ({
        top_event: te,
        verdict: (itemReviews[te] ?? 'needs_fix') as Verdict,
        suggested: suggested[te] ?? '',
        comment: '',
      }));
      const result = await saveTopEventReview(
        recallId,
        { reviewer, event_reviews, missing_items: missingItems, comment },
        apiBase,
      );
      onSaved(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  if (topEvents.length === 0) {
    return (
      <div className="p-4 text-[13px] text-neutral-400">
        label.json にトップ事象が設定されていません。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-neutral-800">トップ事象レビュー</h2>
        <span className="text-[11px] text-neutral-400">{reviewedCount}/{topEvents.length} 評価済み</span>
      </div>

      <p className="text-[11px] leading-relaxed text-neutral-500">
        各トップ事象がFTA生成に使えるか評価してください。
        欠落しているトップ事象があれば「不足項目を追加」で記録します。
      </p>

      {/* 一括承認 */}
      <button
        onClick={approveAll}
        className="self-start rounded border border-green-300 bg-green-50 px-3 py-1 text-[11px] font-semibold text-green-800 hover:bg-green-100"
      >
        全て承認
      </button>

      {/* 項目別 */}
      <div className="flex flex-col gap-2">
        {topEvents.map((te) => {
          const verdict = itemReviews[te] ?? null;
          const style = verdict ? VERDICT_STYLES[verdict] : null;
          return (
            <div
              key={te}
              className={`rounded border p-2.5 transition-colors ${
                style ? style.bg : 'border-neutral-200 bg-white'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[12px] font-semibold ${style?.text ?? 'text-neutral-700'}`}>
                  {te}
                </span>
                <div className="flex shrink-0 gap-1">
                  {(['approved', 'needs_fix'] as Verdict[]).map((v) => (
                    <VerdictButton
                      key={v}
                      current={verdict}
                      value={v}
                      onClick={() => setItemReviews((prev) => ({ ...prev, [te]: v }))}
                    />
                  ))}
                </div>
              </div>
              {verdict === 'needs_fix' && (
                <input
                  type="text"
                  value={suggested[te] ?? ''}
                  onChange={(e) => setSuggested((prev) => ({ ...prev, [te]: e.target.value }))}
                  placeholder="修正後のトップ事象（任意）"
                  className="mt-2 w-full rounded border border-red-200 bg-white px-2 py-1 text-[11px] placeholder-neutral-300 focus:outline-none focus:ring-1 focus:ring-red-400"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* 不足項目 */}
      <div className="rounded border border-amber-200 bg-amber-50 p-3">
        <p className="mb-2 text-[11px] font-semibold text-amber-800">不足しているトップ事象を追加（任意）</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={missingInput}
            onChange={(e) => setMissingInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addMissing()}
            placeholder="例: 走行中に車両が停止しない"
            className="flex-1 rounded border border-amber-300 bg-white px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
          <button
            onClick={addMissing}
            className="rounded border border-amber-400 bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-200"
          >
            追加
          </button>
        </div>
        {missingItems.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {missingItems.map((item, i) => (
              <div key={i} className="flex items-center justify-between rounded bg-white px-2 py-1 text-[11px]">
                <span className="text-neutral-700">・{item}</span>
                <button
                  onClick={() => setMissingItems((prev) => prev.filter((_, j) => j !== i))}
                  className="text-neutral-400 hover:text-red-500"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 保存フォーム */}
      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3">
        <input
          type="text"
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
          placeholder="レビュアー名"
          className="rounded border border-neutral-300 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="全体コメント（任意）"
          rows={2}
          className="rounded border border-neutral-300 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
        {error && <p className="text-[11px] text-red-600">{error}</p>}
        <button
          onClick={handleSave}
          disabled={saving || !allDone}
          className={`rounded px-4 py-2 text-[12px] font-semibold text-white transition-colors ${
            allDone ? 'bg-indigo-600 hover:bg-indigo-700' : 'cursor-not-allowed bg-neutral-300'
          }`}
        >
          {saving ? '保存中...' : allDone ? 'レビューを保存' : `残り ${topEvents.length - reviewedCount} 件`}
        </button>
      </div>

      {/* 保存済み表示 */}
      {existingReview && (
        <div className="rounded border border-green-200 bg-green-50 p-2 text-[11px] text-green-700">
          最終レビュー: {existingReview.reviewer} — {new Date(existingReview.reviewed_at).toLocaleString('ja-JP')}
          {' '}({overallVerdict() === 'approved' ? '✓ 承認' : '✗ 要修正'})
        </div>
      )}
    </div>
  );
}
