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
  normal_flows?: BusinessFlow[];
  experiments?: BusinessExperiment[];
}
export interface AssessmentReference { id: string; title: string; kind: 'evidence' | 'execution'; }
export interface BusinessFlow {
  id: string;
  /** Opaque immutable normal-objective reference when strict planning is enabled. */
  objective_id?: string;
  /** Value-free receipt proving the declared state-changing objective reached native validation. */
  objective_operation_receipt?: {
    operation_id: string; side_effect_class: string; source_event_ids: string[]; action_ids: string[];
    source_workflow_id: string; source_step_orders: number[]; normal_workflow_id: string; normal_run_id: string;
    validation_assertion_ids: string[]; validation_artifact_id: string; validated: true;
  };
  name: string;
  goal: string;
  role: string;
  status: 'not_run' | 'learning' | 'verified' | 'blocked' | 'failed' | 'review';
  status_label: string;
  summary: string;
  blockers: string[];
  steps: Array<{ id: string; name: string; status_label: string }>;
  checks: Array<{ name: string; passed: boolean | null }>;
  references: AssessmentReference[];
  task_ids: string[];
}
export interface BusinessExperiment {
  id: string;
  flow_id: string;
  name: string;
  hypothesis: string;
  status: TestStatus;
  status_label: string;
  summary: string;
  blockers: string[];
  references: AssessmentReference[];
  task_ids: string[];
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
  operation_id?: string;
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
export interface AssessmentOperation {
  id: string;
  title: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  status_label: string;
  summary: string;
  started_at: string;
  updated_at: string;
  task_id: string | null;
}
export interface ProductAssessmentState {
  operations?: AssessmentOperation[];
  version: 2;
  browser_transport?: 'novnc' | 'frames';
  diagnostics?: Array<{task_id?:string;message:string}>;
  run: AssessmentRun;
  active_surface: 'web' | 'android';
  totals: {
    business_functions: number; tests: number; completed: number; running: number;
    failed: number; blocked: number; skipped: number; review: number; not_run: number;
    pending: number; confirmed_risks: number; review_signals: number; progress: number;
    normal_flows?: number; verified_flows?: number; learning_flows?: number; blocked_flows?: number; experiments?: number;
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

export interface AssessmentEvidence {
  test: Pick<BusinessTest,'id'|'name'|'status'|'status_label'|'summary'>;
  decisions: Array<{id:string;verdict:string;reason:string}>;
  items: Array<{id:string;title:string;method:string;url:string;
    baseline?:{status?:number;body:string;body_present?:boolean;body_bytes?:number;hash?:string};
    result:{status?:number;body:string;body_present?:boolean;body_bytes?:number;hash?:string};
    followup?:{url:string;status?:number;body:string;body_present?:boolean;body_bytes?:number;hash?:string};
    proof:string[];notes:string[]}>;
  steps?: Array<{id:string;title:string;status:string;started_at:string;completed_at:string;
    integrity_verified:boolean;ui_verified:boolean;network_verified:boolean;
    checks:Array<{name:string;passed:boolean}>;notes:string[];
    hashes:Array<{name:string;sha256:string}>}>;
  notice:string;
}
