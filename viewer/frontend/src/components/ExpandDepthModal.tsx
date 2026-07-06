import { useState } from 'react';

/** Shared modal backdrop: light neutral dim, no blur, full viewport. */
export const MODAL_SCRIM_CLASS =
  'fixed inset-0 z-100 flex items-center justify-center bg-black/50 p-4';

/** Stacked confirm on top of another modal (e.g. tree delete over tree list). */
export const MODAL_SCRIM_NESTED_CLASS =
  'fixed inset-0 z-110 flex items-center justify-center bg-black/50 p-4';

export interface ExpandDepthModalProps {
  minDepth: number;
  maxDepth: number;
  onClose: () => void;
  onConfirm: (depth: number) => void;
}

export default function ExpandDepthModal({
  minDepth,
  maxDepth,
  onClose,
  onConfirm,
}: ExpandDepthModalProps) {
  const depthOptions = Array.from(
    { length: maxDepth - minDepth + 1 },
    (_, i) => minDepth + i,
  );
  const [depth, setDepth] = useState(minDepth);

  return (
    <div
      className={MODAL_SCRIM_CLASS}
      role="dialog"
      aria-modal="true"
      aria-labelledby="expand-depth-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="expand-depth-title" className="mb-3 mt-0 text-base font-medium text-[#1a1a2e]">
          展開する深さ
        </h3>
        <label className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-neutral-700">
          <span className="shrink-0">最大</span>
          <select
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="min-w-[4rem] rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[13px] font-medium text-neutral-900"
          >
            {depthOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <span className="shrink-0">層まで</span>
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-[13px] font-semibold text-neutral-700 hover:bg-neutral-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onConfirm(depth)}
            className="rounded-md border border-[#7eb3d9] bg-[#f5fafc] px-4 py-2 text-[13px] font-semibold text-[#1a5276] hover:bg-[#eaf4f9]"
          >
            生成開始
          </button>
        </div>
      </div>
    </div>
  );
}
