import { useCallback, useMemo, useState, useEffect, type MouseEvent } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { FTAEventNode, FieldChange, NodeType, VersionDiffKind } from '../../types';
import { normalizeFtaNodeDisplay } from './ftaDisplayNormalize';
import {
  type NodeLayoutResult,
  TITLE_DETAIL_CHEVRON_RESERVE,
  TITLE_DETAIL_TITLE_TRAILING_PAD,
} from './layoutEngine';
import { StagingNodeChoiceButtons } from './StagingNodeChoice';
import { VersionDiffChangedTooltip } from './VersionDiffTooltip';
import type { FtaFlowOrientation } from './ftaFlowOrientation';
import { FtaSiblingOrderArrows } from './FtaSiblingOrderArrows';

/** 矩形ノードの幅・高さ（TOP / basic / individual） */
export const NODE_W = 252;
export const NODE_H = 82;

/**
 * 表示サイズは `layoutEngine` の `computeNodeLayout` が決める。
 * 次の定数はゲート以外の「編集フォーム表示時」やレイアウト前フォールバック用の固定枠のみ。
 */
/** インライン編集中のレイアウト用の高さ */
export const LAYOUT_H_EDITING = 210;

export const NODE_COLORS: Record<NodeType, { bg: string; border: string }> = {
  top: { bg: '#fde8e8', border: '#c0392b' },
  basic: { bg: '#e9f7ef', border: '#27ae60' },
  individual: { bg: '#e5f2fa', border: '#2e86ab' },
  undeveloped: { bg: '#fef3e2', border: '#f39c12' },
};

/** ステージング拒否時: 面・枠だけ同色の一段薄いトーン（グレースケール化はしない） */
export const NODE_COLORS_STAGING_REJECT: Record<NodeType, { bg: string; border: string }> = {
  top: { bg: '#fff5f5', border: '#df9090' },
  basic: { bg: '#f4fcf7', border: '#5dce8c' },
  individual: { bg: '#f0f8fc', border: '#6ab3d6' },
  undeveloped: { bg: '#fffaf3', border: '#f0bd66' },
};

interface FTANodeData extends Record<string, unknown> {
  id: string;
  label: string;
  label_detail: string | null;
  sub_type: NodeType;
  component: string | null;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** 詳細テキストの開閉（クリック） */
  isDetailExpanded?: boolean;
  onToggleDetail?: () => void;
  layout?: NodeLayoutResult;
  isEditMode?: boolean;
  onAddChild?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  isEditing?: boolean;
  onSaveEdit?: (patch: Partial<Pick<FTAEventNode, 'label' | 'component' | 'sub_type'>>) => void;
  onCancelEdit?: () => void;
  onMoveSiblingUp?: () => void;
  onMoveSiblingDown?: () => void;
  /** AI ステージング: `node_list` に含まれるノード上で受理/拒否 */
  stagingChoice?: {
    accepted: boolean;
    disabled: boolean;
    onAccept: () => void;
    onReject: () => void;
  };
  /** AI生成モード時: 通常クリックで展開対象としてトグル */
  expandPick?: boolean;
  expandSelected?: boolean;
  onExpandPick?: () => void;
  readOnly?: boolean;
  versionDiffKind?: VersionDiffKind;
  versionDiffChangedFields?: FieldChange[];
  flowOrientation?: FtaFlowOrientation;
  /** ベンチマーク用: 正解ラベルとの一致カテゴリ */
  matchCategories?: ('component' | 'failure_mode' | 'top_event')[];
  /** 専門家レビューで選択中の評価項目に対応するノードなら true（周期的に光らせる） */
  highlighted?: boolean;
}

function DetailDisclosureChevron({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-detail-toggle
      className="nodrag nopan flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-[#3d3d3d] outline-none"
      aria-expanded={expanded}
      aria-label={expanded ? '詳細を閉じる' : '詳細を開く'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <svg width="9" height="9" viewBox="0 0 8 8" aria-hidden className="shrink-0">
        {expanded ? (
          <polygon points="0,2 8,2 4,7" fill="currentColor" />
        ) : (
          <polygon points="2,0 2,8 7,4" fill="currentColor" />
        )}
      </svg>
    </button>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path
        d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NodeInlineEditForm({
  data,
  onSave,
  onCancel,
}: {
  data: FTANodeData;
  onSave: (patch: Partial<Pick<FTAEventNode, 'label' | 'component' | 'sub_type'>>) => void;
  onCancel: () => void;
}) {
  const [draftType, setDraftType] = useState<NodeType>(data.sub_type);
  const [draftComponent, setDraftComponent] = useState(data.component ?? '');
  const [draftLabel, setDraftLabel] = useState(data.label);

  useEffect(() => {
    if (!data.isEditing) return;
    setDraftType(data.sub_type);
    setDraftComponent(data.component ?? '');
    setDraftLabel(data.label);
  }, [data.isEditing, data.id]);

  const fieldClass =
    'nodrag nopan box-border w-full rounded border border-neutral-300 px-1.5 py-1 text-[11px] focus:border-[#2980b9] focus:outline-none';
  const labelClass = 'mb-0.5 block text-[10px] font-semibold text-neutral-600';

  return (
    <div
      className="nodrag nopan flex min-h-0 w-full min-w-0 flex-col gap-1.5 px-0.5 py-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      <div>
        <span className={labelClass}>ノード種別</span>
        <select
          className={`${fieldClass} bg-white`}
          value={draftType}
          disabled={data.sub_type === 'top'}
          onChange={(e) => setDraftType(e.target.value as NodeType)}
          aria-label="ノード種別"
        >
          <option value="individual">個々の事象</option>
          <option value="basic">基本事象</option>
          <option value="undeveloped">否展開事象</option>
        </select>
      </div>
      <div>
        <span className={labelClass}>部品</span>
        <input
          type="text"
          className={`${fieldClass} bg-white`}
          value={draftComponent}
          onChange={(e) => setDraftComponent(e.target.value)}
          placeholder="例: バッテリーパック"
          aria-label="部品"
        />
      </div>
      <div className="min-h-0 flex-1">
        <span className={labelClass}>説明</span>
        <textarea
          className={`${fieldClass} min-h-[48px] flex-1 resize-y bg-white`}
          rows={2}
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
          aria-label="説明"
        />
      </div>
      <div className="mt-0.5 flex justify-end gap-1.5">
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
          onClick={() =>
            onSave({
              sub_type: draftType,
              component: draftComponent.trim() ? draftComponent.trim() : null,
              label: draftLabel.trim() || data.label,
            })
          }
        >
          保存
        </button>
      </div>
    </div>
  );
}

export function FTAFailureNode({ data }: NodeProps<Node<FTANodeData>>) {
  const [hovered, setHovered] = useState(false);
  const isVertical = data.flowOrientation === 'Vertical';
  const colors = NODE_COLORS[data.sub_type] ?? NODE_COLORS.individual;
  const stagingRejected = Boolean(data.stagingChoice && !data.stagingChoice.accepted);
  const versionRemovedPreview = Boolean(data.readOnly && data.versionDiffKind === 'removed');
  const surface =
    stagingRejected || versionRemovedPreview
      ? (NODE_COLORS_STAGING_REJECT[data.sub_type] ?? NODE_COLORS_STAGING_REJECT.individual)
      : colors;
  const display = useMemo(
    () =>
      normalizeFtaNodeDisplay({
        label: data.label,
        label_detail: data.label_detail,
        component: data.component,
      }),
    [data.label, data.label_detail, data.component],
  );
  const handleClassName = '!h-2 !w-2 !min-h-2 !min-w-2 !border-0';
  const handleStyle = { background: surface.border };

  const handleSurfaceClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (data.readOnly) return;
      if (data.expandPick && data.onExpandPick) {
        const el = e.target as HTMLElement;
        if (el.closest('button')) return;
        if (el.closest('[data-detail-toggle]')) return;
        if (el.closest('[data-sibling-order]')) return;
        if (el.closest('.react-flow__handle')) return;
        e.stopPropagation();
        data.onExpandPick();
        return;
      }
      if (!data.isEditMode || data.isEditing) return;
      const el = e.target as HTMLElement;
      if (el.closest('button')) return;
      if (el.closest('[data-detail-toggle]')) return;
      if (el.closest('[data-sibling-order]')) return;
      if (el.closest('.react-flow__handle')) return;
      data.onEdit?.();
    },
    [data.isEditMode, data.isEditing, data.onEdit, data.expandPick, data.onExpandPick, data.readOnly],
  );

  const layout = data.layout;
  const isEditing = Boolean(data.isEditing);

  const width = isEditing ? NODE_W : (layout?.width ?? NODE_W);
  const height = isEditing ? LAYOUT_H_EDITING : (layout?.height ?? NODE_H);

  const canToggleDetail =
    !isEditing && display.hasExpandableDetail && Boolean(display.detailBody);

  const surfaceClass =
    (data.isEditMode && !isEditing ? 'cursor-pointer' : '') +
    (data.expandPick ? ' cursor-pointer' : '') +
    (data.expandSelected ? ' ring-2 ring-blue-500 ring-offset-1' : '') +
    (data.versionDiffKind === 'added'
      ? ' ring-2 ring-blue-600 ring-offset-1'
      : data.versionDiffKind === 'removed'
        ? ` ring-2 ring-red-600 ring-offset-1${versionRemovedPreview ? '' : ' opacity-[0.78]'}`
        : data.versionDiffKind === 'changed'
          ? ' ring-2 ring-amber-400 ring-offset-1'
          : '') +
    (data.highlighted ? ' fta-node--highlighted' : '');

  const stagingRejectContentDim =
    (data.stagingChoice && !data.stagingChoice.accepted) || versionRemovedPreview
      ? 'opacity-[0.4] saturate-[0.15] brightness-[0.76]'
      : '';

  const diffChangedFields = data.versionDiffChangedFields ?? [];
  const canShowDiffTooltip =
    Boolean(data.readOnly) &&
    data.versionDiffKind === 'changed' &&
    diffChangedFields.length > 0;
  const wantsWholeNodeDiffHover = canShowDiffTooltip;

  const diffTooltip =
    hovered &&
    !isEditing &&
    data.versionDiffKind === 'changed' &&
    diffChangedFields.length > 0 ? (
      <VersionDiffChangedTooltip fields={diffChangedFields} />
    ) : null;

  const targetHandle =
    data.sub_type !== 'top' ? (
      <Handle
        type="target"
        position={isVertical ? Position.Top : Position.Left}
        className={handleClassName}
        style={handleStyle}
      />
    ) : null;

  const collapseBtn = data.hasChildren ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        data.onToggle();
      }}
      title={data.collapsed ? '展開' : '折りたたむ'}
      className={
        isVertical
          ? 'nodrag nopan absolute -bottom-3.5 left-1/2 z-10 flex h-[18px] w-[18px] -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-solid bg-white p-0 text-[10px] font-bold leading-none'
          : 'nodrag nopan absolute -right-3.5 top-1/2 z-10 flex h-[18px] w-[18px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-solid bg-white p-0 text-[10px] font-bold leading-none'
      }
      style={{ borderColor: surface.border, color: surface.border }}
    >
      {data.collapsed ? '+' : '−'}
    </button>
  ) : null;

  const sourceHandle = data.hasChildren ? (
    <Handle
      type="source"
      position={isVertical ? Position.Bottom : Position.Right}
      className={isVertical ? `${handleClassName} -bottom-1!` : `${handleClassName} -right-1!`}
      style={handleStyle}
    />
  ) : null;

  // layout があるが lines が空のとき（楕円での長文レイアウト失敗）はフォールバック
  const fallbackText =
    layout && layout.lines.length === 0 ? (
      <div
        className={`absolute inset-0 flex items-center justify-center pointer-events-none px-3 ${stagingRejectContentDim}`}
        style={{ color: '#1a1a2e', fontSize: 11, lineHeight: '14px', textAlign: 'center', wordBreak: 'break-all' }}
      >
        {display.titleLine}
      </div>
    ) : null;

  const absoluteContent = layout ? (
    layout.lines.length > 0 ? (
    <div className={`absolute inset-0 pointer-events-none ${stagingRejectContentDim}`}>
      {layout.lines.map((line, i) => {
        if (line.leadingDetailToggle && canToggleDetail) {
          return (
            <div
              key={i}
              className="absolute flex items-center justify-start"
              style={{
                left: line.x - TITLE_DETAIL_CHEVRON_RESERVE,
                top: line.y,
                width: line.width + TITLE_DETAIL_CHEVRON_RESERVE + TITLE_DETAIL_TITLE_TRAILING_PAD,
                height: line.lineHeight,
                lineHeight: `${line.lineHeight}px`,
              }}
            >
              <div className="flex max-w-full items-center justify-start pointer-events-auto">
                <DetailDisclosureChevron
                  expanded={Boolean(data.isDetailExpanded)}
                  onToggle={() => data.onToggleDetail?.()}
                />
                <span
                  className="min-w-0 whitespace-pre text-left"
                  style={{ font: line.font, color: line.color, lineHeight: `${line.lineHeight}px` }}
                >
                  {line.text}
                </span>
              </div>
            </div>
          );
        }
        if (line.titleDetailCont) {
          return (
            <div
              key={i}
              className="absolute whitespace-pre text-left"
              style={{
                left: line.x,
                top: line.y,
                height: line.lineHeight,
                font: line.font,
                color: line.color,
                lineHeight: `${line.lineHeight}px`,
              }}
            >
              {line.text}
            </div>
          );
        }
        return (
          <div
            key={i}
            className="absolute whitespace-pre"
            style={{
              left: line.x,
              top: line.y,
              height: line.lineHeight,
              font: line.font,
              color: line.color,
              lineHeight: `${line.lineHeight}px`,
            }}
          >
            {line.text}
          </div>
        );
      })}
    </div>
    ) : fallbackText
  ) : null;

  const editChrome = data.isEditMode ? (
    <>
      {data.onDelete ? (
        <button
          type="button"
          className={`nodrag nopan absolute top-0.5 left-1 z-20 flex h-5.5 w-5.5 items-center justify-center rounded-sm bg-white text-[#b24d4d] shadow-sm transition-opacity duration-150 hover:bg-neutral-100 ${hovered ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
          onClick={(e) => {
            e.stopPropagation();
            data.onDelete?.();
          }}
          aria-label="削除"
        >
          <TrashIcon />
        </button>
      ) : null}
      {data.onAddChild && !data.hasChildren ? (
        <button
          type="button"
          className={
            isVertical
              ? 'nodrag nopan absolute -bottom-7 left-1/2 z-20 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border-2 border-solid bg-white pb-0.5 text-sm font-bold leading-none shadow-sm hover:brightness-95'
              : 'nodrag nopan absolute bottom-0.5 -right-7 z-20 flex h-6 w-6 items-center justify-center rounded-full border-2 border-solid bg-white pb-0.5 text-sm font-bold leading-none shadow-sm hover:brightness-95'
          }
          style={{ borderColor: surface.border, color: surface.border }}
          onClick={(e) => {
            e.stopPropagation();
            data.onAddChild?.();
          }}
          title="子を追加"
          aria-label="子を追加"
        >
          +
        </button>
      ) : null}
      <FtaSiblingOrderArrows
        flowOrientation={data.flowOrientation}
        onMoveUp={data.onMoveSiblingUp}
        onMoveDown={data.onMoveSiblingDown}
      />
    </>
  ) : null;

  const rectangleEventSurface = (
    borderRadius: number | string,
    extraClass: string,
  ) => (
    <>
      <div
        className={`relative box-border flex min-h-0 min-w-0 items-center justify-center border-2 border-solid text-xs transition-shadow ${surfaceClass} ${extraClass}`}
        style={{
          width,
          height,
          background: surface.bg,
          borderColor: surface.border,
          borderRadius,
        }}
        onMouseEnter={wantsWholeNodeDiffHover ? undefined : () => setHovered(true)}
        onMouseLeave={wantsWholeNodeDiffHover ? undefined : () => setHovered(false)}
        onClick={handleSurfaceClick}
      >
        {targetHandle}
        {data.matchCategories && data.matchCategories.length > 0 && (
          <div className="pointer-events-none absolute top-1 right-1 z-10 flex gap-0.5">
            {data.matchCategories.includes('top_event') && (
              <span title="トップ事象一致" className="h-2 w-2 rounded-full bg-red-500 opacity-90" />
            )}
            {data.matchCategories.includes('failure_mode') && (
              <span title="故障モード一致" className="h-2 w-2 rounded-full bg-orange-400 opacity-90" />
            )}
            {data.matchCategories.includes('component') && (
              <span title="対象部品一致" className="h-2 w-2 rounded-full bg-blue-500 opacity-90" />
            )}
          </div>
        )}
        <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col justify-center">
          {isEditing && data.onSaveEdit && data.onCancelEdit ? (
            <NodeInlineEditForm
              data={data}
              onSave={data.onSaveEdit}
              onCancel={data.onCancelEdit}
            />
          ) : (
            absoluteContent
          )}
        </div>
        {collapseBtn}
        {sourceHandle}
        {editChrome}
        {data.stagingChoice && !isEditing ? (
          <div
            className={
              isVertical
                ? 'pointer-events-auto absolute left-full top-1/2 z-60 ml-1 -translate-y-1/2'
                : 'pointer-events-auto absolute left-1/2 top-full z-60 -translate-x-1/2 -translate-y-2'
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
        {wantsWholeNodeDiffHover ? (
          <div
            className="nodrag nopan absolute inset-0 z-8"
            style={{ borderRadius }}
            aria-hidden
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          />
        ) : null}
      </div>
      {diffTooltip}
    </>
  );

  if (data.sub_type === 'individual' || data.sub_type === 'top') {
    return rectangleEventSurface(
      isEditing ? 8 : 0,
      isEditing ? 'z-30 px-2 py-1' : 'rounded-none',
    );
  }

  if (data.sub_type === 'basic') {
    return rectangleEventSurface(
      isEditing ? 8 : '50%',
      isEditing ? 'z-30 px-2 py-1' : '',
    );
  }

  if (data.sub_type === 'undeveloped') {
    const dw = width;
    const viewH = height;
    const diamondPts = `${dw / 2},0 ${dw},${viewH / 2} ${dw / 2},${viewH} 0,${viewH / 2}`;

    if (isEditing && data.onSaveEdit && data.onCancelEdit) {
      return (
        <div
          className={`relative box-border flex min-h-0 min-w-0 flex-col items-stretch justify-center rounded-lg border-2 border-solid px-2 py-2 text-xs transition-shadow ${surfaceClass} z-30`}
          style={{
            width: dw,
            height: viewH,
            background: surface.bg,
            borderColor: surface.border,
            borderRadius: 8,
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={handleSurfaceClick}
        >
          {targetHandle}
          <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col justify-center">
            <NodeInlineEditForm
              data={data}
              onSave={data.onSaveEdit}
              onCancel={data.onCancelEdit}
            />
          </div>
          {collapseBtn}
          {sourceHandle}
          {editChrome}
        </div>
      );
    }

    return (
      <>
        <div
          className={`relative box-border flex min-h-0 w-full flex-col ${surfaceClass}`}
          style={{ width: dw, height: viewH }}
          onMouseEnter={wantsWholeNodeDiffHover ? undefined : () => setHovered(true)}
          onMouseLeave={wantsWholeNodeDiffHover ? undefined : () => setHovered(false)}
          onClick={handleSurfaceClick}
        >
          <svg
            className="pointer-events-none absolute inset-0 block h-full min-h-full w-full"
            viewBox={`0 0 ${dw} ${viewH}`}
            preserveAspectRatio="none"
            style={{ zIndex: 0 }}
            aria-hidden
          >
            <polygon
              points={diamondPts}
              fill={surface.bg}
              stroke={surface.border}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          </svg>
          {targetHandle}
          <div
            className="relative flex w-full min-w-0 flex-1 flex-col items-center justify-center"
            style={{ zIndex: 1 }}
          >
            {absoluteContent}
          </div>
          {collapseBtn}
          {sourceHandle}
          {editChrome}
          {data.stagingChoice && !isEditing ? (
            <div
              className={
                isVertical
                  ? 'pointer-events-auto absolute left-full top-1/2 z-60 ml-1 -translate-y-1/2'
                  : 'pointer-events-auto absolute left-1/2 top-full z-60 -translate-x-1/2 -translate-y-2'
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
          {wantsWholeNodeDiffHover ? (
            <div
              className="nodrag nopan absolute inset-0 z-8"
              aria-hidden
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
            />
          ) : null}
        </div>
        {diffTooltip}
      </>
    );
  }

  const _exhaustive: never = data.sub_type;
  return _exhaustive;
}
