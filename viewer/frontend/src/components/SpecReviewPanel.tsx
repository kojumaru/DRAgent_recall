import { useState } from 'react';
import { saveSpecReview } from '../api';
import type { SpecReview, SpecReviewSubmission, SpecSectionReview } from '../api';

const SECTIONS: { num: string; name: string }[] = [
  { num: '1', name: '対象部品の特定' },
  { num: '2', name: 'システム内での役割' },
  { num: '3', name: '構成・関連部品' },
  { num: '4', name: '入力仕様' },
  { num: '5', name: '出力仕様' },
  { num: '6', name: '正常動作シーケンス' },
  { num: '7', name: '使用環境・要求条件' },
];

type SectionVerdict = 'approved' | 'needs_fix' | 'skipped';

const VERDICT_STYLES: Record<SectionVerdict, { bg: string; text: string; label: string }> = {
  approved:  { bg: 'bg-green-100 border-green-400',  text: 'text-green-800',  label: '✓ OK' },
  needs_fix: { bg: 'bg-red-100 border-red-400',      text: 'text-red-800',    label: '✗ 要修正' },
  skipped:   { bg: 'bg-neutral-100 border-neutral-300', text: 'text-neutral-500', label: '— スキップ' },
};

function VerdictButton({
  current, value, onClick,
}: { current: SectionVerdict | null; value: SectionVerdict; onClick: () => void }) {
  const style = VERDICT_STYLES[value];
  const active = current === value;
  return (
    <button
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] font-semibold transition-all ${
        active
          ? `${style.bg} ${style.text}`
          : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-400'
      }`}
    >
      {style.label}
    </button>
  );
}

function SavedReviewToggle({ review }: { review: SpecReview }) {
  const [open, setOpen] = useState(false);

  const verdictLabel =
    review.verdict === 'approved' ? '✓ 承認' :
    review.verdict === 'needs_fix' ? '✗ 要修正' : '— スキップ';
  const verdictColor =
    review.verdict === 'approved' ? 'text-green-700 border-green-200 bg-green-50' :
    review.verdict === 'needs_fix' ? 'text-red-700 border-red-200 bg-red-50' :
    'text-neutral-600 border-neutral-200 bg-neutral-50';

  return (
    <div className={`rounded border text-[11px] ${verdictColor}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left font-semibold"
      >
        <span>
          {verdictLabel} — {review.reviewer}
          <span className="ml-2 font-normal opacity-70">
            {new Date(review.reviewed_at).toLocaleString('ja-JP')}
          </span>
        </span>
        <span className="ml-2 opacity-60">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-current/20 px-3 pb-3 pt-2 flex flex-col gap-2">
          {review.comment && (
            <p className="whitespace-pre-wrap">{review.comment}</p>
          )}
          {Object.entries(review.section_reviews ?? {}).map(([num, sr]) => {
            if (!sr || sr.verdict === 'skipped') return null;
            const section = SECTIONS.find((s) => s.num === num);
            const style = VERDICT_STYLES[sr.verdict as SectionVerdict];
            return (
              <div key={num} className={`rounded border p-2 ${style.bg} ${style.text}`}>
                <span className="font-semibold">§{num} {section?.name}</span>
                <span className="ml-2 text-[10px]">{style.label}</span>
                {sr.comment && <p className="mt-1 whitespace-pre-wrap">{sr.comment}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function SpecReviewPanel({
  recallId,
  spec,
  existingReview,
  onSaved,
  apiBase = '/api/recalls',
}: {
  recallId: string;
  spec: string;
  existingReview: SpecReview | null;
  onSaved: (r: SpecReview) => void;
  apiBase?: string;
}) {
  const [reviewer, setReviewer] = useState(existingReview?.reviewer ?? '');
  const [overallComment, setOverallComment] = useState(existingReview?.comment ?? '');
  const [sections, setSections] = useState<Record<string, { verdict: SectionVerdict | null; comment: string }>>(() => {
    const init: Record<string, { verdict: SectionVerdict | null; comment: string }> = {};
    for (const s of SECTIONS) {
      const existing = existingReview?.section_reviews?.[s.num];
      init[s.num] = { verdict: existing?.verdict ?? null, comment: existing?.comment ?? '' };
    }
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const setSection = (num: string, field: 'verdict' | 'comment', value: string) => {
    setSections((prev) => ({ ...prev, [num]: { ...prev[num], [field]: value } }));
  };

  const skipAll = () => {
    setSections((prev) => {
      const next = { ...prev };
      for (const s of SECTIONS) next[s.num] = { ...next[s.num], verdict: 'skipped' };
      return next;
    });
  };

  const approveAll = () => {
    setSections((prev) => {
      const next = { ...prev };
      for (const s of SECTIONS) next[s.num] = { ...next[s.num], verdict: 'approved' };
      return next;
    });
  };

  const overallVerdict = (): 'approved' | 'needs_fix' | 'skipped' => {
    const verdicts = Object.values(sections).map((s) => s.verdict);
    if (verdicts.every((v) => v === 'skipped')) return 'skipped';
    if (verdicts.some((v) => v === 'needs_fix')) return 'needs_fix';
    if (verdicts.every((v) => v === 'approved' || v === 'skipped')) return 'approved';
    return 'needs_fix';
  };

  const handleSave = async () => {
    if (!reviewer.trim()) { setError('レビュアー名を入力してください'); return; }
    setSaving(true);
    setError('');
    try {
      const sectionReviews: Record<string, SpecSectionReview> = {};
      for (const [num, s] of Object.entries(sections)) {
        sectionReviews[num] = { verdict: s.verdict ?? 'skipped', comment: s.comment };
      }
      const body: SpecReviewSubmission = {
        reviewer,
        verdict: overallVerdict(),
        comment: overallComment,
        section_reviews: sectionReviews,
      };
      const result = await saveSpecReview(recallId, body, apiBase);
      setReviewer('');
      setOverallComment('');
      setSections(() => {
        const reset: Record<string, { verdict: SectionVerdict | null; comment: string }> = {};
        for (const s of SECTIONS) reset[s.num] = { verdict: null, comment: '' };
        return reset;
      });
      setSaved(true);
      onSaved(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  // セクション番号ごとの本文を spec から切り出す
  const parseSections = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < SECTIONS.length; i++) {
      const s = SECTIONS[i];
      const next = SECTIONS[i + 1];
      const startRe = new RegExp(`## ${s.num}\\.`);
      const endRe = next ? new RegExp(`## ${next.num}\\.`) : null;
      const startIdx = text.search(startRe);
      if (startIdx < 0) { out[s.num] = ''; continue; }
      const endIdx = endRe ? text.search(endRe) : -1;
      out[s.num] = endIdx > 0 ? text.slice(startIdx, endIdx) : text.slice(startIdx);
    }
    return out;
  };

  const sectionTexts = parseSections(spec);

  const reviewedCount = Object.values(sections).filter((s) => s.verdict !== null).length;
  const allDone = reviewedCount === SECTIONS.length;

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-neutral-800">仕様書レビュー</h2>
        <span className="text-[11px] text-neutral-400">{reviewedCount}/{SECTIONS.length} セクション評価済み</span>
      </div>

      {/* 一括ボタン */}
      <div className="flex gap-2">
        <button
          onClick={approveAll}
          className="rounded border border-green-300 bg-green-50 px-3 py-1 text-[11px] font-semibold text-green-800 hover:bg-green-100"
        >
          全て承認
        </button>
        <button
          onClick={skipAll}
          className="rounded border border-neutral-300 bg-neutral-50 px-3 py-1 text-[11px] font-semibold text-neutral-600 hover:bg-neutral-100"
        >
          全てスキップ（レビュー不要）
        </button>
      </div>

      {/* セクション別 */}
      <div className="flex flex-col gap-3">
        {SECTIONS.map((s) => {
          const state = sections[s.num];
          const verdictStyle = state.verdict ? VERDICT_STYLES[state.verdict] : null;
          return (
            <div
              key={s.num}
              className={`rounded border p-3 transition-colors ${
                verdictStyle ? verdictStyle.bg : 'border-neutral-200 bg-white'
              }`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className={`font-semibold ${verdictStyle?.text ?? 'text-neutral-700'}`}>
                  §{s.num} {s.name}
                </span>
                <div className="flex gap-1">
                  {(['approved', 'needs_fix', 'skipped'] as SectionVerdict[]).map((v) => (
                    <VerdictButton
                      key={v}
                      current={state.verdict}
                      value={v}
                      onClick={() => setSection(s.num, 'verdict', v)}
                    />
                  ))}
                </div>
              </div>

              {/* 仕様書テキスト */}
              {sectionTexts[s.num] && (
                <div className="mb-2 rounded bg-white/60 p-2 font-mono text-[10px] leading-relaxed text-neutral-600 break-words">
                  {sectionTexts[s.num].split('\n').map((line, li) => {
                    const mAi = line.match(/^<!--\s*\[AI推論\]\s*(.*?)\s*-->$/);
                    if (mAi) return <span key={li} className="block whitespace-pre-wrap text-neutral-700">{mAi[1]}</span>;
                    if (/^<!--/.test(line)) return null; // [出典]等は非表示
                    return <span key={li} className="block whitespace-pre-wrap">{line}</span>;
                  })}
                </div>
              )}

              {/* コメント（needs_fix 時は常に表示、他は折り畳み） */}
              {state.verdict === 'needs_fix' && (
                <textarea
                  value={state.comment}
                  onChange={(e) => setSection(s.num, 'comment', e.target.value)}
                  placeholder="修正が必要な点を記入してください"
                  className="w-full rounded border border-red-200 bg-white px-2 py-1 text-[11px] text-neutral-700 placeholder-neutral-300 focus:outline-none focus:ring-1 focus:ring-red-400"
                  rows={2}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* 全体コメント + 保存 */}
      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3">
        <input
          type="text"
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
          placeholder="レビュアー名"
          className="rounded border border-neutral-300 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
        <textarea
          value={overallComment}
          onChange={(e) => setOverallComment(e.target.value)}
          placeholder="全体コメント（任意）"
          className="rounded border border-neutral-300 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-400"
          rows={2}
        />
        {error && <p className="text-[11px] text-red-600">{error}</p>}
        <button
          onClick={handleSave}
          disabled={saving || !allDone || saved}
          className={`rounded px-4 py-2 text-[12px] font-semibold text-white transition-colors ${
            saved
              ? 'bg-green-600 cursor-default'
              : allDone
              ? 'bg-indigo-600 hover:bg-indigo-700'
              : 'bg-neutral-300 cursor-not-allowed'
          }`}
        >
          {saving ? '保存中...' : saved ? '✓ 保存しました' : allDone ? 'レビューを保存' : `残り ${SECTIONS.length - reviewedCount} セクション`}
        </button>
      </div>

      {/* 保存済み表示（トグル） */}
      {existingReview && (
        <SavedReviewToggle review={existingReview} />
      )}

    </div>
  );
}
