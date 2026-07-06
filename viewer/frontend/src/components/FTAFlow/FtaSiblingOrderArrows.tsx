import type { FtaFlowOrientation } from './ftaFlowOrientation';

/**
 * 同一親の下で兄弟が複数あるとき、事象ノードの並びを入れ替える ↑↓。
 * （この UI のみを共有する。ゲートは編集 UI で常に1つなので対象外。）
 */
export function FtaSiblingOrderArrows({
  flowOrientation,
  onMoveUp,
  onMoveDown,
}: {
  flowOrientation?: FtaFlowOrientation;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  if (!onMoveUp && !onMoveDown) return null;
  const isVertical = flowOrientation === 'Vertical';
  const btnClass =
    'nodrag nopan flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-300 bg-white text-[10px] font-bold leading-none text-neutral-700 shadow-xs hover:bg-neutral-50';
  return (
    <div
      data-sibling-order
      className={
        isVertical
          ? 'pointer-events-auto absolute left-1/2 -top-[46px] z-30 flex -translate-x-1/2 flex-row gap-0.5'
          : 'pointer-events-auto absolute -left-[26px] top-1/2 z-30 flex -translate-y-1/2 flex-col gap-0.5'
      }
    >
      {onMoveUp ? (
        <button
          type="button"
          className={btnClass}
          title="上の兄弟と入れ替え"
          aria-label="上へ"
          onClick={(e) => {
            e.stopPropagation();
            onMoveUp();
          }}
        >
          ↑
        </button>
      ) : null}
      {onMoveDown ? (
        <button
          type="button"
          className={btnClass}
          title="下の兄弟と入れ替え"
          aria-label="下へ"
          onClick={(e) => {
            e.stopPropagation();
            onMoveDown();
          }}
        >
          ↓
        </button>
      ) : null}
    </div>
  );
}
