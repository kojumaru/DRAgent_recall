const BASE = '/api';

export interface RecallListItem {
  id: string;
  notifier: string;
  vehicle: string;
  defect_location: string;
  has_review: boolean;
}


export interface ReviewResult {
  reviewer: string;
  reviewed_at: string;
  verdict: 'good' | 'needs_fix';
  comment: string;
  item_checks: Record<string, string>;
}

export interface ReviewSubmission {
  reviewer: string;
  verdict: 'good' | 'needs_fix';
  comment: string;
  item_checks: Record<string, string>;
}

export interface RecallDetail {
  raw?: {
    recall_id: string;
    date_text: string;
    diagram_pdf_url?: string;
    metadata: {
      notification_number: string;
      notifier: string;
      defect_system: string;
      defect_location: string;
      defect_description: string;
      root_cause: string;
      consequences: string[];
      correction_summary: string;
      affected_vehicles: { make: string; model: string; type_designation: string; affected_count: string }[];
    };
  };
  label?: {
    target_component: string[];
    failure_modes: string[];
    top_event: string[];
    causal_chain: string[];
  };
  spec?: string;
  score?: {
    component_match: number; // 1〜5
    failure_mode_match: number; // 1〜5
    top_event_match: number; // 1〜5
    overall: number; // 1〜5
    reasoning: Record<string, string>;
  };
}

export interface FTATree {
  tree_id: string;
  product_name: string;
  purpose: string;
  top_event: string;
  components: string[];
  functions: string[];
  nodes: FTANode[];
}

export interface FTANode {
  id: string;
  label: string;
  label_detail: string | null;
  parent_id: string | null;
  step: number;
  order_index: number;
  component: string | null;
  type: 'event' | 'gate';
  sub_type: string;
}

export async function listRecalls(): Promise<RecallListItem[]> {
  const res = await fetch(`${BASE}/recalls`);
  return res.json();
}

export async function getRecall(id: string): Promise<RecallDetail> {
  const res = await fetch(`${BASE}/recalls/${id}`);
  return res.json();
}

export async function getFTA(id: string): Promise<FTATree> {
  const res = await fetch(`${BASE}/recalls/${id}/fta`);
  return res.json();
}


/** 専門家レビュー結果を取得する。未レビューなら null。 */
export async function getReview(id: string): Promise<ReviewResult | null> {
  const res = await fetch(`${BASE}/recalls/${id}/review`);
  if (!res.ok) return null;
  return res.json();
}

/** 専門家レビュー結果を保存する。 */
export async function saveReview(id: string, body: ReviewSubmission): Promise<ReviewResult> {
  const res = await fetch(`${BASE}/recalls/${id}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? 'レビューの保存に失敗しました');
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// 項目別スコア（LLM per-item judge）
// ---------------------------------------------------------------------------

export interface PerItemScoreEntry {
  item: string;
  score: number; // 1〜5
}

export interface PerItemScore {
  recall_id: string;
  failure_modes: PerItemScoreEntry[];
  causal_chain: PerItemScoreEntry[];
}

/** LLM の項目別スコア（per_item_score.json）を取得する。未計算なら null。 */
export async function getPerItemScore(id: string): Promise<PerItemScore | null> {
  const res = await fetch(`${BASE}/recalls/${id}/per_item_score`);
  if (!res.ok) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// 専門家評価（5段階、複数人）
// ---------------------------------------------------------------------------

export interface ExpertReview {
  reviewer: string;
  reviewed_at: string;
  failure_modes: PerItemScoreEntry[];
}

export interface ExpertReviewSubmission {
  reviewer: string;
  failure_modes: PerItemScoreEntry[];
}

/** 全専門家のレビューリストを取得する。 */
export async function getExpertReviews(id: string): Promise<ExpertReview[]> {
  const res = await fetch(`${BASE}/recalls/${id}/expert_reviews`);
  if (!res.ok) return [];
  return res.json();
}

/** 専門家の5段階評価を保存する（同一レビュアー名なら上書き）。 */
export async function saveExpertReview(id: string, body: ExpertReviewSubmission): Promise<ExpertReview> {
  const res = await fetch(`${BASE}/recalls/${id}/expert_reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? '専門家レビューの保存に失敗しました');
  }
  return res.json();
}
