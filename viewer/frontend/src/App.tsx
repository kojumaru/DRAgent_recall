import { useState, useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import FTAFlow from './components/FTAFlow/FTAFlow';
import { listRecalls, getRecall, getFTA } from './api';
import type { RecallListItem, RecallDetail, FTATree, FTANode } from './api';

type MatchCategory = 'component' | 'failure_mode' | 'top_event';

/** ラベルテキストが term を含むかどうか（正規化して比較） */
function labelContains(nodeLabel: string, term: string): boolean {
  const normalize = (s: string) => s.replace(/[（）「」【】・\s]/g, '').toLowerCase();
  const nl = normalize(nodeLabel);
  const parts = term.split(/[\s（）「」【】・、。]/).filter((p) => p.length >= 2);
  return parts.some((p) => nl.includes(normalize(p)));
}

/** FTA ノードに正解ラベルとの一致カテゴリを付与する */
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
    for (const term of label.target_component ?? []) {
      if (labelContains(n.label, term)) { cats.push('component'); break; }
    }
    return cats.length > 0 ? { ...n, matchCategories: cats } : n;
  });
}

function StarRating({ value }: { value: number }) {
  const stars = Math.round(value); // value は 1〜5 の整数
  return (
    <span className="text-lg leading-none">
      {'★'.repeat(stars)}
      <span className="text-neutral-300">{'★'.repeat(5 - stars)}</span>
    </span>
  );
}

function LeftPanel({ recallId, detail, ftaNodes }: {
  recallId: string;
  detail: RecallDetail;
  ftaNodes: FTANode[] | null;
}) {
  const meta = detail.raw?.metadata;
  const label = detail.label;
  const score = detail.score;

  const matchedFor = (terms: string[] | undefined) => {
    if (!terms || !ftaNodes) return {} as Record<string, string[]>;
    const result: Record<string, string[]> = {};
    for (const term of terms) {
      const matched = ftaNodes
        .filter((n) => n.type !== 'gate' && labelContains(n.label, term))
        .map((n) => n.label);
      if (matched.length > 0) result[term] = matched;
    }
    return result;
  };

  const componentMatches = matchedFor(label?.target_component);
  const failureModeMatches = matchedFor(label?.failure_modes);
  const topEventMatches = matchedFor(label?.top_event);

  return (
    <div className="flex flex-col gap-5 p-4 text-[13px]">

      {/* 1. PDF ビューア */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-neutral-800">リコール届出書 (PDF)</h2>
        <div className="overflow-hidden rounded border border-neutral-200" style={{ height: 480 }}>
          <iframe
            src={`/api/recalls/${recallId}/pdf`}
            className="h-full w-full"
            title="recall pdf"
          />
        </div>
        {meta && (
          <dl className="mt-2 flex flex-col gap-1.5">
            <div>
              <dt className="text-xs font-semibold text-neutral-500">届出者</dt>
              <dd className="text-neutral-800">{meta.notifier}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-neutral-500">対象車種</dt>
              <dd className="text-neutral-800">
                {meta.affected_vehicles?.map((v) => `${v.make} ${v.model}`).filter((v, i, a) => a.indexOf(v) === i).join('、')}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-neutral-500">不具合部位</dt>
              <dd className="text-neutral-800">{meta.defect_location}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-neutral-500">不具合内容</dt>
              <dd className="leading-relaxed text-neutral-800">{meta.defect_description}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-neutral-500">根本原因</dt>
              <dd className="text-neutral-800">{meta.root_cause}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-neutral-500">改善措置</dt>
              <dd className="text-neutral-800">{meta.correction_summary}</dd>
            </div>
          </dl>
        )}
      </section>

      <hr className="border-neutral-200" />

      {/* 2. 変換した仕様書 */}
      {detail.spec && (
        <section>
          <h2 className="mb-2 text-sm font-bold text-neutral-800">変換仕様書 (spec_FTA.md)</h2>
          <pre className="whitespace-pre-wrap break-words rounded bg-neutral-50 p-3 text-[12px] leading-relaxed text-neutral-700 border border-neutral-200">
            {detail.spec}
          </pre>
        </section>
      )}

      {detail.spec && <hr className="border-neutral-200" />}

      {/* 3. 正解ラベル */}
      {label && (
        <section>
          <h2 className="mb-2 text-sm font-bold text-neutral-800">正解ラベル</h2>
          <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded bg-neutral-50 px-2 py-1.5 text-[11px] text-neutral-500">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" />トップ事象</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-orange-400" />故障モード</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500" />対象部品</span>
            <span className="text-neutral-400">← FTAノード上の点</span>
          </div>
          <dl className="flex flex-col gap-3">
            <div>
              <dt className="mb-1 text-xs font-semibold text-neutral-500">対象部品</dt>
              <dd className="flex flex-col gap-1">
                {label.target_component?.map((c) => (
                  <div key={c}>
                    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-800">{c}</span>
                    {componentMatches[c] && (
                      <div className="ml-1 mt-0.5 flex flex-col gap-0.5">
                        {componentMatches[c].map((nl) => (
                          <span key={nl} className="flex items-center gap-1 text-[11px] text-blue-600">
                            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />{nl}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-xs font-semibold text-neutral-500">故障モード</dt>
              <dd className="flex flex-col gap-1">
                {label.failure_modes?.map((f) => (
                  <div key={f}>
                    <span className="rounded bg-orange-50 px-1.5 py-0.5 text-xs text-orange-800">{f}</span>
                    {failureModeMatches[f] && (
                      <div className="ml-1 mt-0.5 flex flex-col gap-0.5">
                        {failureModeMatches[f].map((nl) => (
                          <span key={nl} className="flex items-center gap-1 text-[11px] text-orange-600">
                            <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />{nl}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-xs font-semibold text-neutral-500">トップ事象</dt>
              <dd className="flex flex-col gap-1">
                {label.top_event?.map((t) => (
                  <div key={t}>
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-800">{t}</span>
                    {topEventMatches[t] && (
                      <div className="ml-1 mt-0.5 flex flex-col gap-0.5">
                        {topEventMatches[t].map((nl) => (
                          <span key={nl} className="flex items-center gap-1 text-[11px] text-red-600">
                            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />{nl}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-xs font-semibold text-neutral-500">因果連鎖</dt>
              <dd className="flex flex-col gap-0.5">
                {label.causal_chain?.map((c, i) => (
                  <span key={i} className="text-neutral-700">{i + 1}. {c}</span>
                ))}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {label && <hr className="border-neutral-200" />}

      {/* 4. 一致度スコア（星） */}
      {score && (
        <section>
          <h2 className="mb-3 text-sm font-bold text-neutral-800">評価スコア</h2>
          <dl className="flex flex-col gap-2.5">
            {[
              { label: '対象部品', value: score.component_match },
              { label: '故障モード', value: score.failure_mode_match },
              { label: 'トップ事象', value: score.top_event_match },
              { label: '総合', value: score.overall },
            ].map(({ label: lbl, value }) => (
              <div key={lbl} className="flex items-center justify-between">
                <dt className="text-xs font-semibold text-neutral-500">{lbl}</dt>
                <dd className="flex items-center gap-1.5">
                  <StarRating value={value} />
                  <span className="text-[11px] text-neutral-400">{value}/5</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

export default function App() {
  const [recalls, setRecalls] = useState<RecallListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecallDetail | null>(null);
  const [fta, setFta] = useState<FTATree | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listRecalls().then((list) => {
      setRecalls(list);
      if (list.length > 0) setSelectedId(list[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setLoading(true);
    setDetail(null);
    setFta(null);
    Promise.all([getRecall(selectedId), getFTA(selectedId)])
      .then(([d, f]) => {
        setDetail(d);
        setFta(f);
      })
      .finally(() => setLoading(false));
  }, [selectedId]);

  return (
    <div className="flex h-screen flex-col bg-neutral-50 font-sans">
      {/* ヘッダー：リコール選択 */}
      <header className="flex items-center gap-4 border-b border-neutral-200 bg-white px-5 py-3 shadow-sm">
        <span className="text-sm font-bold text-neutral-700">対象リコール</span>
        <div className="flex flex-wrap gap-3">
          {recalls.map((r) => (
            <label key={r.id} className="flex cursor-pointer items-center gap-1.5 text-[13px]">
              <input
                type="radio"
                name="recall"
                value={r.id}
                checked={selectedId === r.id}
                onChange={() => setSelectedId(r.id)}
                className="accent-blue-600"
              />
              <span className="font-medium text-neutral-800">{r.notifier}</span>
              <span className="text-neutral-500">{r.vehicle}</span>
              <span className="text-xs text-neutral-400">{r.defect_location}</span>
            </label>
          ))}
        </div>
      </header>

      {/* メインエリア */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左：情報パネル（1/3幅、スクロール可能） */}
        <aside className="w-1/3 shrink-0 overflow-y-auto border-r border-neutral-200 bg-white">
          {loading && (
            <p className="p-4 text-sm text-neutral-400">読み込み中...</p>
          )}
          {detail && selectedId && (
            <LeftPanel
              recallId={selectedId}
              detail={detail}
              ftaNodes={fta?.nodes ?? null}
            />
          )}
        </aside>

        {/* 右：FTA ツリー */}
        <main className="flex-1 overflow-hidden">
          {loading && (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              読み込み中...
            </div>
          )}
          {fta && (
            <ReactFlowProvider>
              <FTAFlow
                ftaNodes={addMatchCategories(fta.nodes, detail?.label) as any}
                readOnly={true}
              />
            </ReactFlowProvider>
          )}
          {!loading && !fta && (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              FTA データがありません
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
