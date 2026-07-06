import { useState, useEffect, type MouseEvent } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { isFtaGateNode, type FTANode, type FieldChange, type VersionDiffKind } from '../../types';
import { StagingNodeChoiceButtons } from './StagingNodeChoice';
import { VersionDiffChangedTooltip } from './VersionDiffTooltip';
import type { FtaFlowOrientation } from './ftaFlowOrientation';

/** 論理ゲートノードの外寸（レイアウトと一致） */
export const GATE_W = 40;
export const GATE_H = 40;

/** インライン編集中の論理ゲートの外寸（内側余白を含む） */
export const GATE_EDIT_W = 130;
export const GATE_EDIT_H = 92;

export interface GateNodeData extends Record<string, unknown> {
  gate_type: string;
  gateId: string;
  readOnly?: boolean;
  versionDiffKind?: VersionDiffKind;
  versionDiffChangedFields?: FieldChange[];
  isEditMode?: boolean;
  isEditing?: boolean;
  onEditGate?: () => void;
  onSaveGate?: (type: 'OR' | 'AND') => void;
  onCancelGate?: () => void;
  onAddChild?: () => void;
  stagingChoice?: {
    accepted: boolean;
    disabled: boolean;
    onAccept: () => void;
    onReject: () => void;
  };
  flowOrientation?: FtaFlowOrientation;
}

/** 子がいないゲートノードを取り除く */
export function clearGateWhenNoChildren(nodes: FTANode[]): FTANode[] {
  return nodes.filter((n) => !isFtaGateNode(n) || nodes.some((c) => c.parent_id === n.id));
}

function GateInlineEdit({
  gateType,
  onSave,
  onCancel,
}: {
  gateType: 'OR' | 'AND';
  onSave: (type: 'OR' | 'AND') => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<'OR' | 'AND'>(gateType);
  useEffect(() => {
    setType(gateType);
  }, [gateType]);
  const fieldClass =
    'nodrag nopan box-border w-full rounded border border-neutral-300 px-1.5 py-1 text-[11px] focus:border-[#2980b9] focus:outline-none bg-white';
  return (
    <div
      className="nodrag nopan flex min-h-0 min-w-0 w-full flex-1 flex-col gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      <div>
        <span className="mb-0.5 block text-[10px] font-semibold text-neutral-600">ゲート種別</span>
        <select
          className={fieldClass}
          value={type}
          onChange={(e) => setType(e.target.value as 'OR' | 'AND')}
          aria-label="ゲート種別"
        >
          <option value="OR">OR ゲート</option>
          <option value="AND">AND ゲート</option>
        </select>
      </div>
      <div className="mt-0 flex justify-end gap-1.5">
        <button
          type="button"
          className="nodrag nopan rounded border border-neutral-300 bg-white px-2 py-1 text-[10px] font-semibold text-neutral-700 hover:bg-neutral-50"
          onClick={onCancel}
        >
          キャンセル
        </button>
        <button
          type="button"
          className="nodrag nopan rounded bg-[#2980b9] px-2 py-1 text-[10px] font-semibold text-white hover:bg-[#2471a3]"
          onClick={() => onSave(type)}
        >
          保存
        </button>
      </div>
    </div>
  );
}

/** どちらもグレー。OR は白寄り、AND は黒寄りで判別 */
const GATE_PALETTE = {
  OR: { bg: '#f4f4f5', border: '#c8c9d0', label: '#4a4d55' },
  AND: {
    bg: '#3a3c41',
    border: '#25262b',
    label: '#eeeff1',
    /** 暗地でもハンドルが見えるよう枠より明るく */
    handle: '#9a9da6',
  },
} as const;

export function GateNode({ data }: NodeProps<Node<GateNodeData>>) {
  const [hovered, setHovered] = useState(false);
  const isVertical = data.flowOrientation === 'Vertical';
  const isOr = data.gate_type === 'OR';
  const palette = isOr ? GATE_PALETTE.OR : GATE_PALETTE.AND;
  const { bg, border, label: labelColor } = palette;
  const handleFill = 'handle' in palette ? palette.handle : border;
  const editing = Boolean(data.isEditing);
  const readOnly = Boolean(data.readOnly);
  const versionRemovedPreview = readOnly && data.versionDiffKind === 'removed';
  const canEnterEdit = Boolean(data.isEditMode && data.onEditGate && !editing && !readOnly);
  const w = editing ? GATE_EDIT_W : GATE_W;
  const h = editing ? GATE_EDIT_H : GATE_H;

  const handleSurfaceClick = (e: MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (!canEnterEdit) return;
    const el = e.target as HTMLElement;
    if (el.closest('button')) return;
    if (el.closest('.react-flow__handle')) return;
    if (el.closest('select')) return;
    data.onEditGate?.();
  };

  const surfaceClass =
    (canEnterEdit ? 'cursor-pointer' : '') +
    (data.versionDiffKind === 'added'
      ? ' ring-2 ring-blue-600 ring-offset-1'
      : data.versionDiffKind === 'removed'
        ? ` ring-2 ring-red-600 ring-offset-1${versionRemovedPreview ? '' : ' opacity-75'}`
        : data.versionDiffKind === 'changed'
          ? ' ring-2 ring-amber-400 ring-offset-1'
          : '');

  const diffTitle =
    data.versionDiffKind === 'changed' && data.versionDiffChangedFields?.length
      ? data.versionDiffChangedFields
          .map((c) => `${c.field}: ${String(c.before ?? '')} → ${String(c.after ?? '')}`)
          .join(' / ')
      : undefined;

  const showVersionDiffPopup =
    readOnly &&
    data.versionDiffKind === 'changed' &&
    (data.versionDiffChangedFields?.length ?? 0) > 0;

  const stagingRejected = Boolean(data.stagingChoice && !data.stagingChoice.accepted && !editing);
  const dimRejectLike = stagingRejected || versionRemovedPreview;
  const surfaceBg = editing ? '#f1f2f4' : dimRejectLike ? (isOr ? '#fafbfc' : '#4d5058') : bg;
  const surfaceBorder = dimRejectLike ? (isOr ? '#d8d9e0' : '#3a3d44') : border;
  const handleFillResolved = editing
    ? 'handle' in palette
      ? palette.handle
      : border
    : dimRejectLike
      ? isOr
        ? surfaceBorder
        : '#b4b7c0'
      : handleFill;
  const labelResolved = dimRejectLike && !editing ? (isOr ? '#69707a' : '#cfd2d8') : labelColor;

  return (
    <div className="relative flex flex-col items-center justify-center">
      <div className="relative shrink-0">
        {hovered && showVersionDiffPopup && data.versionDiffChangedFields ? (
          <VersionDiffChangedTooltip fields={data.versionDiffChangedFields} />
        ) : null}
        <div
          className={`relative box-border flex h-full w-full min-h-0 min-w-0 flex-col items-stretch justify-center border-2 border-solid shadow-sm transition-shadow ${surfaceClass} ${editing ? 'z-30 px-2 py-1.5' : ''}`}
          style={{
            width: w,
            height: h,
            borderRadius: editing ? 10 : '50%',
            /* 編集中はフォーム可読のため明るい面（通常時は OR 明 / AND 暗で判別） */
            backgroundColor: surfaceBg,
            borderColor: surfaceBorder,
          }}
          title={showVersionDiffPopup ? undefined : diffTitle}
          onClick={handleSurfaceClick}
        >
          <Handle
            type="target"
            position={isVertical ? Position.Top : Position.Left}
            className="!h-2 !w-2 !min-h-2 !min-w-2 !border-0"
            style={{ backgroundColor: handleFillResolved }}
          />
          {editing && data.onSaveGate && data.onCancelGate ? (
            <GateInlineEdit
              gateType={data.gate_type as 'OR' | 'AND'}
              onSave={data.onSaveGate}
              onCancel={data.onCancelGate}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-1">
              <span
                className="pointer-events-none text-center text-xs font-bold"
                style={{ color: labelResolved }}
              >
                {data.gate_type}
              </span>
            </div>
          )}
          <Handle
            type="source"
            position={isVertical ? Position.Bottom : Position.Right}
            className="!h-2 !w-2 !min-h-2 !min-w-2 !border-0"
            style={{ backgroundColor: handleFillResolved }}
          />
          {showVersionDiffPopup ? (
            <div
              className={`nodrag nopan absolute inset-0 z-[8] ${editing ? 'rounded-[10px]' : 'rounded-full'}`}
              aria-hidden
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
            />
          ) : null}
        </div>
      </div>
      {data.isEditMode && data.onAddChild && !readOnly && (
        <button
          type="button"
          className={
            isVertical
              ? 'nodrag nopan absolute -bottom-7 left-1/2 z-20 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border-2 border-solid bg-white pb-0.5 text-sm font-bold leading-none shadow-sm hover:brightness-95'
              : 'nodrag nopan absolute -right-7 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border-2 border-solid bg-white pb-0.5 text-sm font-bold leading-none shadow-sm hover:brightness-95'
          }
          style={{ borderColor: stagingRejected ? surfaceBorder : border, color: stagingRejected ? surfaceBorder : border }}
          onClick={(e) => {
            e.stopPropagation();
            data.onAddChild?.();
          }}
          title="子を追加"
          aria-label="子を追加"
        >
          +
        </button>
      )}
      {data.stagingChoice && !editing ? (
        <div
          className={
            isVertical
              ? 'pointer-events-auto absolute left-full top-1/2 z-[60] ml-1 flex -translate-y-1/2 justify-center'
              : 'pointer-events-auto absolute left-1/2 top-full z-[60] flex -translate-x-1/2 -translate-y-2 justify-center'
          }
        >
          <StagingNodeChoiceButtons
            accepted={data.stagingChoice.accepted}
            disabled={data.stagingChoice.disabled}
            onAccept={data.stagingChoice.onAccept}
            onReject={data.stagingChoice.onReject}
          />
        </div>
      ) : null}
    </div>
  );
}
