export type SourceKind = 'liveness' | 'feed' | 'openapi' | 'html';
export type PlanStatus = 'generating' | 'active' | 'paused' | 'stale' | 'failed';
export type RunTrigger = 'baseline' | 'scheduled' | 'manual';
export type FindingKind = 'vendor_dead' | 'breaking' | 'deprecation' | 'auth_change' | 'new_feature' | 'other';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type FindingStatus = 'new' | 'filed' | 'dismissed';
export type Importance = 'high' | 'medium' | 'low';
/** An importance filter value: a tier, or `unrated` for pieces with no usage data yet. */
export type ImportanceFilter = Importance | 'unrated';

export const FINDING_KINDS: readonly FindingKind[] = ['vendor_dead', 'breaking', 'deprecation', 'auth_change', 'new_feature', 'other'];
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
export const IMPORTANCE_FILTERS: readonly ImportanceFilter[] = ['high', 'medium', 'low', 'unrated'];

/** One API call a piece makes. SDK-based pieces use method 'SDK' and path 'sdk:<package>#<method>'. */
export interface EndpointRef {
  target: string;
  target_kind: 'action' | 'trigger';
  method: string;
  path: string;
  note?: string;
}

/** A finding as produced by a differ or the classifier, before it is stored. */
export interface FindingDraft {
  kind: FindingKind;
  severity: Severity;
  /** Inventory target names, or ['*'] for the whole piece. Empty = touches nothing the piece uses. */
  affected_targets: string[];
  /** YYYY-MM-DD */
  effective_date: string | null;
  title: string;
  summary: string;
  suggested_action: string;
  evidence_url: string;
  evidence_excerpt: string;
  evidence_verified: boolean;
  is_baseline: boolean;
  signature: string;
}

/** What probe_source reports for one candidate URL. */
export interface ProbeResult {
  url: string;
  ok: boolean;
  status: number | null;
  final_url: string;
  content_type: string;
  detected_kind: 'feed' | 'openapi' | 'html' | 'unreadable';
  text_chars: number;
  sample: string;
  problem: string;
}
