/** AI ステージング時: ノード下に載せる 拒否 / 受理（`nodrag` / `nopan` 必須）。左が拒否、右が受理。 */
const BTN =
  'min-h-[22px] min-w-[44px] cursor-pointer rounded border px-1.5 py-0.5 text-[10px] font-bold leading-none disabled:cursor-not-allowed disabled:opacity-50';

export function StagingNodeChoiceButtons({
  accepted,
  disabled,
  onAccept,
  onReject,
  className = '',
}: {
  accepted: boolean;
  disabled: boolean;
  onAccept: () => void;
  onReject: () => void;
  className?: string;
}) {
  const rejectBtn = !accepted
    ? `${BTN} border-neutral-600 bg-neutral-600 text-white hover:bg-neutral-700`
    : `${BTN} border-neutral-300 bg-neutral-100 text-neutral-700 hover:bg-neutral-200`;

  const acceptBtn = accepted
    ? `${BTN} border-[#219a52] bg-[#27ae60] text-white hover:bg-[#229954]`
    : `${BTN} border-[#27ae60] bg-white text-[#27ae60] hover:bg-emerald-50`;

  return (
    <div className={`nodrag nopan flex gap-0.5 ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onReject();
        }}
        aria-label="この変更を拒否する"
        aria-pressed={!accepted}
        className={rejectBtn}
      >
        拒否
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onAccept();
        }}
        aria-label="この変更を受理する"
        aria-pressed={accepted}
        className={acceptBtn}
      >
        受理
      </button>
    </div>
  );
}
