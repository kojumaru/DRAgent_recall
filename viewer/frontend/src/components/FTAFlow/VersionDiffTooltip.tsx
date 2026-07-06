import type { FieldChange } from '../../types';

const DIFF_FIELD_LABELS: Record<string, string> = {
  parent_id: '親',
  order_index: '順序',
  step: 'ステップ',
  node_type: 'ノード種別',
  node_sub_type: 'サブ種別',
  label: 'ラベル',
  description: '説明',
};

function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined) return '（なし）';
  if (typeof v === 'string') return v || '（空）';
  return String(v);
}

/** 履歴プレビュー: 変更ノード上（ノードの上側）に表示する差分ポップアップ */
export function VersionDiffChangedTooltip({ fields }: { fields: FieldChange[] }) {
  if (!fields.length) return null;
  return (
    <div className="nodrag nopan pointer-events-none absolute left-1/2 bottom-full z-[9999] mb-2 max-h-[min(280px,50vh)] w-max max-w-[min(420px,94vw)] -translate-x-1/2 overflow-auto rounded-lg border-2 border-amber-300/90 bg-amber-50 px-3 py-2.5 text-left shadow-lg">
      <div className="mb-1.5 text-[12px] font-bold text-amber-950">変更内容</div>
      <table className="w-full min-w-[300px] border-collapse text-[11px] leading-snug text-neutral-900">
        <thead>
          <tr className="border-b border-amber-200">
            <th className="min-w-[6rem] py-1 pr-3 text-left text-[11px] font-semibold">項目</th>
            <th className="min-w-[7.5rem] max-w-[12rem] px-2 py-1 text-left text-[11px] font-semibold">
              変更前
            </th>
            <th className="min-w-[7.5rem] max-w-[12rem] py-1 pl-2 text-left text-[11px] font-semibold">
              変更後
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((c, i) => (
            <tr key={i} className="border-b border-amber-100/90 last:border-b-0">
              <td className="py-1 pr-3 align-top font-semibold text-neutral-800">
                {DIFF_FIELD_LABELS[c.field] ?? c.field}
              </td>
              <td className="max-w-[12rem] whitespace-pre-wrap break-words px-2 py-1 align-top text-[11px] text-red-800">
                {formatDiffValue(c.before)}
              </td>
              <td className="max-w-[12rem] whitespace-pre-wrap break-words py-1 pl-2 align-top text-[11px] text-blue-900">
                {formatDiffValue(c.after)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
