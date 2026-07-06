const BASE = '/api';

export interface RecallListItem {
  id: string;
  notifier: string;
  vehicle: string;
  defect_location: string;
}

export interface RecallDetail {
  raw?: {
    recall_id: string;
    date_text: string;
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
