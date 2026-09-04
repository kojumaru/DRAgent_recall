const BASE = '/api';
const BASE_BMK = '/api/benchmark/cases';

export interface RecallListItem {
  id: string;
  notifier: string;
  vehicle: string;
  defect_location: string;
  notification_date?: string;
  has_diagram_pdf?: boolean;
  has_review: boolean;
  has_spec: boolean;
  has_label: boolean;
  has_input: boolean;
  has_fta: boolean;
  fta_count?: number;
  has_spec_review: boolean;
  spec_review_improved?: boolean;
  has_diagram_masked?: boolean;
  has_diagram_original?: boolean;
  has_top_event_review?: boolean;
  has_failure_mode_review?: boolean;
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

export async function downloadReviews(): Promise<void> {
  const res = await fetch(`${BASE}/export/reviews`);
  if (!res.ok) throw new Error('エクスポートに失敗しました');
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename=([^\s;]+)/);
  const filename = match ? match[1] : 'fta_reviews.zip';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function listRecalls(): Promise<RecallListItem[]> {
  const res = await fetch(`${BASE}/recalls`);
  return res.json();
}

export async function getRecall(id: string): Promise<RecallDetail> {
  const res = await fetch(`${BASE}/recalls/${id}`);
  return res.json();
}

export async function getFTA(id: string, index?: number): Promise<FTATree> {
  const url = index !== undefined && index > 0
    ? `${BASE}/recalls/${id}/fta?index=${index}`
    : `${BASE}/recalls/${id}/fta`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('fta not found');
  return res.json();
}

export async function listFTAIndices(id: string): Promise<number[]> {
  const res = await fetch(`${BASE}/recalls/${id}/fta/list`);
  if (!res.ok) return [];
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

// ---------------------------------------------------------------------------
// 仕様書レビュー
// ---------------------------------------------------------------------------

export interface SpecSectionReview {
  verdict: 'approved' | 'needs_fix' | 'skipped';
  comment: string;
  corrected_text?: string;
}

export interface SpecReview {
  reviewer: string;
  reviewed_at: string;
  verdict: 'approved' | 'needs_fix' | 'skipped';
  comment: string;
  section_reviews: Record<string, SpecSectionReview>;
  skill_improved_at?: string;
}

export interface SpecReviewSubmission {
  reviewer: string;
  verdict: 'approved' | 'needs_fix' | 'skipped';
  comment: string;
  section_reviews: Record<string, SpecSectionReview>;
}

export async function getSpecReview(id: string, base = `${BASE}/recalls`): Promise<SpecReview | null> {
  const res = await fetch(`${base}/${id}/spec_review`);
  if (!res.ok) return null;
  return res.json();
}

export async function saveSpecReview(id: string, body: SpecReviewSubmission, base = `${BASE}/recalls`): Promise<SpecReview> {
  const res = await fetch(`${base}/${id}/spec_review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? '保存に失敗しました');
  }
  return res.json();
}

export async function markSpecReviewImproved(id: string, base = `${BASE}/recalls`): Promise<SpecReview> {
  const res = await fetch(`${base}/${id}/spec_review/mark_improved`, { method: 'POST' });
  if (!res.ok) throw new Error('マーク失敗');
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

// ---------------------------------------------------------------------------
// 故障モードレビュー
// ---------------------------------------------------------------------------

export interface FailureModeReview {
  reviewer: string;
  reviewed_at: string;
  verdict: 'approved' | 'needs_fix';
  item_reviews: Record<string, 'approved' | 'needs_fix'>;
  item_suggested?: Record<string, string>;
  missing_items: string[];
  comment: string;
}

export interface FailureModeReviewSubmission {
  reviewer: string;
  verdict: 'approved' | 'needs_fix';
  item_reviews: Record<string, 'approved' | 'needs_fix'>;
  item_suggested?: Record<string, string>;
  missing_items: string[];
  comment: string;
}

export async function getFailureModeReview(id: string, base = `${BASE}/recalls`): Promise<FailureModeReview | null> {
  const res = await fetch(`${base}/${id}/failure_mode_review`);
  if (!res.ok) return null;
  return res.json();
}

export async function saveFailureModeReview(id: string, body: FailureModeReviewSubmission, base = `${BASE}/recalls`): Promise<FailureModeReview> {
  const res = await fetch(`${base}/${id}/failure_mode_review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) { const err = await res.json().catch(() => ({ detail: res.statusText })); throw new Error(err.detail ?? '保存に失敗しました'); }
  return res.json();
}

// ---------------------------------------------------------------------------
// トップ事象レビュー
// ---------------------------------------------------------------------------

export interface TopEventEventReview {
  top_event: string;
  verdict: 'approved' | 'needs_fix';
  suggested: string;
  comment: string;
}

export interface TopEventReview {
  reviewer: string;
  reviewed_at: string;
  event_reviews: TopEventEventReview[];
  missing_items?: string[];
  comment?: string;
}

export interface TopEventReviewSubmission {
  reviewer: string;
  event_reviews: TopEventEventReview[];
  missing_items: string[];
  comment: string;
}

export async function getTopEventReview(id: string, base = `${BASE}/recalls`): Promise<TopEventReview | null> {
  const res = await fetch(`${base}/${id}/top_event_review`);
  if (!res.ok) return null;
  return res.json();
}

export async function saveTopEventReview(id: string, body: TopEventReviewSubmission, base = `${BASE}/recalls`): Promise<TopEventReview> {
  const res = await fetch(`${base}/${id}/top_event_review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) { const err = await res.json().catch(() => ({ detail: res.statusText })); throw new Error(err.detail ?? '保存に失敗しました'); }
  return res.json();
}

export interface SkillImproveJob {
  job_id: string;
  status: 'running' | 'done' | 'error';
  output: string;
  started_at?: string;
  finished_at?: string;
}

export async function startSkillImprove(id: string, base = `${BASE}/recalls`): Promise<SkillImproveJob> {
  const res = await fetch(`${base}/${id}/skill_improve`, { method: 'POST' });
  if (!res.ok) throw new Error('skill-improve 起動失敗');
  return res.json();
}

export async function getSkillImproveStatus(id: string, base = `${BASE}/recalls`): Promise<SkillImproveJob | null> {
  const res = await fetch(`${base}/${id}/skill_improve`);
  if (!res.ok) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// ベンチマーク API（fta-agent/cases + sessions）
// ---------------------------------------------------------------------------

export async function listBenchmarkCases(): Promise<RecallListItem[]> {
  const res = await fetch(`${BASE_BMK}`);
  return res.json();
}

export async function getBenchmarkCase(id: string): Promise<RecallDetail> {
  const res = await fetch(`${BASE_BMK}/${id}`);
  return res.json();
}

export async function getBenchmarkFTA(id: string): Promise<FTATree> {
  const res = await fetch(`${BASE_BMK}/${id}/fta`);
  if (!res.ok) throw new Error('fta not found');
  return res.json();
}

export async function getBenchmarkPerItemScore(id: string): Promise<PerItemScore | null> {
  const res = await fetch(`${BASE_BMK}/${id}/per_item_score`);
  if (!res.ok) return null;
  return res.json();
}

export async function getBenchmarkExpertReviews(id: string): Promise<ExpertReview[]> {
  const res = await fetch(`${BASE_BMK}/${id}/expert_reviews`);
  if (!res.ok) return [];
  return res.json();
}

export async function saveBenchmarkExpertReview(id: string, body: ExpertReviewSubmission): Promise<ExpertReview> {
  const res = await fetch(`${BASE_BMK}/${id}/expert_reviews`, {
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
