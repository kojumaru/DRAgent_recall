import { useState } from 'react';
import type { TopEventReview, TopEventReviewSubmission } from '../api';

type Verdict = 'approved' | 'needs_fix';

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
  const [verdict, setVerdict] = useState<Verdict | null>(
    (existingReview?.verdict as Verdict) ?? null,
  );
  const [suggested, setSuggested] = useState(existingReview?.suggested_top_event ?? '');
  const [comment, setComment] = useState(existingReview?.comment ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!reviewer.trim()) { setError('レビュアー名を入力してください'); return; }
    if (!verdict) { setError('判定を選択してください'); return; }
    setSaving(true); setError('');
    try {
      const body: TopEventReviewSubmission = {
        reviewer, verdict, suggested_top_event: suggested, comment,
      };
      const res = await fetch(`${apiBase}/${recallId}/top_event_review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({ detail: res.statusText })); throw new Error(err.detail); }
      onSaved(await res.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <h2 className="text-sm font-bold text-neutral-800">トップ事象レビュー</h2>

      <p className="text-[11px] leading-relaxed text-neutral-500">
        FTA生成のトップ事象が、リコール届出書の内容に対して適切かを評価してください。
        不適切な場合は代替案を記入します。
      </p>

      {/* トップ事象表示 */}
      <div>
        <p className="mb-1 text-[11px] font-semibold text-neutral-500">現在のトップ事象</p>
        {topEvents.length === 0 ? (
          <p className="text-[12px] text-neutral-400">トップ事象が設定されていません。</p>
        ) : (
          <div className="flex flex-col gap-1">
            {topEvents.map((te, i) => (
              <div
                key={i}
                className="rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-[14px] font-semibold text-indigo-900"
              >
                {te}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 判定 */}
      <div>
        <p className="mb-2 text-[11px] font-semibold text-neutral-600">判定</p>
        <div className="flex gap-3">
          {([
            { v: 'approved' as Verdict,  label: '✓ 承認（このトップ事象で適切）',   active: 'bg-green-100 border-green-400 text-green-800' },
            { v: 'needs_fix' as Verdict, label: '✗ 要修正（トップ事象を修正する）', active: 'bg-red-100 border-red-400 text-red-800' },
          ]).map(({ v, label, active }) => (
            <button
              key={v}
              onClick={() => setVerdict(v)}
              className={`flex-1 rounded border px-3 py-2 text-[12px] font-semibold transition-all ${
                verdict === v ? active : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 要修正の場合：代替案 */}
      {verdict === 'needs_fix' && (
        <div>
          <p className="mb-1 text-[11px] font-semibold text-neutral-600">
            修正後のトップ事象（任意）
          </p>
          <textarea
            value={suggested}
            onChange={(e) => setSuggested(e.target.value)}
            placeholder="例: エンジンが意図せず停止するおそれがある"
            rows={2}
            className="w-full rounded border border-red-200 bg-white px-2 py-1.5 text-[12px] text-neutral-700 placeholder-neutral-300 focus:outline-none focus:ring-1 focus:ring-red-400"
          />
        </div>
      )}

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
          placeholder="コメント（任意）"
          rows={2}
          className="rounded border border-neutral-300 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
        {error && <p className="text-[11px] text-red-600">{error}</p>}
        <button
          onClick={handleSave}
          disabled={saving || !verdict}
          className={`rounded px-4 py-2 text-[12px] font-semibold text-white transition-colors ${
            verdict ? 'bg-indigo-600 hover:bg-indigo-700' : 'cursor-not-allowed bg-neutral-300'
          }`}
        >
          {saving ? '保存中...' : 'レビューを保存'}
        </button>
      </div>

      {/* 保存済み表示 */}
      {existingReview && (
        <div className="rounded border border-green-200 bg-green-50 p-2 text-[11px] text-green-700">
          最終レビュー: {existingReview.reviewer} — {new Date(existingReview.reviewed_at).toLocaleString('ja-JP')}
          {' '}({existingReview.verdict === 'approved' ? '✓ 承認' : '✗ 要修正'})
          {existingReview.suggested_top_event && (
            <p className="mt-1 text-neutral-600">代替案: {existingReview.suggested_top_event}</p>
          )}
        </div>
      )}
    </div>
  );
}
