import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import FTAFlow from './components/FTAFlow/FTAFlow';
import ExpertReviewPanel from './components/ExpertReviewPanel';
import SpecReviewPanel from './components/SpecReviewPanel';
import FailureModeReviewPanel from './components/FailureModeReviewPanel';
import TopEventReviewPanel from './components/TopEventReviewPanel';
import {
  getFailureModeReview, getTopEventReview,
  getSpecReview, saveSpecReview,
  listRecalls, getRecall, getFTA, listFTAIndices,
  getPerItemScore, getExpertReviews, saveExpertReview,
  downloadReviews,
} from './api';
import type {
  RecallListItem, RecallDetail, FTATree, FTANode,
  ExpertReview, PerItemScore, SpecReview,
  FailureModeReview, TopEventReview,
} from './api';

// ─────────────────────────────────────────────────────────────
// 定数・ユーティリティ
// ─────────────────────────────────────────────────────────────

type Mode = 'spec' | 'failure_mode' | 'top_event' | 'llm' | 'expert' | 'results';

const SCORE_CRITERIA: Record<number, { label: string; color: string }> = {
  5: { label: '同一現象', color: 'text-green-700' },
  4: { label: '直接原因', color: 'text-green-600' },
  3: { label: '遠因',     color: 'text-yellow-700' },
  2: { label: '結果',     color: 'text-orange-600' },
  1: { label: '無関係',   color: 'text-red-700' },
};

type MatchCategory = 'failure_mode' | 'top_event';

function labelContains(nodeLabel: string, term: string): boolean {
  const normalize = (s: string) => s.replace(/[（）「」【】・\s]/g, '').toLowerCase();
  const nl = normalize(nodeLabel);
  const parts = term.split(/[\s（）「」【】・、。]/).filter((p) => p.length >= 2);
  return parts.some((p) => nl.includes(normalize(p)));
}

function addMatchCategories(
  nodes: FTANode[],
  label: RecallDetail['label'],
): (FTANode & { matchCategories?: MatchCategory[] })[] {
  if (!label) return nodes;
  return nodes.map((n) => {
    if (n.type === 'gate') return n;
    const cats: MatchCategory[] = [];
    for (const term of label.top_event ?? []) {
      if (labelContains(n.label, term)) { cats.push('top_event'); break; }
    }
    for (const term of label.failure_modes ?? []) {
      if (labelContains(n.label, term)) { cats.push('failure_mode'); break; }
    }
    return cats.length > 0 ? { ...n, matchCategories: cats } : n;
  });
}

// ─────────────────────────────────────────────────────────────
// Coverage 計算（クライアントサイド）
// ─────────────────────────────────────────────────────────────

interface CoverageResult {
  nItems: number;
  nExperts: number;
  coverageLlm: number;
  coverageHuman: number | null;
  isExpertLevel: boolean | null;
  items: { key: string; llm: number; experts: number[]; hit: boolean }[];
}

function computeCoverage(
  perItem: PerItemScore,
  expertReviews: ExpertReview[],
): CoverageResult | null {
  if (!expertReviews.length) return null;

  const llmScores: Record<string, number> = {};
  for (const e of perItem.failure_modes) llmScores[`fm:${e.item}`] = e.score;
  for (const e of perItem.causal_chain)  llmScores[`cc:${e.item}`] = e.score;

  const expertMaps: Record<string, number>[] = expertReviews.map((rev) => {
    const m: Record<string, number> = {};
    for (const e of rev.failure_modes) m[`fm:${e.item}`] = e.score;
    return m;
  });

  const keys = Object.keys(llmScores).filter((k) => expertMaps.some((em) => k in em));
  if (!keys.length) return null;

  const items = keys.map((k) => {
    const experts = expertMaps.map((em) => em[k]).filter((v) => v !== undefined);
    const hit = experts.includes(llmScores[k]);
    return { key: k, llm: llmScores[k], experts, hit };
  });
  const coverageLlm = items.filter((i) => i.hit).length / items.length;

  let humanHit = 0, humanTotal = 0;
  for (const k of keys) {
    const pairs = expertMaps.map((em, j) => ({ j, v: em[k] })).filter((p) => p.v !== undefined);
    for (const { j, v } of pairs) {
      const others = new Set(pairs.filter((p) => p.j !== j).map((p) => p.v));
      if (!others.size) continue;
      if (others.has(v)) humanHit++;
      humanTotal++;
    }
  }
  const coverageHuman = humanTotal > 0 ? humanHit / humanTotal : null;
  const isExpertLevel = coverageHuman !== null ? coverageLlm >= coverageHuman : null;

  return { nItems: items.length, nExperts: expertReviews.length, coverageLlm, coverageHuman, isExpertLevel, items };
}

// トップ事象レビューの総合verdict（event_reviews[]から計算）
function teVerdict(r: TopEventReview | null): 'approved' | 'needs_fix' | null {
  if (!r?.event_reviews?.length) return null;
  if (r.event_reviews.some((e) => e.verdict === 'needs_fix')) return 'needs_fix';
  return 'approved';
}

// ─────────────────────────────────────────────────────────────
// スコアバッジ
// ─────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const { label, color } = SCORE_CRITERIA[score] ?? { label: '?', color: 'text-neutral-400' };
  return (
    <span className={`shrink-0 whitespace-nowrap font-semibold ${color}`}>
      {score} <span className="font-normal text-[11px]">— {label}</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// 結果パネル
// ─────────────────────────────────────────────────────────────

function ResultsPanel({
  caseId, perItemScore, expertReviews, specReview, failureModeReview, topEventReview, hasFta,
}: {
  caseId: string;
  perItemScore: PerItemScore | null;
  expertReviews: ExpertReview[];
  specReview: SpecReview | null;
  failureModeReview: FailureModeReview | null;
  topEventReview: TopEventReview | null;
  hasFta: boolean;
}) {
  const coverage = useMemo(
    () => (perItemScore ? computeCoverage(perItemScore, expertReviews) : null),
    [perItemScore, expertReviews],
  );

  const steps = [
    { label: '① 仕様書レビュー',   done: specReview?.verdict === 'approved',        warn: specReview?.verdict === 'needs_fix', desc: specReview ? `${specReview.verdict === 'approved' ? '承認済み' : '要修正'} (${specReview.reviewer})` : '未レビュー' },
    { label: '② 故障モードレビュー', done: failureModeReview?.verdict === 'approved', warn: failureModeReview?.verdict === 'needs_fix', desc: failureModeReview ? `${failureModeReview.verdict === 'approved' ? '承認済み' : '要修正'}` : '未レビュー' },
    { label: '③ トップ事象レビュー', done: teVerdict(topEventReview) === 'approved', warn: teVerdict(topEventReview) === 'needs_fix', desc: topEventReview ? `${teVerdict(topEventReview) === 'approved' ? '承認済み' : '要修正'}` : '未レビュー' },
    { label: '④ FTA生成',           done: hasFta,                                    warn: false,                                desc: hasFta ? '生成済み' : '未生成' },
    { label: '⑤ LLM判定',           done: perItemScore !== null,                     warn: false,                                desc: perItemScore ? 'スコアあり' : '未実行' },
    { label: '⑥ FTA評価（専門家）',  done: expertReviews.length > 0,                  warn: false,                                desc: expertReviews.length > 0 ? `${expertReviews.length}名評価済み` : '未評価' },
  ];

  return (
    <div className="flex flex-col gap-5 p-4 text-[13px]">
      {/* ステップ状況 */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-neutral-800">作業ステップ状況</h2>
        <div className="flex flex-col divide-y divide-neutral-100 rounded border border-neutral-200 bg-white text-[12px]">
          {steps.map(({ label, done, warn, desc }) => (
            <div key={label} className="flex items-center gap-3 px-3 py-2">
              <span className={`shrink-0 text-base ${done ? 'text-green-500' : warn ? 'text-amber-500' : 'text-neutral-300'}`}>
                {done ? '●' : warn ? '▲' : '○'}
              </span>
              <span className={`flex-1 font-medium ${done ? 'text-neutral-800' : 'text-neutral-400'}`}>{label}</span>
              <span className={`text-[11px] ${done ? 'text-green-600' : warn ? 'text-amber-600' : 'text-neutral-400'}`}>{desc}</span>
            </div>
          ))}
        </div>
      </section>

      {!perItemScore && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800">
          <p className="mb-1 font-semibold">LLM判定スコアがまだありません</p>
          <p className="text-neutral-600">FTAツリー生成 → judge_recall.py を実行してください。</p>
          <code className="mt-1 block rounded bg-white px-2 py-1.5 text-[11px] font-mono border border-amber-200">
            python scripts/judge_recall.py --tree sessions/.../ROUND-NNNN/tree.yaml --label cases/{caseId}/recall_label.json
          </code>
        </div>
      )}

      {perItemScore && !expertReviews.length && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800">
          <p className="font-semibold">専門家評価がまだありません</p>
          <p className="mt-1 text-neutral-600">⑤ FTA評価タブで評価を入力してください。</p>
        </div>
      )}

      {perItemScore && expertReviews.length > 0 && !coverage && (
        <div className="p-2 text-[12px] text-neutral-400">LLMと専門家の共通項目がなく Coverage を計算できません。</div>
      )}

      {coverage && (() => {
        const verdictBg    = coverage.isExpertLevel === true  ? 'bg-green-50 border-green-300'
                           : coverage.isExpertLevel === false ? 'bg-red-50 border-red-300'
                           : 'bg-neutral-50 border-neutral-200';
        const verdictText  = coverage.isExpertLevel === true  ? '✅ 専門家相当'
                           : coverage.isExpertLevel === false ? '❌ 専門家相当でない'
                           : '— 専門家1人（判定不可）';
        const verdictColor = coverage.isExpertLevel === true  ? 'text-green-800'
                           : coverage.isExpertLevel === false ? 'text-red-800'
                           : 'text-neutral-600';
        const pctLlm   = (coverage.coverageLlm * 100).toFixed(1);
        const pctHuman = coverage.coverageHuman !== null ? (coverage.coverageHuman * 100).toFixed(1) : null;
        const fmItems  = coverage.items.filter((i) => i.key.startsWith('fm:'));
        const ccItems  = coverage.items.filter((i) => i.key.startsWith('cc:'));
        return (
          <>
            <div className={`rounded-lg border p-4 ${verdictBg}`}>
              <p className={`text-lg font-bold ${verdictColor}`}>{verdictText}</p>
              <p className="mt-1 text-[11px] text-neutral-500">
                Coverage_LLM ({pctLlm}%) {coverage.coverageHuman !== null ? `≥ Coverage_human (${pctHuman}%)` : '（専門家1人のため leave-one-out 不可）'}
                &nbsp;· δ=0
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Coverage_LLM',   value: `${pctLlm}%`,   sub: `${coverage.items.filter((i) => i.hit).length}/${coverage.nItems} 項目一致` },
                { label: 'Coverage_human', value: pctHuman ? `${pctHuman}%` : '—', sub: pctHuman ? 'leave-one-out' : '専門家2人以上で計算可' },
                { label: '参加専門家',       value: `${coverage.nExperts} 人`, sub: `評価項目 ${coverage.nItems} 件` },
              ].map(({ label, value, sub }) => (
                <div key={label} className="flex flex-col items-center rounded border border-neutral-200 bg-neutral-50 py-3 px-2">
                  <span className="text-[10px] text-neutral-400">{label}</span>
                  <span className="text-xl font-bold text-neutral-800">{value}</span>
                  <span className="text-[10px] text-neutral-400">{sub}</span>
                </div>
              ))}
            </div>
            {fmItems.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-bold text-neutral-600">故障モード 項目別</h3>
                <ItemTable items={fmItems} />
              </section>
            )}
            {ccItems.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-bold text-neutral-600">因果連鎖 項目別</h3>
                <ItemTable items={ccItems} />
              </section>
            )}
          </>
        );
      })()}
    </div>
  );
}

function ItemTable({ items }: { items: { key: string; llm: number; experts: number[]; hit: boolean }[] }) {
  return (
    <div className="overflow-x-auto rounded border border-neutral-200">
      <table className="w-full text-[11px]">
        <thead className="bg-neutral-50">
          <tr>
            <th className="px-2 py-1.5 text-left font-semibold text-neutral-500">項目</th>
            <th className="px-2 py-1.5 text-center font-semibold text-neutral-500">LLM</th>
            <th className="px-2 py-1.5 text-center font-semibold text-neutral-500">専門家スコア群</th>
            <th className="px-2 py-1.5 text-center font-semibold text-neutral-500">一致</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ key, llm, experts, hit }) => (
            <tr key={key} className={`border-t border-neutral-100 ${hit ? '' : 'bg-red-50'}`}>
              <td className="px-2 py-1.5 text-neutral-700 max-w-[180px] truncate">{key.replace(/^(fm|cc):/, '')}</td>
              <td className="px-2 py-1.5 text-center font-bold text-neutral-800">{llm}</td>
              <td className="px-2 py-1.5 text-center text-neutral-600">{JSON.stringify(experts)}</td>
              <td className="px-2 py-1.5 text-center">
                {hit ? <span className="text-green-600 font-bold">✓</span> : <span className="text-red-600 font-bold">✕</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ケース一覧サイドバー
// ─────────────────────────────────────────────────────────────

function CaseSidebar({
  cases, selectedId, onSelect,
}: {
  cases: RecallListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const dateFromId = (id: string) => {
    const m = id.match(/^r(\d+)-(\d+)-(\d+)/);
    return m ? `R${m[1]}/${m[2]}/${m[3]}` : '';
  };

  // FB可能 = 仕様書・故障モード・トップ事象がすべて生成済み
  const fbCases = cases.filter((c) => c.has_spec && c.has_label && c.has_input);
  // FB完了 = 3種のレビューがすべて保存済み
  const fbDoneCount = fbCases.filter((c) => c.has_spec_review && c.has_failure_mode_review && c.has_top_event_review).length;
  const fbRemaining = fbCases.length - fbDoneCount;

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-neutral-200 bg-white overflow-hidden">
      <div className="border-b border-neutral-200 px-3 py-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-400">リコール一覧</p>
        {fbCases.length > 0 && (
          <p className="mt-1 text-[11px]">
            <span className={fbRemaining > 0 ? 'font-semibold text-amber-600' : 'font-semibold text-green-600'}>
              {fbRemaining > 0 ? `残り ${fbRemaining} 件` : '✓ 全件完了'}
            </span>
            <span className="ml-1 text-neutral-400">/ {fbCases.length} 件</span>
          </p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {fbCases.map((c) => {
          const selected = c.id === selectedId;
          const fbDone = !!(c.has_spec_review && c.has_failure_mode_review && c.has_top_event_review);
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`w-full border-b border-neutral-100 px-3 py-2 text-left transition-colors border-l-2 ${
                selected
                  ? 'bg-indigo-50 border-l-indigo-500'
                  : fbDone
                  ? 'hover:bg-green-50 border-l-green-400'
                  : 'hover:bg-neutral-50 border-l-transparent'
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <p className="text-[9px] text-neutral-400">{dateFromId(c.id)}</p>
                <div className="flex shrink-0 gap-1 text-[9px] font-bold">
                  <span className={c.has_spec_review ? 'text-green-600' : 'text-neutral-300'} title="仕様書">仕{c.has_spec_review ? '✓' : '○'}</span>
                  <span className={c.has_top_event_review ? 'text-green-600' : 'text-neutral-300'} title="トップ事象">ト{c.has_top_event_review ? '✓' : '○'}</span>
                  <span className={c.has_failure_mode_review ? 'text-green-600' : 'text-neutral-300'} title="故障モード">故{c.has_failure_mode_review ? '✓' : '○'}</span>
                </div>
              </div>
              <p className={`truncate text-[11px] font-semibold ${selected ? 'text-indigo-800' : 'text-neutral-700'}`}>
                {c.notifier || c.id}
              </p>
              <p className="truncate text-[10px] text-neutral-500">{c.defect_location}</p>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────
// FTA生成準備状況
// ─────────────────────────────────────────────────────────────

interface FtaReadiness {
  ready: boolean;
  missing: string[];
}

function FtaReadinessPanel({ readiness }: { readiness: FtaReadiness }) {
  if (readiness.ready) {
    return (
      <div className="rounded border border-green-300 bg-green-50 p-3 text-[12px]">
        <p className="font-semibold text-green-800">FTA生成の準備が整っています</p>
        <p className="mt-0.5 text-green-700">仕様書・トップ事象がすべて専門家承認済みです。</p>
      </div>
    );
  }
  return (
    <div className="rounded border border-red-300 bg-red-50 p-3 text-[12px]">
      <p className="font-semibold text-red-800">FTA未生成 — 以下が不足しているため生成できません</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {readiness.missing.map((m) => (
          <li key={m} className="text-red-700">・{m}</li>
        ))}
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 左パネル（LLM / 専門家モード）
// ─────────────────────────────────────────────────────────────

function LeftPanel({
  caseId, detail, fta, perItemScore, expertReviews, mode, specReview, topEventReview, readiness, onExpertReviewSaved,
}: {
  caseId: string;
  detail: RecallDetail;
  fta: FTATree | null;
  perItemScore: PerItemScore | null;
  expertReviews: ExpertReview[];
  mode: Mode;
  specReview: SpecReview | null;
  topEventReview: TopEventReview | null;
  readiness: FtaReadiness;
  onExpertReviewSaved: (r: ExpertReview) => void;
}) {
  const label = detail.label;

  // 専門家承認済みトップ事象（FTAに紐づくトップ事象のレビューを参照）
  const effectiveTopEvent = (() => {
    if (!fta?.top_event) return '';
    if (!topEventReview?.event_reviews?.length) return fta.top_event;
    const matched = topEventReview.event_reviews.find(
      (e) => e.top_event === fta.top_event || e.top_event.includes(fta.top_event) || fta.top_event.includes(e.top_event)
    );
    if (matched?.verdict === 'needs_fix' && matched?.suggested) return matched.suggested;
    return fta.top_event;
  })();
  const topEventVerdictComputed = teVerdict(topEventReview);

  const coverage = useMemo(
    () => (perItemScore ? computeCoverage(perItemScore, expertReviews) : null),
    [perItemScore, expertReviews],
  );

  return (
    <div className="flex flex-col gap-5 p-4 text-[13px]">

      {/* PDF */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-neutral-800">リコール届出書 (PDF)</h2>
        <div className="overflow-hidden rounded border border-neutral-200" style={{ height: 400 }}>
          <iframe src={`/api/benchmark/cases/${caseId}/pdf`} className="h-full w-full" title="recall pdf" />
        </div>
        {detail.raw?.metadata && (() => {
          const meta = detail.raw!.metadata;
          return (
            <dl className="mt-2 flex flex-col gap-1">
              {([
                ['対象製品', meta.affected_vehicles?.map((v) => `${v.make} ${v.model}`).filter((v, i, a) => a.indexOf(v) === i).join('、')],
                ['不具合部位', meta.defect_location],
                ['不具合内容', meta.defect_description],
              ] as [string, string | undefined][]).map(([dt, dd]) => dd ? (
                <div key={dt}>
                  <dt className="text-[11px] font-semibold text-neutral-400">{dt}</dt>
                  <dd className="text-neutral-800">{dd}</dd>
                </div>
              ) : null)}
            </dl>
          );
        })()}
      </section>

      <hr className="border-neutral-200" />

      {/* トップ事象 */}
      {effectiveTopEvent && (
        <>
          <section>
            <p className="mb-1 text-xs font-semibold text-neutral-500">
              トップ事象
              {topEventVerdictComputed === 'approved' && (
                <span className="ml-1 text-green-600">（専門家承認済み）</span>
              )}
              {topEventVerdictComputed === 'needs_fix' && effectiveTopEvent !== fta?.top_event && (
                <span className="ml-1 text-orange-600">（専門家修正案を適用）</span>
              )}
            </p>
            <p className="rounded border border-indigo-100 bg-indigo-50 px-3 py-2 text-[13px] font-medium text-indigo-900">
              {effectiveTopEvent}
            </p>
          </section>
          <hr className="border-neutral-200" />
        </>
      )}

      {/* 正解ラベル */}
      {label && (
        <>
          <section>
            <h2 className="mb-2 text-sm font-bold text-neutral-800">正解ラベル</h2>
            <dl className="flex flex-col gap-3">
              <div>
                <dt className="mb-1 text-xs font-semibold text-neutral-500">故障モード</dt>
                <dd className="flex flex-col gap-0.5">
                  {label.failure_modes?.map((item) => (
                    <span key={item} className="text-[12px] text-neutral-800">・{item}</span>
                  ))}
                </dd>
              </div>
            </dl>
          </section>
          <hr className="border-neutral-200" />
        </>
      )}

      {/* LLMモード専用 */}
      {mode === 'llm' && (
        <>
          {/* FTA生成準備状況 — FTAがない場合のみ表示 */}
          {!fta && (
            <>
              <FtaReadinessPanel readiness={readiness} />
              <hr className="border-neutral-200" />
            </>
          )}

          {/* 専門家承認済み仕様書 */}
          <section>
            <h2 className="mb-1 text-sm font-bold text-neutral-800">
              専門家承認済み仕様書
              {specReview?.verdict === 'approved' ? (
                <span className="ml-2 text-[11px] font-normal text-green-600">✓ 承認済み（{specReview.reviewer}）</span>
              ) : (
                <span className="ml-2 text-[11px] font-normal text-red-500">未承認</span>
              )}
            </h2>
            {detail.spec ? (
              <div className="max-h-64 overflow-y-auto rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-[10px] leading-relaxed text-neutral-700 whitespace-pre-wrap break-words">
                {detail.spec.replace(/<!--.*?-->/gs, '').trim()}
              </div>
            ) : (
              <p className="text-[12px] text-neutral-400">spec_FTA.md がありません</p>
            )}
          </section>
          <hr className="border-neutral-200" />

          {perItemScore ? (
            <>
              <section>
                <h2 className="mb-2 text-sm font-bold text-neutral-800">LLM 項目別スコア（1〜5）</h2>
                <div className="mb-2 rounded bg-neutral-50 p-2 text-[11px] text-neutral-500 border border-neutral-200">
                  <span className="font-semibold">評価基準: </span>
                  {Object.entries(SCORE_CRITERIA).reverse().map(([s, { label: l }]) => (
                    <span key={s} className="mr-2">{s}={l}</span>
                  ))}
                </div>
                {perItemScore.failure_modes.length > 0 && (
                  <div className="flex flex-col gap-1 pl-1">
                    {perItemScore.failure_modes.map((e) => (
                      <div key={e.item} className="flex items-baseline gap-2 text-[12px]">
                        <span className="min-w-0 text-neutral-700">・{e.item}</span>
                        <ScoreBadge score={e.score} />
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <hr className="border-neutral-200" />
            </>
          ) : (
            <>
              <p className="rounded bg-amber-50 p-2 text-[12px] text-amber-800 border border-amber-200">
                LLM判定スコアがありません（FTA生成 → judge_recall.py が必要）。
              </p>
              <hr className="border-neutral-200" />
            </>
          )}

          {coverage ? (
            <>
              <section>
                <h2 className="mb-2 text-sm font-bold text-neutral-800">Coverage</h2>
                <div className="mb-2 flex gap-4 text-[13px]">
                  <div className="flex flex-col items-center rounded border border-neutral-200 bg-neutral-50 px-3 py-2">
                    <span className="text-[11px] text-neutral-500">Coverage_LLM</span>
                    <span className="text-lg font-bold text-neutral-800">{(coverage.coverageLlm * 100).toFixed(0)}%</span>
                  </div>
                  <div className="flex flex-col items-center rounded border border-neutral-200 bg-neutral-50 px-3 py-2">
                    <span className="text-[11px] text-neutral-500">Coverage_human</span>
                    <span className="text-lg font-bold text-neutral-800">
                      {coverage.coverageHuman !== null ? `${(coverage.coverageHuman * 100).toFixed(0)}%` : '—'}
                    </span>
                  </div>
                  <div className={`flex flex-col items-center rounded border px-3 py-2 ${
                    coverage.isExpertLevel === true  ? 'border-green-300 bg-green-50' :
                    coverage.isExpertLevel === false ? 'border-red-300 bg-red-50' :
                    'border-neutral-200 bg-neutral-50'
                  }`}>
                    <span className="text-[11px] text-neutral-500">判定</span>
                    <span className="text-sm font-bold">
                      {coverage.isExpertLevel === true  ? '✅ 専門家相当' :
                       coverage.isExpertLevel === false ? '❌ 相当でない' : '— 1人'}
                    </span>
                  </div>
                </div>
              </section>
              <hr className="border-neutral-200" />
            </>
          ) : null}
        </>
      )}

      {/* 専門家モード */}
      {mode === 'expert' && (
        <ExpertReviewPanel
          recallId={caseId}
          failureModes={label?.failure_modes ?? []}
          existingReviews={expertReviews}
          onSaved={onExpertReviewSaved}
          saveReview={saveExpertReview}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────

const API_BASE = '/api/recalls';

export default function App() {
  const [mode, setMode]                           = useState<Mode>(() => (localStorage.getItem('ftaMode') as Mode) ?? 'failure_mode');
  const [cases, setCases]                         = useState<RecallListItem[]>([]);
  const [selectedId, setSelectedId]               = useState<string | null>(null);
  const [detail, setDetail]                       = useState<RecallDetail | null>(null);
  const [fta, setFta]                             = useState<FTATree | null>(null);
  const [ftaIndices, setFtaIndices]               = useState<number[]>([]);
  const [ftaIndex, setFtaIndex]                   = useState(0);
  const [expertReviews, setExpertReviews]         = useState<ExpertReview[]>([]);
  const [perItemScore, setPerItemScore]           = useState<PerItemScore | null>(null);
  const [specReview, setSpecReview]               = useState<SpecReview | null>(null);
  const [failureModeReview, setFailureModeReview] = useState<FailureModeReview | null>(null);
  const [topEventReview, setTopEventReview]       = useState<TopEventReview | null>(null);
  const [loading, setLoading]                     = useState(false);
  const [leftWidth, setLeftWidth]                 = useState(() => Math.round(window.innerWidth / 3));
  const isDragging                                = useRef(false);

  const switchMode = (m: Mode) => { setMode(m); localStorage.setItem('ftaMode', m); };

  // サイドバー幅（px）
  const SIDEBAR_WIDTH = 208; // w-52 = 13rem = 208px

  const readiness = useMemo<FtaReadiness>(() => {
    const specOk = specReview?.verdict === 'approved';
    const topEventOk = teVerdict(topEventReview) === 'approved';
    const missing: string[] = [];
    if (!specOk) missing.push('仕様書（専門家承認済み）が未承認または未レビューです');
    if (!topEventOk) missing.push('トップ事象（専門家承認済み）が未承認または未レビューです');
    return { ready: missing.length === 0, missing };
  }, [specReview, topEventReview]);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const contentX = ev.clientX - SIDEBAR_WIDTH - 1; // サイドバー分を引く
      setLeftWidth(Math.max(160, Math.min(contentX, window.innerWidth - SIDEBAR_WIDTH - 160)));
    };
    const onUp = () => {
      isDragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  useEffect(() => {
    listRecalls().then((list) => {
      setCases(list);
      setSelectedId((prev) => prev ?? (list.length > 0 ? list[0].id : null));
    });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setLoading(true);
    setDetail(null); setFta(null); setFtaIndices([]); setFtaIndex(0);
    setExpertReviews([]); setPerItemScore(null);
    setSpecReview(null); setFailureModeReview(null); setTopEventReview(null);

    Promise.all([
      getRecall(selectedId),
      getFTA(selectedId).catch(() => null),
      listFTAIndices(selectedId),
      getExpertReviews(selectedId),
      getPerItemScore(selectedId),
      getSpecReview(selectedId, API_BASE),
      getFailureModeReview(selectedId, API_BASE),
      getTopEventReview(selectedId, API_BASE),
    ]).then(([d, f, fi, er, ps, sr, fmr, ter]) => {
      setDetail(d as RecallDetail);
      setFta(f as FTATree | null);
      setFtaIndices(fi as number[]);
      setExpertReviews(er as ExpertReview[]);
      setPerItemScore(ps as PerItemScore | null);
      setSpecReview(sr as SpecReview | null);
      setFailureModeReview(fmr as FailureModeReview | null);
      setTopEventReview(ter as TopEventReview | null);
    }).finally(() => setLoading(false));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ftaIndex が変わったら FTA を再読み込み
  useEffect(() => {
    if (!selectedId || ftaIndex === 0) return;
    getFTA(selectedId, ftaIndex).then(setFta).catch(() => setFta(null));
  }, [selectedId, ftaIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // タブのバッジ状態（選択中ケースのレビュー結果に基づく）
  const modeStatus: Record<Mode, 'ok' | 'ng' | null> = {
    spec:         specReview?.verdict === 'approved' ? 'ok' : specReview ? 'ng' : null,
    failure_mode: failureModeReview?.verdict === 'approved' ? 'ok' : failureModeReview ? 'ng' : null,
    top_event:    teVerdict(topEventReview) === 'approved' ? 'ok' : teVerdict(topEventReview) === 'needs_fix' ? 'ng' : null,
    llm:          perItemScore ? 'ok' : null,
    expert:       expertReviews.length > 0 ? 'ok' : null,
    results:      fta ? 'ok' : null,
  };

  const MODES: { key: Mode; label: string; active: string; hint: string }[] = [
    { key: 'spec',         label: '① 仕様書',     active: 'bg-amber-600 text-white',   hint: 'リコール情報から生成した仕様書をレビュー' },
    { key: 'top_event',    label: '② トップ事象', active: 'bg-orange-600 text-white',  hint: 'FTAのトップ事象をレビュー' },
    { key: 'failure_mode', label: '③ 故障モード', active: 'bg-rose-600 text-white',    hint: '正解ラベルの故障モードをレビュー' },
    { key: 'llm',          label: '④ LLM判定',    active: 'bg-indigo-600 text-white',  hint: 'LLMによるFTA評価スコアを確認' },
    { key: 'expert',       label: '⑤ FTA評価',    active: 'bg-emerald-600 text-white', hint: '専門家によるFTAの5段階評価を入力' },
    { key: 'results',      label: '⑥ 結果',        active: 'bg-violet-600 text-white',  hint: '全ステップの完了状況とCoverageスコア' },
  ];

  return (
    <div className="flex h-screen flex-col bg-neutral-50 font-sans">
      {/* ヘッダー */}
      <header className="flex items-center gap-2 border-b border-neutral-200 bg-white px-4 py-2 shadow-sm">
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-neutral-200">
          {MODES.map(({ key, label, active, hint }) => {
            const status = selectedId ? modeStatus[key] : null;
            return (
              <button
                key={key}
                onClick={() => switchMode(key)}
                title={hint}
                className={`relative flex items-center gap-1 px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                  mode === key ? active : 'bg-white text-neutral-500 hover:bg-neutral-50'
                }`}
              >
                {label}
                {status === 'ok' && (
                  <span className={`text-[9px] font-bold ${mode === key ? 'text-white/80' : 'text-green-500'}`}>●</span>
                )}
                {status === 'ng' && (
                  <span className={`text-[9px] font-bold ${mode === key ? 'text-white/80' : 'text-amber-500'}`}>▲</span>
                )}
                {status === null && (
                  <span className={`text-[9px] font-bold ${mode === key ? 'text-white/40' : 'text-neutral-300'}`}>○</span>
                )}
              </button>
            );
          })}
        </div>
        {selectedId && (
          <div className="ml-2 min-w-0 flex-1">
            <p className="truncate text-[11px] text-neutral-500">
              <span className="font-semibold text-neutral-800">{selectedId}</span>
              {detail?.raw?.metadata && (
                <span className="ml-2">{detail.raw.metadata.affected_vehicles?.[0]?.model} — {detail.raw.metadata.defect_location}</span>
              )}
            </p>
          </div>
        )}
        <button
          onClick={() => downloadReviews().catch((e) => alert(e.message))}
          className="ml-auto shrink-0 rounded border border-neutral-300 bg-white px-3 py-1 text-[12px] font-semibold text-neutral-600 hover:bg-neutral-50 active:bg-neutral-100"
          title="レビュー済みデータを ZIP でダウンロード"
        >
          レビューデータをエクスポート
        </button>
      </header>

      {/* メインエリア */}
      <div className="flex flex-1 overflow-hidden select-none">
        {/* ケース一覧サイドバー */}
        <CaseSidebar cases={cases} selectedId={selectedId} onSelect={(id) => {
          setSelectedId(id);
          setSpecReview(null); setFailureModeReview(null); setTopEventReview(null);
          setDetail(null); setFta(null); setFtaIndices([]); setFtaIndex(0);
          setExpertReviews([]); setPerItemScore(null);
        }} />
        <div className="w-px shrink-0 bg-neutral-200" />
        <div className="flex flex-1 overflow-hidden">
        {mode === 'spec' ? (
          /* 仕様書レビューモード：左=PDF×2+仕様書本文、右=レビューパネル */
          <>
            <aside className="shrink-0 overflow-y-auto bg-white" style={{ width: leftWidth }}>
              {loading && <p className="p-4 text-sm text-neutral-400">読み込み中...</p>}
              {selectedId && (
                <div className="flex flex-col gap-3 p-3">
                  {/* リコール届出書 */}
                  <div>
                    <p className="mb-1 text-[11px] font-semibold text-neutral-500">リコール届出書</p>
                    <div className="overflow-hidden rounded border border-neutral-200" style={{ height: 340 }}>
                      <iframe src={`${API_BASE}/${selectedId}/pdf`} className="h-full w-full" title="recall pdf" />
                    </div>
                  </div>
                  {/* 改善箇所説明図PDF */}
                  {cases.find(c => c.id === selectedId)?.has_diagram_pdf && (
                    <div>
                      <p className="mb-1 text-[11px] font-semibold text-neutral-500">改善箇所説明図</p>
                      <div className="overflow-hidden rounded border border-neutral-200" style={{ height: 280 }}>
                        <iframe src={`${API_BASE}/${selectedId}/diagram`} className="h-full w-full" title="diagram pdf" />
                      </div>
                    </div>
                  )}
                  {/* リコール → 仕様書 フロー */}
                  <div className="flex items-center gap-2 py-1">
                    <div className="h-px flex-1 bg-neutral-200" />
                    <span className="shrink-0 rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                      ↓ リコール情報から仕様書を自動生成
                    </span>
                    <div className="h-px flex-1 bg-neutral-200" />
                  </div>
                  {/* spec_FTA.md 本文 */}
                  {detail?.spec ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-[11px] font-semibold text-neutral-500">
                        部品正常仕様書（spec_FTA.md）
                      </p>
                      {/* 注意書き */}
                      <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-[10px] text-blue-700 leading-relaxed">
                        <span className="font-semibold">FTA生成への入力について：</span>
                        仕様書本文（黒文字）がFTAエージェントに入力されます。
                        <span className="font-semibold text-blue-400"> 青文字の根拠情報（出典URL等）は入力されません。</span>
                      </div>
                      <div className="rounded border border-neutral-200 bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-700 whitespace-pre-wrap break-words">
                        {detail.spec.split('\n').map((line, i) => {
                          const mSrc = line.match(/^<!--\s*\[出典\]\s*(.*?)\s*-->$/);
                          if (mSrc) {
                            const parts = mSrc[1].split(/(https?:\/\/\S+)/);
                            return (
                              <span key={i} className="block text-[10px] text-blue-400 italic pl-2 my-0.5">
                                {parts.map((p, j) =>
                                  p.match(/^https?:\/\//)
                                    ? <a key={j} href={p} target="_blank" rel="noreferrer" className="underline hover:text-blue-600">{p}</a>
                                    : p
                                )}
                              </span>
                            );
                          }
                          if (/^<!--/.test(line)) return null;
                          return <span key={i} className="block">{line}</span>;
                        })}
                      </div>
                    </div>
                  ) : !loading ? (
                    <div className="text-[13px] text-neutral-400">
                      spec_FTA.md がまだ生成されていません。<br />
                      <code className="mt-2 block rounded bg-neutral-100 px-2 py-1.5 text-[11px]">
                        cases/{selectedId}/spec_FTA.md に配置してください
                      </code>
                    </div>
                  ) : null}
                </div>
              )}
            </aside>
            <div
              onMouseDown={handleDividerMouseDown}
              className="w-1 shrink-0 cursor-col-resize bg-neutral-200 hover:bg-amber-400 active:bg-amber-500 transition-colors"
            />
            <main className="flex-1 overflow-y-auto bg-white">
              {selectedId && (
                <SpecReviewPanel
                  key={selectedId}
                  recallId={selectedId}
                  spec={detail?.spec ?? ''}
                  existingReview={specReview}
                  onSaved={(r) => setSpecReview(r)}
                  apiBase={API_BASE}
                />
              )}
            </main>
          </>
        ) : (mode === 'failure_mode' || mode === 'top_event') ? (
          /* 故障モード / トップ事象レビューモード：左=PDF×2、右=レビューパネル */
          <>
            <aside className="shrink-0 overflow-y-auto bg-white" style={{ width: leftWidth }}>
              {selectedId && (
                <div className="flex flex-col gap-3 p-3">
                  <div>
                    <p className="mb-1 text-[11px] font-semibold text-neutral-500">リコール届出書</p>
                    <div className="overflow-hidden rounded border border-neutral-200" style={{ height: 300 }}>
                      <iframe src={`${API_BASE}/${selectedId}/pdf`} className="h-full w-full" title="recall pdf" />
                    </div>
                  </div>
                  {cases.find(c => c.id === selectedId)?.has_diagram_pdf && (
                    <div>
                      <p className="mb-1 text-[11px] font-semibold text-neutral-500">改善箇所説明図</p>
                      <div className="overflow-hidden rounded border border-neutral-200" style={{ height: 280 }}>
                        <iframe src={`${API_BASE}/${selectedId}/diagram`} className="h-full w-full" title="diagram pdf" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </aside>
            <div
              onMouseDown={handleDividerMouseDown}
              className={`w-1 shrink-0 cursor-col-resize transition-colors ${
                mode === 'failure_mode'
                  ? 'bg-neutral-200 hover:bg-rose-400 active:bg-rose-500'
                  : 'bg-neutral-200 hover:bg-orange-400 active:bg-orange-500'
              }`}
            />
            <main className="flex-1 overflow-y-auto bg-white">
              {loading && <p className="p-4 text-sm text-neutral-400">読み込み中...</p>}
              {selectedId && detail && mode === 'failure_mode' && (
                <FailureModeReviewPanel
                  recallId={selectedId}
                  failureModes={detail.label?.failure_modes ?? []}
                  existingReview={failureModeReview}
                  onSaved={(r) => setFailureModeReview(r)}
                  apiBase={API_BASE}
                />
              )}
              {selectedId && detail && mode === 'top_event' && (
                <TopEventReviewPanel
                  recallId={selectedId}
                  topEvents={detail.label?.top_event ?? []}
                  existingReview={topEventReview}
                  onSaved={(r) => setTopEventReview(r)}
                  apiBase={API_BASE}
                />
              )}
            </main>
          </>
        ) : mode === 'results' ? (
          /* 結果モード：左=スコア、右=FTAツリー */
          <>
            <aside className="shrink-0 overflow-y-auto bg-white" style={{ width: leftWidth }}>
              {loading && <p className="p-4 text-sm text-neutral-400">読み込み中...</p>}
              {selectedId && !loading && (
                <ResultsPanel
                  caseId={selectedId}
                  perItemScore={perItemScore}
                  expertReviews={expertReviews}
                  specReview={specReview}
                  failureModeReview={failureModeReview}
                  topEventReview={topEventReview}
                  hasFta={fta !== null}
                />
              )}
            </aside>
            <div
              onMouseDown={handleDividerMouseDown}
              className="w-1 shrink-0 cursor-col-resize bg-neutral-200 hover:bg-violet-400 active:bg-violet-500 transition-colors"
            />
            <main className="flex-1 overflow-hidden flex flex-col">
              {/* FTAインデックスセレクター（複数FTAがある場合） */}
              {ftaIndices.length > 1 && (
                <div className="shrink-0 flex gap-1 border-b border-neutral-200 bg-white px-3 py-2">
                  {ftaIndices.map((idx) => (
                    <button
                      key={idx}
                      onClick={() => setFtaIndex(idx)}
                      className={`rounded px-3 py-1 text-[11px] font-semibold transition-colors ${
                        ftaIndex === idx
                          ? 'bg-violet-600 text-white'
                          : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                      }`}
                    >
                      FTA {idx + 1}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex-1 overflow-hidden">
                {fta ? (
                  <ReactFlowProvider>
                    <FTAFlow ftaNodes={addMatchCategories(fta.nodes, detail?.label) as any} readOnly={true} />
                  </ReactFlowProvider>
                ) : !loading && (
                  <div className="flex h-full items-center justify-center p-8">
                    <div className="max-w-sm w-full">
                      <FtaReadinessPanel readiness={readiness} />
                    </div>
                  </div>
                )}
              </div>
            </main>
          </>
        ) : (
          /* LLM / 専門家モード：左=情報、右=FTAツリー */
          <>
            <aside className="shrink-0 overflow-y-auto bg-white" style={{ width: leftWidth }}>
              {loading && <p className="p-4 text-sm text-neutral-400">読み込み中...</p>}
              {detail && selectedId && (
                <LeftPanel
                  caseId={selectedId}
                  detail={detail}
                  fta={fta}
                  perItemScore={perItemScore}
                  expertReviews={expertReviews}
                  mode={mode}
                  specReview={specReview}
                  topEventReview={topEventReview}
                  readiness={readiness}
                  onExpertReviewSaved={(r) => {
                    setExpertReviews((prev) => {
                      const idx = prev.findIndex((e) => e.reviewer === r.reviewer);
                      if (idx >= 0) { const next = [...prev]; next[idx] = r; return next; }
                      return [...prev, r];
                    });
                  }}
                />
              )}
            </aside>
            <div
              onMouseDown={handleDividerMouseDown}
              className="w-1 shrink-0 cursor-col-resize bg-neutral-200 hover:bg-indigo-400 active:bg-indigo-500 transition-colors"
            />
            <main className="flex-1 overflow-hidden flex flex-col">
              {loading && (
                <div className="flex h-full items-center justify-center text-sm text-neutral-400">読み込み中...</div>
              )}
              {ftaIndices.length > 1 && (
                <div className="shrink-0 flex gap-1 border-b border-neutral-200 bg-white px-3 py-2">
                  {ftaIndices.map((idx) => (
                    <button
                      key={idx}
                      onClick={() => setFtaIndex(idx)}
                      className={`rounded px-3 py-1 text-[11px] font-semibold transition-colors ${
                        ftaIndex === idx
                          ? 'bg-indigo-600 text-white'
                          : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                      }`}
                    >
                      FTA {idx + 1}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex-1 overflow-hidden">
                {fta ? (
                  <ReactFlowProvider>
                    <FTAFlow ftaNodes={addMatchCategories(fta.nodes, detail?.label) as any} readOnly={true} />
                  </ReactFlowProvider>
                ) : !loading && (
                  <div className="flex h-full items-center justify-center p-8">
                    <div className="max-w-sm w-full">
                      <FtaReadinessPanel readiness={readiness} />
                    </div>
                  </div>
                )}
              </div>
            </main>
          </>
        )}
        </div>
      </div>
    </div>
  );
}
