import type { FTANode } from './types';

/** 兄弟間の表示・永続化で共通のソート（order_index のみで順序付け、同値は id で安定化） */
export function compareFtaSiblings(
  a: Pick<FTANode, 'order_index' | 'id'>,
  b: Pick<FTANode, 'order_index' | 'id'>,
): number {
  if (a.order_index !== b.order_index) return a.order_index - b.order_index;
  return a.id.localeCompare(b.id);
}

/** 同一親の兄弟のうち `nodeId` を隣と入れ替え、`order_index` を 0..n-1 に振り直す */
export function reorderFtaSiblingNodes(
  nodes: FTANode[],
  nodeId: string,
  delta: -1 | 1,
): { nodes: FTANode[]; swappedPair: [string, string] | null } {
  const target = nodes.find((n) => n.id === nodeId);
  if (!target) return { nodes, swappedPair: null };
  const parentId = target.parent_id;
  const siblings = nodes.filter((n) => n.parent_id === parentId).sort(compareFtaSiblings);
  const idx = siblings.findIndex((n) => n.id === nodeId);
  const j = idx + delta;
  if (idx < 0 || j < 0 || j >= siblings.length) return { nodes, swappedPair: null };

  const neighborId = siblings[j]!.id;
  const reordered = [...siblings];
  const tmp = reordered[idx];
  reordered[idx] = reordered[j]!;
  reordered[j] = tmp!;

  const orderMap = new Map(reordered.map((n, i) => [n.id, i]));
  const next = nodes.map((n) =>
    orderMap.has(n.id) ? { ...n, order_index: orderMap.get(n.id)! } : n,
  );
  return { nodes: next, swappedPair: [nodeId, neighborId] };
}
