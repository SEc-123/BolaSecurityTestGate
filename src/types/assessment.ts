/** Public assessment contract. Never put execution plans, credentials or raw tool output here. */
export type TestStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped' | 'review' | 'not_run';
export type TestOutcome = 'pending' | 'clear' | 'issue' | 'inconclusive' | 'functional';
export interface BusinessTest {
  id: string;
  name: string;
  status: TestStatus;
  status_label: string;
  outcome: TestOutcome;
  checked: boolean;
  summary: string;
  issue_ids: string[];
  evidence_count: number;
  task_ids: string[];
}
export interface BusinessFunction {
  id: string;
  name: string;
  tests: BusinessTest[];
  status: TestStatus;
  checked: boolean;
}
export interface AssessmentIssue {
  id: string;
  title: string;
  feature_name: string;
  test_name: string;
  status: 'confirmed' | 'review';
  summary: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  evidence_count: number;
  test_id: string;
  created_at: string;
}
export interface AssessmentRun {
  id: string;
  name: string;
  target: string;
  surface: 'web' | 'android';
  status: string;
  status_label: string;
  created_at: string;
  updated_at: string;
}
export interface AssessmentFrame {
  id: string;
  image_url: string;
  captured_at: string;
  task_id: string | null;
  test_id: string | null;
  test_name: string;
  surface: 'web' | 'android';
  source: 'device' | 'browser' | 'simulated';
  state: 'live' | 'stale' | 'recorded' | 'reference';
}
export interface ProductAssessmentState {
  version: 2;
  run: AssessmentRun;
  active_surface: 'web' | 'android';
  totals: {
    business_functions: number; tests: number; completed: number; running: number;
    failed: number; blocked: number; skipped: number; review: number; not_run: number;
    pending: number; confirmed_risks: number; review_signals: number; progress: number;
  };
  business_functions: BusinessFunction[];
  current_work: Array<{ id: string; name: string; status: string; task_id: string | null }>;
  risk_evidence: AssessmentIssue[];
  review_evidence: AssessmentIssue[];
  live_surface: AssessmentFrame | null;
  frames: AssessmentFrame[];
  phase_label: string;
  notice: string;
}
