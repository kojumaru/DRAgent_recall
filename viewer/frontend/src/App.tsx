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
  listBenchmarkCases, getBenchmarkCase, getBenchmarkFTA,
  getBenchmarkPerItemScore, getBenchmarkExpertReviews, saveBenchmarkExpertReview,
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
  caseId, perItemScore, expertReviews,
}: {
  caseId: string;
  perItemScore: PerItemScore | null;
  expertReviews: ExpertReview[];
}) {
  const coverage = useMemo(
    () => (perItemScore ? computeCoverage(perItemScore, expertReviews) : null),
    [perItemScore, expertReviews],
  );

  if (!perItemScore) {
    return (
      <div className="p-4">
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800">
          <p className="mb-1 font-semibold">LLM判定スコアがまだありません</p>
          <p className="text-neutral-600">FTAツリー生成 → judge_recall.py を実行してください。</p>
          <code className="mt-1 block rounded bg-white px-2 py-1.5 text-[11px] font-mono border border-amber-200">
            python scripts/judge_recall.py --tree sessions/.../ROUND-NNNN/tree.yaml --label cases/{caseId}/recall_label.json
          </code>
        </div>
      </div>
    );
  }

  if (!expertReviews.length) {
    return (
      <div className="p-4">
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800">
          <p className="font-semibold">専門家評価がまだありません</p>
          <p className="mt-1 text-neutral-600">👤 専門家モードで評価を入力してください。</p>
        </div>
      </div>
    );
  }

  if (!coverage) {
    return <div className="p-4 text-[12px] text-neutral-400">LLMと専門家の共通項目がなく Coverage を計算できません。</div>;
  }

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
    <div className="flex flex-col gap-5 p-4 text-[13px]">
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
// 左パネル（LLM / 専門家モード）
// ─────────────────────────────────────────────────────────────

function LeftPanel({
  caseId, detail, fta, perItemScore, expertReviews, mode, onExpertReviewSaved,
}: {
  caseId: string;
  detail: RecallDetail;
  fta: FTATree | null;
  perItemScore: PerItemScore | null;
  expertReviews: ExpertReview[];
  mode: Mode;
  onExpertReviewSaved: (r: ExpertReview) => void;
}) {
  const label = detail.label;

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
      {fta?.top_event && (
        <>
          <section>
            <p className="mb-1 text-xs font-semibold text-neutral-500">トップ事象</p>
            <p className="rounded border border-indigo-100 bg-indigo-50 px-3 py-2 text-[13px] font-medium text-indigo-900">
              {fta.top_event}
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
          saveReview={saveBenchmarkExpertReview}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────

const API_BASE = '/api/benchmark/cases';

export default function App() {
  const [mode, setMode]                           = useState<Mode>(() => (localStorage.getItem('ftaMode') as Mode) ?? 'failure_mode');
  const [cases, setCases]                         = useState<RecallListItem[]>([]);
  const [selectedId, setSelectedId]               = useState<string | null>(null);
  const [detail, setDetail]                       = useState<RecallDetail | null>(null);
  const [fta, setFta]                             = useState<FTATree | null>(null);
  const [expertReviews, setExpertReviews]         = useState<ExpertReview[]>([]);
  const [perItemScore, setPerItemScore]           = useState<PerItemScore | null>(null);
  const [specReview, setSpecReview]               = useState<SpecReview | null>(null);
  const [failureModeReview, setFailureModeReview] = useState<FailureModeReview | null>(null);
  const [topEventReview, setTopEventReview]       = useState<TopEventReview | null>(null);
  const [loading, setLoading]                     = useState(false);
  const [leftWidth, setLeftWidth]                 = useState(() => Math.round(window.innerWidth / 3));
  const isDragging                                = useRef(false);

  const switchMode = (m: Mode) => { setMode(m); localStorage.setItem('ftaMode', m); };

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      setLeftWidth(Math.max(160, Math.min(ev.clientX, window.innerWidth - 160)));
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
    listBenchmarkCases().then((list) => {
      setCases(list);
      setSelectedId((prev) => prev ?? (list.length > 0 ? list[0].id : null));
    });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setLoading(true);
    setDetail(null); setFta(null); setExpertReviews([]); setPerItemScore(null);
    setSpecReview(null); setFailureModeReview(null); setTopEventReview(null);

    Promise.all([
      getBenchmarkCase(selectedId),
      getBenchmarkFTA(selectedId).catch(() => null),
      getBenchmarkExpertReviews(selectedId),
      getBenchmarkPerItemScore(selectedId),
      getSpecReview(selectedId, API_BASE),
      getFailureModeReview(selectedId, API_BASE),
      getTopEventReview(selectedId, API_BASE),
    ]).then(([d, f, er, ps, sr, fmr, ter]) => {
      setDetail(d as RecallDetail);
      setFta(f as FTATree | null);
      setExpertReviews(er as ExpertReview[]);
      setPerItemScore(ps as PerItemScore | null);
      setSpecReview(sr as SpecReview | null);
      setFailureModeReview(fmr as FailureModeReview | null);
      setTopEventReview(ter as TopEventReview | null);
    }).finally(() => setLoading(false));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const MODES = [
    { key: 'spec'         as Mode, label: '📝 仕様書',     active: 'bg-amber-600 text-white' },
    { key: 'failure_mode' as Mode, label: '⚠️ 故障モード', active: 'bg-rose-600 text-white' },
    { key: 'top_event'    as Mode, label: '🎯 トップ事象', active: 'bg-orange-600 text-white' },
    { key: 'llm'          as Mode, label: '⚖️ LLM判定',    active: 'bg-indigo-600 text-white' },
    { key: 'expert'       as Mode, label: '👤 専門家',     active: 'bg-emerald-600 text-white' },
    { key: 'results'      as Mode, label: '📊 結果',        active: 'bg-violet-600 text-white' },
  ];

  return (
    <div className="flex h-screen flex-col bg-neutral-50 font-sans">
      {/* ヘッダー */}
      <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-5 py-2.5 shadow-sm">
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-neutral-200">
          {MODES.map(({ key, label, active }) => (
            <button
              key={key}
              onClick={() => switchMode(key)}
              className={`px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                mode === key ? active : 'bg-white text-neutral-500 hover:bg-neutral-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="shrink-0 text-xs font-semibold text-neutral-400">ケース</span>
        <select
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value || null)}
          className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} — {c.vehicle} / {c.defect_location}{c.has_fta ? ' ✅' : ''}
            </option>
          ))}
        </select>
      </header>

      {/* メインエリア */}
      <div className="flex flex-1 overflow-hidden select-none">
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
                  {/* 図面（加工済み） */}
                  <div>
                    <p className="mb-1 text-[11px] font-semibold text-neutral-500">図面（加工済み）</p>
                    <div className="overflow-auto rounded border border-neutral-200 bg-neutral-50" style={{ maxHeight: 340 }}>
                      <img src={`${API_BASE}/${selectedId}/diagram_masked`} alt="diagram masked" className="w-full object-contain" />
                    </div>
                  </div>
                  {/* spec_FTA.md 本文 */}
                  {detail?.spec ? (
                    <div>
                      <p className="mb-1 text-[11px] font-semibold text-neutral-500">spec_FTA.md</p>
                      <div className="rounded border border-neutral-200 bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-700 whitespace-pre-wrap break-words">
                        {detail.spec.split('\n').map((line, i) => {
                          const m = line.match(/^<!--\s*\[出典\]\s*(.*?)\s*-->$/);
                          if (m) {
                            const parts = m[1].split(/(https?:\/\/\S+)/);
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
                    <div className="overflow-hidden rounded border border-neutral-200" style={{ height: 340 }}>
                      <iframe src={`${API_BASE}/${selectedId}/pdf`} className="h-full w-full" title="recall pdf" />
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-semibold text-neutral-500">図面（加工済み）</p>
                    <div className="overflow-auto rounded border border-neutral-200 bg-neutral-50" style={{ maxHeight: 340 }}>
                      <img src={`${API_BASE}/${selectedId}/diagram_masked`} alt="diagram masked" className="w-full object-contain" />
                    </div>
                  </div>
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
                />
              )}
            </aside>
            <div
              onMouseDown={handleDividerMouseDown}
              className="w-1 shrink-0 cursor-col-resize bg-neutral-200 hover:bg-violet-400 active:bg-violet-500 transition-colors"
            />
            <main className="flex-1 overflow-hidden">
              {fta ? (
                <ReactFlowProvider>
                  <FTAFlow ftaNodes={addMatchCategories(fta.nodes, detail?.label) as any} readOnly={true} />
                </ReactFlowProvider>
              ) : !loading && (
                <div className="flex h-full items-center justify-center text-sm text-neutral-400">FTA データがありません</div>
              )}
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
            <main className="flex-1 overflow-hidden">
              {loading && (
                <div className="flex h-full items-center justify-center text-sm text-neutral-400">読み込み中...</div>
              )}
              {fta ? (
                <ReactFlowProvider>
                  <FTAFlow ftaNodes={addMatchCategories(fta.nodes, detail?.label) as any} readOnly={true} />
                </ReactFlowProvider>
              ) : !loading && (
                <div className="flex h-full items-center justify-center text-sm text-neutral-400">FTA データがありません</div>
              )}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
