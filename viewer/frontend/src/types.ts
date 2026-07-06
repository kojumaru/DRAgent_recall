/* FTA ノードの種別 */
export type NodeType = 'top' | 'basic' | 'individual' | 'undeveloped';
export type GateType = 'OR' | 'AND';

interface FTANodeBase {
  id: string;
  label: string;
  label_detail: string | null;
  parent_id: string | null;
  step: number;
  /** 同一 parent 下の表示順（DB `order_index` と対応） */
  order_index: number;
  component: string | null;
}

/** 故障・事象ノード。 */
export interface FTAEventNode extends FTANodeBase {
  type: 'event';
  sub_type: NodeType;
}

/** 論理ゲートノード。DB / agent と同じく独立ノードとして扱う。 */
export interface FTAGateNode extends FTANodeBase {
  type: 'gate';
  sub_type: GateType;
  label_detail: null;
  component: null;
}

/** FTA ツリーの1ノード */
export type FTANode = FTAEventNode | FTAGateNode;

export function isFtaEventNode(n: FTANode): n is FTAEventNode {
  return n.type === 'event';
}

export function isFtaGateNode(n: FTANode): n is FTAGateNode {
  return n.type === 'gate';
}

/** 子を持たないイベントノード（ツリー上の葉）。AI 展開対象の選択に用いる。 */
export function isFtaLeafEventNode(nodes: FTANode[], nodeId: string): boolean {
  const n = nodes.find((x) => x.id === nodeId);
  if (!n || !isFtaEventNode(n)) return false;
  return !nodes.some((c) => c.parent_id === nodeId);
}

/** FTA ツリー全体 */
export interface FTATree {
  session_id: string;
  product_name: string;
  components: string[];
  functions: string[];
  purpose: string;
  top_event: string;
  nodes: FTANode[];
  tree_updated_at?: string; // GET/PUT で返る場合のみ
  pending_ai_generation_id?: string | null; // 未受理の AI ステージング行 id
  /** ワーキングのツリー構造が直近保存版と異なるとき true（GET/PUT 等で返る場合のみ） */
  can_save_user_version?: boolean;
}

/** PDF 用の製品入力スナップショット（InputForm と同期） */
export interface PdfProductSnapshot {
  product_name: string;
  purpose: string;
  top_event: string;
  components: string[];
  functions: string[];
}

/** FTA 生成開始リクエスト */
export interface StartFTARequest {
  product_name: string;
  components: string[];
  functions: string[];
  purpose: string;
  top_event: string;
  use_expert_review?: boolean;
  review_loops?: number;
}

/** GET /fta/trees の1行 */
export interface TreeListItem {
  id: string;
  name: string | null;
  updated_at: string;
}

/** FTA 生成開始レスポンス */
export interface StartFTAResponse {
  session_id: string;
  top_node_id: string;
}

/** トークン使用量とAPIコスト */
export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_jpy: number;
}

/** SSE ストリームの各チャンク */
export interface StepChunk {
  type: 'thinking' | 'tool_use' | 'node' | 'complete' | 'error' | 'cancelled';
  content: string | null;
  node: FTANode | null;
  step: number | null;
  tool_input: Record<string, unknown> | null;
  token_usage: TokenUsage | null;
  ai_generation_id?: string | null; // `complete` のみ
}

/** GET /fta/trees/:treeId/versions の1行 */
export interface FtaVersionListItem {
  id: string;
  parent_version_id: string | null;
  title: string;
  description: string | null;
  created_at: string;
}

export type VersionDiffKind = 'added' | 'removed' | 'changed';

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface VersionNodeDiffEntry {
  kind: VersionDiffKind;
  changed_fields: FieldChange[];
}

export interface FtaVersionDetailDiff {
  is_initial: boolean;
  nodes: Record<string, VersionNodeDiffEntry>;
  removed_nodes: Array<Record<string, unknown>>;
}

/** GET /fta/trees/:treeId/versions/:versionId（tree は正規化済み） */
export interface FtaVersionDetailPayload {
  id: string;
  tree_id: string;
  parent_version_id: string | null;
  title: string;
  description: string | null;
  created_at: string;
  tree: FTATree;
  diff: FtaVersionDetailDiff;
}

/** POST /fta/trees/:id/versions */
export interface CreateUserVersionResponse {
  version_id: string;
}

/** GET /fta/ai-generations/{id} */
export interface AIGenerationDetail {
  id: string;
  tree_id: string;
  applied: boolean | null;
  proposed_tree: Record<string, unknown>;
  node_list: Array<{ node: Record<string, unknown>; accepted: boolean | null }> | null;
  llm_metadata?: Record<string, unknown> | null;
}
