import { createHash } from 'node:crypto';

const binary = /(?:^|_)(?:screenshot|image|body|content)_base64$|^base64$/i;
// These are the containers emitted by the browser, generic/upload runners and
// native execution tools. Their verdicts and preconditions must survive before
// large request bodies, generated assets or network history consume the budget.
const outcomes = new Set(['ok', 'success', 'status', 'error', 'error_message', 'error_code',
  'match_count', 'verdict', 'confidence', 'reason', 'summary', 'message', 'source', 'model',
  'has_execution_error', 'context_key', 'context_scope', 'identity_key', 'current_url',
  'method', 'url', 'path', 'tag', 'name', 'role', 'label', 'text', 'placeholder', 'type']);
const judgements = new Set(['judge', 'judgement', 'native_evidence_gate', 'upload_evidence_gate',
  'missing_preconditions', 'missing_evidence', 'evidence_summary', 'workflow_preconditions']);
const execution = new Set(['native_bstg', 'observation', 'dom_summary', 'template_run',
  'baseline_workflow_run', 'mutation_workflow_run', 'baseline_run', 'mutation_run', 'api_mode',
  'preconditions', 'controls', 'forms', 'inputs']);
const bulk = new Set(['body', 'response_body', 'raw_request', 'raw_response', 'html',
  'visible_text', 'steps', 'variables', 'mappings', 'extractors', 'network_events']);

function priority(key: string): number {
  if (outcomes.has(key) || key === 'id' || key === 'source_ref' || /_id$/.test(key)) return 0;
  if (judgements.has(key)) return 1;
  if (execution.has(key)) return 2;
  if (binary.test(key) || bulk.has(key)) return 5;
  return 3;
}

function pick(value: any, keys: string[]): Record<string, any> {
  return Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
}
const outcomeFields = ['success', 'ok', 'status', 'test_run_id', 'has_execution_error', 'error',
  'error_message', 'missing_preconditions', 'summary'];
const responseFields = ['ok', 'method', 'url', 'status', 'error', 'body_hash', 'body_sha256',
  'request_id', 'response_id', 'request_artifact_id', 'response_artifact_id', 'identity_key', 'content_type', 'final_url'];
function nativeSummary(native: any): any {
  if (!native) return native;
  const result: Record<string, any> = pick(native, ['native_counts', 'missing_preconditions']);
  result.assets = pick(native.assets, ['environment_id', 'account_ids', 'attacker_account_id', 'victim_account_id', 'admin_account_id',
    'template_test_run_id', 'baseline_workflow_test_run_id', 'mutation_workflow_test_run_id',
    'api_mode_baseline_test_run_id', 'api_mode_mutation_test_run_id']);
  for (const key of ['template_run', 'baseline_workflow_run', 'mutation_workflow_run']) {
    if (native[key]) result[key] = pick(native[key], outcomeFields);
  }
  if (native.api_mode) result.api_mode = {
    ...pick(native.api_mode, ['baseline_test_run_id', 'mutation_test_run_id']),
    baseline_run: pick(native.api_mode.baseline_run, outcomeFields),
    mutation_run: pick(native.api_mode.mutation_run, outcomeFields),
  };
  if (native.advanced_mutation) {
    result.advanced_mutation = {};
    for (const key of ['plan', 'profile']) if (native.advanced_mutation[key]) {
      const item = native.advanced_mutation[key];
      result.advanced_mutation[key] = {
        ...pick(item, ['strategy', 'dimensions']),
        workflow_dependency_plan: pick(item.workflow_dependency_plan,
          ['target_endpoint_id', 'access_phase', 'target_kind', 'required_capabilities', 'missing_preconditions', 'schedule']),
      };
    }
  }
  return result;
}

/** Typed runner projection: verdicts, execution failures, scope/identity bindings
 * and proof flags are never traded for a response preview or generated assets.
 * Normal responses are referenced only when exactly equal to the baseline. */
function runnerSummary(value: any): any | undefined {
  if (!value?.judge || !Array.isArray(value.attempts)) return undefined;
  const result: Record<string, any> = pick(value, ['vuln_type', 'field_name', 'judge', 'finding_id',
    'native_evidence_gate', 'upload_evidence_gate']);
  result.endpoint = pick(value.endpoint, ['id', 'method', 'path', 'url', 'auth_required']);
  result.assets = pick(value.assets, ['template_id', 'workflow_id', 'security_rule_id', 'upload_plan_artifact_id']);
  if (value.native_bstg) result.native_bstg = nativeSummary(value.native_bstg);
  if (value.baseline) result.baseline = pick(value.baseline, responseFields);
  result.attempts = value.attempts.map((attempt: any, index: number) => ({
    index,
    ...pick(attempt, ['label', 'target', 'payload', 'filename', 'content_type', 'accepted', 'status',
      'request_artifact_id', 'response_body_sha256', 'fetch_status', 'fetched_content_type', 'fetched_body_sha256',
      'uploaded_bytes_verified', 'impact_verified', 'impact_proof', 'error', 'comparison',
      'authorization_boundary_verified', 'authorization_proof', 'browser_execution_verified', 'browser_execution_proof']),
    ...(attempt.normal ? {normal: value.baseline && JSON.stringify(attempt.normal) === JSON.stringify(value.baseline)
      ? {same_as: 'baseline'} : pick(attempt.normal, responseFields)} : {}),
    ...(attempt.mutated ? {mutated: pick(attempt.mutated, responseFields)} : {}),
  }));
  return result;
}

/** Only a model-facing projection. The original invocation/artifact remains intact.
 * Keep outcomes and record references before bulky HTML, images or nested assets. */
export function compactModelEvidence(value: any, maxCharacters = 4000): any {
  const encoded = JSON.stringify(value) ?? 'null';
  const marker = { truncated: true, original_characters: encoded.length,
    sha256: createHash('sha256').update(encoded).digest('hex') };
  if (typeof value === 'string') {
    if (encoded.length <= maxCharacters) return value;
    // JSON escaping can expand a character sixfold. Bound the serialized form.
    return value.slice(0, Math.max(0, Math.floor((maxCharacters - 160) / 6))) +
      ` [truncated; original ${encoded.length} JSON characters; sha256 ${marker.sha256}]`;
  }
  if (value === null || typeof value !== 'object') return value;
  const containsBinary = !Array.isArray(value) && Object.keys(value).some(key => binary.test(key));
  if (encoded.length <= maxCharacters && !containsBinary) return value;
  const runner = runnerSummary(value);
  if (runner) {
    const projected = {...runner, _model_context: {...marker, projection: 'runner_evidence',
      omitted: ['response bodies/previews/headers', 'generated asset definitions'],
      evidence_location: 'originating persisted invocation or artifact'}};
    if (JSON.stringify(projected).length > maxCharacters) {
      // Failing explicitly is safer than losing a missing prerequisite or an
      // unverified impact flag and allowing the planner to infer success.
      throw new Error('Required runner evidence exceeds the model context budget; original evidence is retained.');
    }
    return projected;
  }
  if (maxCharacters < 256) return { _model_context: marker };
  if (Array.isArray(value)) {
    // Reserve enough space for useful structured items. Eight tiny markers
    // would erase DOM selectors and HTTP identity/status from every sample.
    const count = Math.min(8, Math.max(1, Math.floor((maxCharacters - 220) / 512)));
    const head = Math.ceil(count / 2), tail = Math.floor(count / 2);
    const indexes = value.length <= count ? value.map((_:unknown,i:number)=>i)
      : [...Array.from({length:head},(_,i)=>i), ...Array.from({length:tail},(_,i)=>value.length-tail+i)];
    const itemBudget = Math.floor((maxCharacters - 200) / Math.max(1,indexes.length));
    const out = indexes.map(i=>compactModelEvidence(value[i],itemBudget));
    out.push({ _model_context: { ...marker, omitted_items: value.length-indexes.length } });
    return JSON.stringify(out).length <= maxCharacters ? out : [{ _model_context: marker }];
  }
  const out:Record<string,any> = {};
  const keys = Object.keys(value).sort((a,b)=>priority(a)-priority(b));
  let omitted=0;
  for (const [index, key] of keys.entries()) {
    const remaining = maxCharacters - JSON.stringify(out).length - 220 - JSON.stringify(key).length;
    if (remaining < 256) { omitted++; continue; }
    const pendingImportant = keys.slice(index + 1).filter(k => priority(k) <= 2).length;
    const reserved = Math.min(remaining - 256, pendingImportant * 256);
    const budget = Math.min(remaining - reserved, priority(key) <= 2 ? 2400 : 1200);
    out[key] = binary.test(key) ? '[Binary evidence retained in the originating record]' : compactModelEvidence(value[key],budget);
    if (JSON.stringify(out).length > maxCharacters-200) { delete out[key]; omitted++; }
  }
  out._model_context = { ...marker, omitted_fields: omitted };
  return JSON.stringify(out).length <= maxCharacters ? out : { _model_context: marker };
}
