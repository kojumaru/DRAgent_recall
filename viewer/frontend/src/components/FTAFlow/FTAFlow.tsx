import '@xyflow/react/dist/style.css';
import {
  useMemo,
  useCallback,
  useState,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { createPortal } from 'react-dom';
import type { RefObject } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useReactFlow,
  type Node,
  type Edge,
} from '@xyflow/react';
import {
  isFtaEventNode,
  isFtaGateNode,
  type FTAEventNode,
  type FTAGateNode,
  type FTANode,
  type PdfProductSnapshot,
  type FieldChange,
  type VersionDiffKind,
} from '../../types';
import { compareFtaSiblings, reorderFtaSiblingNodes } from '../../ftaSiblingOrder';
import { FTAFailureNode } from './FTAFailureNode';
import { NODE_LAYOUT_PARAM_FINGERPRINT } from './layoutEngine';
import {
  GateNode,
  clearGateWhenNoChildren,
  type GateNodeData,
} from './FTAGate';
import { exportFtaFlowToPdf } from './PDFExport';
import {
  type FtaFlowOrientation,
  readFtaFlowOrientationFromStorage,
  writeFtaFlowOrientationToStorage,
} from './ftaFlowOrientation';
import { buildLayout, type VisualNode } from './ftaFlowTreeLayout';
import { MODAL_SCRIM_CLASS } from '../ExpandDepthModal';

/** 兄弟入れ替え時のノード座標 CSS transition（`index.css` の duration と揃える） */
const REORDER_LAYOUT_TRANSITION_MS = 320;
/** 再表示するエッジの fade-in（`index.css` の keyframes 時間と揃える） */
const REORDER_EDGE_FADE_IN_MS = 360;

export type { FtaFlowOrientation } from './ftaFlowOrientation';
export type { VisualNode } from './ftaFlowTreeLayout';

/** 削除対象となる部分木の ID（自身を含む） */
function collectSubtreeIds(rootId: string, nodes: FTANode[]): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    if (!byParent.has(n.parent_id)) byParent.set(n.parent_id, []);
    byParent.get(n.parent_id)!.push(n.id);
  }
  const acc = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (acc.has(id)) continue;
    acc.add(id);
    for (const c of byParent.get(id) ?? []) stack.push(c);
  }
  return acc;
}

function DeleteConfirmModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return createPortal(
    <div
      className={MODAL_SCRIM_CLASS}
      role="dialog"
      aria-modal="true"
      aria-labelledby="fta-node-delete-title"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h3 id="fta-node-delete-title" className="mb-2 mt-0 text-base font-bold text-[#1a1a2e]">
          ノードの削除
        </h3>
        <p className="mb-3 text-[13px] leading-relaxed text-neutral-600">
          このノードと、それに連なるすべての子孫ノードを削除します。よろしいですか？
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-md border border-neutral-300 bg-white px-4 py-2 text-[13px] font-semibold text-neutral-700 hover:bg-neutral-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="cursor-pointer rounded-md border-0 bg-[#b24d4d] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#a64646]"
          >
            削除する
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const nodeTypes = { ftaNode: FTAFailureNode, gateNode: GateNode };

export interface FTAFlowHandle {
  downloadPdf: (product: PdfProductSnapshot | null | undefined) => Promise<void>;
}

const FTAFlowController = forwardRef<
  FTAFlowHandle,
  { flowWrapperRef: RefObject<HTMLDivElement | null>; flowOrientation: FtaFlowOrientation }
>(({ flowWrapperRef, flowOrientation }, ref) => {
  const { fitView, getViewport, setViewport } = useReactFlow();
  const orientationRef = useRef<FtaFlowOrientation | null>(null);

  useEffect(() => {
    const prev = orientationRef.current;
    orientationRef.current = flowOrientation;
    if (prev !== null && prev !== flowOrientation) {
      requestAnimationFrame(() => {
        fitView({ padding: 0.15 });
      });
    }
  }, [flowOrientation, fitView]);

  useImperativeHandle(ref, () => ({
    async downloadPdf(product: PdfProductSnapshot | null | undefined) {
      await exportFtaFlowToPdf(flowWrapperRef.current, product, {
        fitView,
        getViewport,
        setViewport,
      });
    },
  }));

  return null;
});

/** バージョン履歴プレビュー時のノード単位 diff */
export type VersionDiffByNodeId = Readonly<
  Record<string, { kind: VersionDiffKind; changed_fields: FieldChange[] }>
>;

function hasChangedVersionDiff(
  diff: { kind: VersionDiffKind; changed_fields: FieldChange[] } | undefined,
): boolean {
  return diff?.kind === 'changed' && diff.changed_fields.length > 0;
}

interface Props {
  ftaNodes: FTANode[];
  isEditMode?: boolean;
  onTreeUpdate?: (updater: (prev: FTANode[]) => FTANode[]) => void;
  /** AI提案の受理/棄却関連 */
  stagingNodeChoices?: Record<string, boolean> | null;
  onStagingChoiceChange?: (nodeId: string, accepted: boolean) => void;
  stagingChoicesDisabled?: boolean;
  /** AI生成モード時: イベントノードの通常クリックで展開対象をトグル */
  expandPickMode?: boolean;
  expandSelectedIds?: ReadonlySet<string>;
  onExpandPickToggle?: (nodeId: string) => void;
  /** 履歴プレビュー等: 編集・展開対象選択を無効化 */
  readOnly?: boolean;
  /** ノード id -> 直前バージョンからの差分（見た目用） */
  versionDiffByNodeId?: VersionDiffByNodeId | null;
}

const FTAFlow = forwardRef<FTAFlowHandle, Props>(function FTAFlow(
  {
    ftaNodes,
    isEditMode = false,
    onTreeUpdate,
    stagingNodeChoices = null,
    onStagingChoiceChange,
    stagingChoicesDisabled = false,
    expandPickMode = false,
    expandSelectedIds = new Set(),
    onExpandPickToggle,
    readOnly = false,
    versionDiffByNodeId = null,
  },
  ref,
) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingGateParentId, setEditingGateParentId] = useState<string | null>(null);
  const [deletingNodeId, setDeletingNodeId] = useState<string | null>(null);
  const [detailExpandedIds, setDetailExpandedIds] = useState<Set<string>>(() => new Set());
  const [flowOrientation, setFlowOrientation] = useState<FtaFlowOrientation>(() =>
    readFtaFlowOrientationFromStorage(),
  );
  const flowWrapperRef = useRef<HTMLDivElement>(null);
  const reorderMotionTimerRef = useRef(0);
  const reorderFadeInTimerRef = useRef(0);
  const pendingFadeInEdgeIdsRef = useRef<string[] | null>(null);
  const [reorderFadeInEdgeIds, setReorderFadeInEdgeIds] = useState<readonly string[] | null>(null);
  const [reorderLayoutTransition, setReorderLayoutTransition] = useState(false);
  /** 入れ替えアニメーション中のみ: 枝を隠す対象となる2つの兄弟根（各根の部分木に接するエッジを非表示） */
  const [reorderHiddenEdgeRoots, setReorderHiddenEdgeRoots] = useState<{
    rootA: string;
    rootB: string;
  } | null>(null);

  useEffect(() => {
    return () => {
      window.clearTimeout(reorderMotionTimerRef.current);
      window.clearTimeout(reorderFadeInTimerRef.current);
    };
  }, []);

  const setFlowOrientationPersisted = useCallback((next: FtaFlowOrientation) => {
    setFlowOrientation(next);
    writeFtaFlowOrientationToStorage(next);
  }, []);

  const siblingReorderInfo = useMemo(() => {
    const byParent = new Map<string | null, FTANode[]>();
    for (const n of ftaNodes) {
      const p = n.parent_id;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(n);
    }
    const info = new Map<string, { count: number; index: number }>();
    for (const [, group] of byParent) {
      const sorted = [...group].sort(compareFtaSiblings);
      sorted.forEach((n, i) => info.set(n.id, { count: sorted.length, index: i }));
    }
    return info;
  }, [ftaNodes]);

  const reorderSibling = useCallback(
    (nodeId: string, delta: -1 | 1) => {
      let swapped: [string, string] | null = null;
      pendingFadeInEdgeIdsRef.current = null;
      onTreeUpdate?.((prev) => {
        const { nodes: next, swappedPair } = reorderFtaSiblingNodes(prev, nodeId, delta);
        swapped = swappedPair;
        if (swappedPair) {
          const hid = new Set<string>();
          for (const id of collectSubtreeIds(swappedPair[0], next)) hid.add(id);
          for (const id of collectSubtreeIds(swappedPair[1], next)) hid.add(id);
          const edgeIds: string[] = [];
          for (const n of next) {
            if (!n.parent_id) continue;
            if (hid.has(n.id) || hid.has(n.parent_id)) {
              edgeIds.push(`e-${n.parent_id}-${n.id}`);
            }
          }
          pendingFadeInEdgeIdsRef.current = edgeIds;
        }
        return next;
      });
      if (!swapped) return;
      setReorderFadeInEdgeIds(null);
      window.clearTimeout(reorderFadeInTimerRef.current);
      setReorderLayoutTransition(true);
      setReorderHiddenEdgeRoots({ rootA: swapped[0], rootB: swapped[1] });
      window.clearTimeout(reorderMotionTimerRef.current);
      reorderMotionTimerRef.current = window.setTimeout(() => {
        setReorderLayoutTransition(false);
        setReorderHiddenEdgeRoots(null);
        const ids = pendingFadeInEdgeIdsRef.current;
        pendingFadeInEdgeIdsRef.current = null;
        if (ids && ids.length > 0) {
          setReorderFadeInEdgeIds(ids);
          reorderFadeInTimerRef.current = window.setTimeout(() => {
            setReorderFadeInEdgeIds(null);
          }, REORDER_EDGE_FADE_IN_MS);
        }
      }, REORDER_LAYOUT_TRANSITION_MS);
    },
    [onTreeUpdate],
  );

  const addChild = useCallback(
    (parentId: string) => {
      onTreeUpdate?.((prev) => {
        const parent = prev.find((n) => n.id === parentId);
        if (!parent) return prev;
        const parentIsGate = isFtaGateNode(parent);
        const gateId = parentIsGate
          ? parent.id
          : (prev.find((n) => isFtaGateNode(n) && n.parent_id === parentId)?.id ?? crypto.randomUUID());
        const creatingNewGate = !parentIsGate && !prev.some((n) => n.id === gateId);
        const maxOrderUnder = (nodes: FTANode[], pid: string | null) => {
          let m = -1;
          for (const x of nodes) {
            if (x.parent_id === pid && x.order_index > m) m = x.order_index;
          }
          return m;
        };
        const newId = crypto.randomUUID();
        const childOrderIndex = parentIsGate
          ? maxOrderUnder(prev, gateId) + 1
          : creatingNewGate
            ? 0
            : maxOrderUnder(prev, gateId) + 1;
        const newNode: FTAEventNode = {
          type: 'event',
          sub_type: 'individual',
          id: newId,
          label: '新しい事象',
          label_detail: null,
          parent_id: gateId,
          step: parent.step + 1,
          order_index: childOrderIndex,
          component: null,
        };
        const pIdx = prev.findIndex((n) => n.id === parentId);
        const next = [...prev];
        const additions: FTANode[] = [];
        if (creatingNewGate) {
          const gateNode: FTAGateNode = {
            type: 'gate',
            sub_type: 'OR',
            id: gateId,
            label: 'OR',
            label_detail: null,
            parent_id: parentId,
            step: parent.step + 1,
            order_index: maxOrderUnder(prev, parentId) + 1,
            component: null,
          };
          additions.push(gateNode);
        }
        if (!parentIsGate && pIdx >= 0) {
          const p = next[pIdx];
          // 基本事象は葉のみ — 子を付けたら個々の事象へ
          if (isFtaEventNode(p) && p.sub_type === 'basic') {
            next[pIdx] = { ...p, sub_type: 'individual' };
          }
        }
        return [...next, ...additions, newNode];
      });
    },
    [onTreeUpdate],
  );

  const confirmDelete = useCallback(
    (nodeId: string) => {
      onTreeUpdate?.((prev) => {
        const target = prev.find((n) => n.id === nodeId);
        if (!target || (isFtaEventNode(target) && target.sub_type === 'top')) return prev;
        const remove = collectSubtreeIds(nodeId, prev);
        let next = prev.filter((n) => !remove.has(n.id));
        next = clearGateWhenNoChildren(next);
        return next;
      });
      setDeletingNodeId(null);
    },
    [onTreeUpdate],
  );

  const updateNode = useCallback(
    (nodeId: string, patch: Partial<Pick<FTAEventNode, 'label' | 'component' | 'sub_type'>>) => {
      onTreeUpdate?.((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId || !isFtaEventNode(n)) return n;
          const merged = { ...n, ...patch };
          const hasKids = prev.some((c) => c.parent_id === nodeId);
          if (hasKids && merged.sub_type === 'basic') {
            return { ...merged, sub_type: 'individual' as const };
          }
          return merged;
        }),
      );
      setEditingNodeId(null);
    },
    [onTreeUpdate],
  );

  const updateGate = useCallback(
    (gateId: string, newType: 'OR' | 'AND') => {
      onTreeUpdate?.((prev) =>
        prev.map((n) =>
          n.id === gateId && isFtaGateNode(n)
            ? { ...n, sub_type: newType, label: newType }
            : n,
        ),
      );
      setEditingGateParentId(null);
    },
    [onTreeUpdate],
  );

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const toggleDetailExpanded = useCallback((nodeId: string) => {
    setDetailExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const childrenMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const n of ftaNodes) {
      if (n.parent_id) {
        if (!map.has(n.parent_id)) map.set(n.parent_id, []);
        map.get(n.parent_id)!.push(n.id);
      }
    }
    return map;
  }, [ftaNodes]);

  const reorderHiddenEdgeNodeIds = useMemo(() => {
    if (!reorderHiddenEdgeRoots) return null;
    const out = new Set<string>();
    for (const id of collectSubtreeIds(reorderHiddenEdgeRoots.rootA, ftaNodes)) out.add(id);
    for (const id of collectSubtreeIds(reorderHiddenEdgeRoots.rootB, ftaNodes)) out.add(id);
    return out;
  }, [reorderHiddenEdgeRoots, ftaNodes]);

  const { nodes, edges } = useMemo(() => {
    const stagingFor = (id: string) => {
      if (readOnly) return undefined;
      if (stagingNodeChoices == null || !Object.prototype.hasOwnProperty.call(stagingNodeChoices, id)) {
        return undefined;
      }
      return {
        accepted: stagingNodeChoices[id] ?? false,
        disabled: stagingChoicesDisabled,
        onAccept: () => onStagingChoiceChange?.(id, true),
        onReject: () => onStagingChoiceChange?.(id, false),
      };
    };

    const allVisualNodes: VisualNode[] = ftaNodes.map((n) =>
      isFtaGateNode(n)
        ? { id: n.id, parent_id: n.parent_id, isGate: true as const, data: n }
        : { id: n.id, parent_id: n.parent_id, isGate: false as const, data: n },
    );

    const layoutExpandId =
      isEditMode && editingNodeId
        ? editingNodeId
        : isEditMode && editingGateParentId
          ? editingGateParentId
          : null;
    const { positions, visibleIds, layouts } = buildLayout(
      allVisualNodes,
      collapsed,
      layoutExpandId,
      detailExpandedIds,
      flowOrientation,
    );

    const rfNodes: Node[] = allVisualNodes
      .filter((n) => visibleIds.has(n.id))
      .map((n) => {
        if (n.isGate) {
          const gate = n.data as FTAGateNode;
          const gd: GateNodeData = { gate_type: gate.sub_type, gateId: gate.id };
          const sc = stagingFor(gd.gateId);
          const vd = versionDiffByNodeId?.[gd.gateId];
          const liftDiffTooltip = readOnly && hasChangedVersionDiff(vd);
          return {
            id: n.id,
            type: 'gateNode',
            position: positions.get(n.id) ?? { x: 0, y: 0 },
            ...(liftDiffTooltip ? { zIndex: 4000 } : {}),
            data: {
              gate_type: gd.gate_type,
              gateId: gd.gateId,
              flowOrientation,
              readOnly,
              ...(vd
                ? {
                    versionDiffKind: vd.kind,
                    versionDiffChangedFields: vd.changed_fields,
                  }
                : {}),
              ...(sc ? { stagingChoice: sc } : {}),
              isEditMode: isEditMode && !readOnly,
              isEditing: isEditMode && !readOnly && editingGateParentId === gd.gateId,
              onEditGate:
                isEditMode && onTreeUpdate && !readOnly
                  ? () => {
                      setEditingNodeId(null);
                      setEditingGateParentId(gd.gateId);
                    }
                  : undefined,
              onSaveGate:
                isEditMode && onTreeUpdate && !readOnly
                  ? (type: 'OR' | 'AND') => updateGate(gd.gateId, type)
                  : undefined,
              onCancelGate:
                isEditMode && onTreeUpdate && !readOnly ? () => setEditingGateParentId(null) : undefined,
              onAddChild:
                isEditMode && onTreeUpdate && !readOnly ? () => addChild(gd.gateId) : undefined,
            },
          };
        } else {
          const fd = n.data as FTAEventNode;
          const hasChildren = (childrenMap.get(n.id)?.length ?? 0) > 0;
          const sInfo = siblingReorderInfo.get(fd.id);
          const canReorderSiblings =
            (sInfo?.count ?? 0) > 1 && isEditMode && onTreeUpdate && !readOnly;
          const sc = stagingFor(fd.id);
          const vd = versionDiffByNodeId?.[fd.id];
          const liftDiffTooltip = readOnly && hasChangedVersionDiff(vd);
          return {
            id: n.id,
            type: 'ftaNode',
            position: positions.get(n.id) ?? { x: 0, y: 0 },
            ...(liftDiffTooltip ? { zIndex: 4000 } : {}),
            data: {
              ...fd,
              id: fd.id,
              layout: layouts.get(fd.id),
              flowOrientation,
              readOnly,
              ...(vd
                ? {
                    versionDiffKind: vd.kind,
                    versionDiffChangedFields: vd.changed_fields,
                  }
                : {}),
              ...(sc ? { stagingChoice: sc } : {}),
              hasChildren,
              collapsed: collapsed.has(n.id),
              onToggle: () => toggleCollapse(n.id),
              isDetailExpanded: detailExpandedIds.has(fd.id),
              onToggleDetail: () => toggleDetailExpanded(fd.id),
              isEditMode: isEditMode && !readOnly,
              isEditing: editingNodeId === fd.id && !readOnly,
              onAddChild:
                isEditMode && onTreeUpdate && !readOnly && !hasChildren ? () => addChild(fd.id) : undefined,
              onDelete:
                isEditMode && onTreeUpdate && !readOnly && fd.sub_type !== 'top'
                  ? () => setDeletingNodeId(fd.id)
                  : undefined,
              onEdit:
                isEditMode && onTreeUpdate && !readOnly
                  ? () => {
                      setEditingGateParentId(null);
                      setEditingNodeId(fd.id);
                    }
                  : undefined,
              onSaveEdit:
                isEditMode && onTreeUpdate && !readOnly
                  ? (patch: Partial<Pick<FTAEventNode, 'label' | 'component' | 'sub_type'>>) =>
                      updateNode(fd.id, patch)
                  : undefined,
              onCancelEdit:
                isEditMode && onTreeUpdate && !readOnly ? () => setEditingNodeId(null) : undefined,
              onMoveSiblingUp:
                canReorderSiblings && (sInfo?.index ?? 0) > 0
                  ? () => reorderSibling(fd.id, -1)
                  : undefined,
              onMoveSiblingDown:
                canReorderSiblings && sInfo != null && sInfo.index < sInfo.count - 1
                  ? () => reorderSibling(fd.id, 1)
                  : undefined,
              ...(readOnly || !expandPickMode || !onExpandPickToggle || hasChildren
                ? {}
                : {
                    expandPick: true,
                    expandSelected: expandSelectedIds.has(fd.id),
                    onExpandPick: () => onExpandPickToggle(fd.id),
                  }),
            },
          };
        }
      });

    const fadeInSet =
      reorderFadeInEdgeIds && reorderFadeInEdgeIds.length > 0
        ? new Set(reorderFadeInEdgeIds)
        : null;

    const rfEdges: Edge[] = allVisualNodes
      .filter((n) => {
        if (!n.parent_id || !visibleIds.has(n.id) || !visibleIds.has(n.parent_id)) return false;
        if (reorderHiddenEdgeNodeIds) {
          if (reorderHiddenEdgeNodeIds.has(n.id) || reorderHiddenEdgeNodeIds.has(n.parent_id)) {
            return false;
          }
        }
        return true;
      })
      .map((n) => {
        const edgeId = `e-${n.parent_id}-${n.id}`;
        return {
          id: edgeId,
          source: n.parent_id!,
          target: n.id,
          style: { stroke: '#a3a3af', strokeWidth: 1.5 },
          type: 'step',
          pathOptions: { borderRadius: 4, offset: 0 },
          ...(fadeInSet?.has(edgeId) ? { className: 'fta-edge--fade-in' } : {}),
        };
      });

    return { nodes: rfNodes, edges: rfEdges };
  }, [
    ftaNodes,
    collapsed,
    childrenMap,
    toggleCollapse,
    toggleDetailExpanded,
    detailExpandedIds,
    isEditMode,
    onTreeUpdate,
    addChild,
    editingNodeId,
    editingGateParentId,
    updateGate,
    updateNode,
    stagingNodeChoices,
    stagingChoicesDisabled,
    onStagingChoiceChange,
    expandPickMode,
    expandSelectedIds,
    onExpandPickToggle,
    readOnly,
    versionDiffByNodeId,
    flowOrientation,
    NODE_LAYOUT_PARAM_FINGERPRINT,
    siblingReorderInfo,
    reorderSibling,
    reorderHiddenEdgeNodeIds,
    reorderFadeInEdgeIds,
  ]);
  if (ftaNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-400">
        FTA を開始すると、ここにツリーが表示されます
      </div>
    );
  }

  return (
    <div
      ref={flowWrapperRef}
      className={`h-full w-full relative${reorderLayoutTransition ? ' fta-flow--node-position-transition' : ''}`}
    >
      <div className="pointer-events-auto absolute left-3.5 top-4 z-60 inline-flex gap-0.5 rounded-full border border-neutral-200/90 bg-white/95 p-0.5 shadow-sm">
        <button
          type="button"
          onClick={() => setFlowOrientationPersisted('Horizontal')}
          className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            flowOrientation === 'Horizontal'
              ? 'bg-[#1a1a2e] text-white hover:bg-[#252542]'
              : 'text-neutral-600 hover:bg-neutral-100'
          }`}
        >
          横向き
        </button>
        <button
          type="button"
          onClick={() => setFlowOrientationPersisted('Vertical')}
          className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            flowOrientation === 'Vertical'
              ? 'bg-[#1a1a2e] text-white hover:bg-[#252542]'
              : 'text-neutral-600 hover:bg-neutral-100'
          }`}
        >
          縦向き
        </button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.05}
        maxZoom={2}
        nodesDraggable={!isEditMode && !readOnly}
        nodesConnectable={false}
        elementsSelectable
      >
        <FTAFlowController
          ref={ref}
          flowWrapperRef={flowWrapperRef}
          flowOrientation={flowOrientation}
        />
        <Background gap={16} color="#e5e7eb" />
        <Controls />
      </ReactFlow>

      {deletingNodeId && (
        <DeleteConfirmModal
          onConfirm={() => confirmDelete(deletingNodeId)}
          onCancel={() => setDeletingNodeId(null)}
        />
      )}
    </div>
  );
});

export default FTAFlow;
