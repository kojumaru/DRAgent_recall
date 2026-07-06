import {
  computeNodeLayout,
  type NodeLayoutResult,
} from './layoutEngine';
import {
  NODE_W,
  NODE_H,
  LAYOUT_H_EDITING,
  NODE_COLORS,
} from './FTAFailureNode';
import { ftaNodeHasExpandableDetail, normalizeFtaNodeDisplay } from './ftaDisplayNormalize';
import type { FTAEventNode, FTAGateNode } from '../../types';
import { compareFtaSiblings } from '../../ftaSiblingOrder';
import {
  GATE_W,
  GATE_H,
  GATE_EDIT_W,
  GATE_EDIT_H,
} from './FTAGate';
import type { FtaFlowOrientation } from './ftaFlowOrientation';

export const FTA_TREE_H_GAP = 80;
export const FTA_TREE_V_GAP = 20;

type FtaVisualNode = {
  id: string;
  parent_id: string | null;
  isGate: false;
  data: FTAEventNode;
};

type GateVisualNode = {
  id: string;
  parent_id: string | null;
  isGate: true;
  data: FTAGateNode;
};

export type VisualNode = FtaVisualNode | GateVisualNode;

export function buildLayout(
  visualNodes: VisualNode[],
  collapsed: Set<string>,
  layoutExpandNodeId: string | null = null,
  detailExpandedIds: Set<string> = new Set(),
  orientation: FtaFlowOrientation = 'Horizontal',
): {
  positions: Map<string, { x: number; y: number }>;
  visibleIds: Set<string>;
  layouts: Map<string, NodeLayoutResult>;
} {
  const children = new Map<string, string[]>();
  for (const n of visualNodes) {
    if (!children.has(n.id)) children.set(n.id, []);
  }
  for (const n of visualNodes) {
    if (n.parent_id) {
      if (!children.has(n.parent_id)) children.set(n.parent_id, []);
      children.get(n.parent_id)!.push(n.id);
    }
  }

  const nodeMap = new Map(visualNodes.map((n) => [n.id, n]));
  for (const [, ids] of children) {
    ids.sort((ida, idb) => {
      const va = nodeMap.get(ida);
      const vb = nodeMap.get(idb);
      if (!va || !vb) return 0;
      return compareFtaSiblings(va.data, vb.data);
    });
  }

  const root = visualNodes.find(
    (n) => !n.parent_id || (!n.isGate && n.data.sub_type === 'top'),
  );
  if (!root) return { positions: new Map(), visibleIds: new Set(), layouts: new Map() };

  const visibleIds = new Set<string>();
  function collectVisible(id: string) {
    visibleIds.add(id);
    if (!collapsed.has(id)) {
      for (const child of children.get(id) ?? []) {
        collectVisible(child);
      }
    }
  }
  collectVisible(root.id);

  const layouts = new Map<string, NodeLayoutResult>();

  const depthById = new Map<string, number>();
  function assignDepthFromRoot(id: string, d: number) {
    depthById.set(id, d);
    if (collapsed.has(id)) return;
    for (const c of children.get(id) ?? []) {
      if (visibleIds.has(c)) assignDepthFromRoot(c, d + 1);
    }
  }
  assignDepthFromRoot(root.id, 0);

  function getNodeSize(node: VisualNode | undefined) {
    if (!node) return { w: NODE_W, h: NODE_H };
    if (node.isGate) {
      const expanded = layoutExpandNodeId === node.id;
      return expanded
        ? { w: GATE_EDIT_W, h: GATE_EDIT_H }
        : { w: GATE_W, h: GATE_H };
    }
    const expand =
      layoutExpandNodeId != null && !node.isGate && node.id === layoutExpandNodeId;
    const fd = node.data as FTAEventNode;

    if (expand) {
      return { w: NODE_W, h: LAYOUT_H_EDITING };
    }

    const detailOpen = detailExpandedIds.has(node.id) && ftaNodeHasExpandableDetail(fd);
    const display = normalizeFtaNodeDisplay({
      label: fd.label,
      label_detail: fd.label_detail,
      component: fd.component,
    });

    const colors = NODE_COLORS[fd.sub_type] ?? NODE_COLORS.individual;

    const layout = computeNodeLayout(
      fd.id,
      fd.sub_type,
      display.componentLine,
      display.titleLine,
      display.detailBody,
      detailOpen,
      display.hasExpandableDetail,
      { border: colors.border, text: '#1a1a2e', detail: '#525252' },
    );

    layouts.set(fd.id, layout);
    return { w: layout.width, h: layout.height };
  }

  const positions = new Map<string, { x: number; y: number }>();

  function forEachVisibleSubtreeNode(rootId: string, visit: (id: string) => void) {
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop()!;
      if (!visibleIds.has(id)) continue;
      visit(id);
      if (collapsed.has(id)) continue;
      for (const c of children.get(id) ?? []) stack.push(c);
    }
  }

  const gateDepths = new Set<number>();
  for (const id of visibleIds) {
    const n = nodeMap.get(id);
    if (n?.isGate) {
      const d = depthById.get(id);
      if (d !== undefined) gateDepths.add(d);
    }
  }
  const sortedGateDepths = [...gateDepths].sort((a, b) => a - b);

  if (orientation === 'Horizontal') {
    const subtreeHMemo = new Map<string, number>();
    function subtreeHeight(id: string): number {
      if (subtreeHMemo.has(id)) return subtreeHMemo.get(id)!;
      if (!visibleIds.has(id)) {
        subtreeHMemo.set(id, 0);
        return 0;
      }
      const node = nodeMap.get(id);
      const { h: nodeH } = getNodeSize(node);
      const kids = (children.get(id) ?? []).filter((k) => visibleIds.has(k));
      if (kids.length === 0 || collapsed.has(id)) {
        subtreeHMemo.set(id, nodeH);
        return nodeH;
      }
      let sum = 0;
      for (const k of kids) sum += subtreeHeight(k);
      const total = sum + FTA_TREE_V_GAP * (kids.length - 1);
      const h = Math.max(total, nodeH);
      subtreeHMemo.set(id, h);
      return h;
    }

    function place(id: string, centerY: number, x: number) {
      const node = nodeMap.get(id);
      const { w: nodeW, h: nodeH } = getNodeSize(node);
      positions.set(id, { x, y: centerY - nodeH / 2 });
      if (collapsed.has(id)) return;
      const kids = (children.get(id) ?? []).filter((k) => visibleIds.has(k));
      if (kids.length === 0) return;
      const heights = kids.map((kid) => subtreeHeight(kid));
      const total = heights.reduce((s, h) => s + h, 0) + FTA_TREE_V_GAP * (kids.length - 1);
      let cur = centerY - total / 2;
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i]!;
        const h = heights[i]!;
        const gap = node?.isGate ? GATE_W : FTA_TREE_H_GAP;
        place(kid, cur + h / 2, x + nodeW + gap);
        cur += h + FTA_TREE_V_GAP;
      }
    }
    place(root.id, 0, 0);

    for (const depth of sortedGateDepths) {
      const gatesAtDepth: string[] = [];
      for (const id of visibleIds) {
        const n = nodeMap.get(id);
        if (n?.isGate && depthById.get(id) === depth) gatesAtDepth.push(id);
      }
      if (gatesAtDepth.length === 0) continue;

      let targetEnd = Number.NEGATIVE_INFINITY;
      for (const gid of gatesAtDepth) {
        const n = nodeMap.get(gid);
        const pos = positions.get(gid);
        if (!n?.isGate || !pos) continue;
        const w = getNodeSize(n).w;
        targetEnd = Math.max(targetEnd, pos.x + w);
      }
      if (!Number.isFinite(targetEnd)) continue;

      for (const gid of gatesAtDepth) {
        const n = nodeMap.get(gid);
        const pos = positions.get(gid);
        if (!n?.isGate || !pos) continue;
        const w = getNodeSize(n).w;
        const delta = targetEnd - (pos.x + w);
        if (delta === 0) continue;
        forEachVisibleSubtreeNode(gid, (nid) => {
          const p = positions.get(nid);
          if (!p) return;
          positions.set(nid, { x: p.x + delta, y: p.y });
        });
      }
    }
  } else {
    const subtreeWMemo = new Map<string, number>();
    function subtreeWidth(id: string): number {
      if (subtreeWMemo.has(id)) return subtreeWMemo.get(id)!;
      if (!visibleIds.has(id)) {
        subtreeWMemo.set(id, 0);
        return 0;
      }
      const node = nodeMap.get(id);
      const { w: nodeW } = getNodeSize(node);
      const kids = (children.get(id) ?? []).filter((k) => visibleIds.has(k));
      if (kids.length === 0 || collapsed.has(id)) {
        subtreeWMemo.set(id, nodeW);
        return nodeW;
      }
      let sum = 0;
      for (const k of kids) sum += subtreeWidth(k);
      const total = sum + FTA_TREE_V_GAP * (kids.length - 1);
      const w = Math.max(total, nodeW);
      subtreeWMemo.set(id, w);
      return w;
    }

    function place(id: string, centerX: number, y: number) {
      const node = nodeMap.get(id);
      const { w: nodeW, h: nodeH } = getNodeSize(node);
      positions.set(id, { x: centerX - nodeW / 2, y });
      if (collapsed.has(id)) return;
      const kids = (children.get(id) ?? []).filter((k) => visibleIds.has(k));
      if (kids.length === 0) return;
      const widths = kids.map((kid) => subtreeWidth(kid));
      const total = widths.reduce((s, w) => s + w, 0) + FTA_TREE_V_GAP * (kids.length - 1);
      let cur = centerX - total / 2;
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i]!;
        const kw = widths[i]!;
        const gap = node?.isGate ? GATE_H : FTA_TREE_H_GAP;
        place(kid, cur + kw / 2, y + nodeH + gap);
        cur += kw + FTA_TREE_V_GAP;
      }
    }
    place(root.id, 0, 0);

    for (const depth of sortedGateDepths) {
      const gatesAtDepth: string[] = [];
      for (const id of visibleIds) {
        const n = nodeMap.get(id);
        if (n?.isGate && depthById.get(id) === depth) gatesAtDepth.push(id);
      }
      if (gatesAtDepth.length === 0) continue;

      let targetBottom = Number.NEGATIVE_INFINITY;
      for (const gid of gatesAtDepth) {
        const n = nodeMap.get(gid);
        const pos = positions.get(gid);
        if (!n?.isGate || !pos) continue;
        const h = getNodeSize(n).h;
        targetBottom = Math.max(targetBottom, pos.y + h);
      }
      if (!Number.isFinite(targetBottom)) continue;

      for (const gid of gatesAtDepth) {
        const n = nodeMap.get(gid);
        const pos = positions.get(gid);
        if (!n?.isGate || !pos) continue;
        const h = getNodeSize(n).h;
        const delta = targetBottom - (pos.y + h);
        if (delta === 0) continue;
        forEachVisibleSubtreeNode(gid, (nid) => {
          const p = positions.get(nid);
          if (!p) return;
          positions.set(nid, { x: p.x, y: p.y + delta });
        });
      }
    }
  }

  return { positions, visibleIds, layouts };
}
