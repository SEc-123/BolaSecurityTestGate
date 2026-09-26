import { createHash, randomUUID } from 'node:crypto';
import { resolveTaskEndpointPlan } from './task-endpoint-plan.js';
import type { DbProvider } from '../../types/index.js';
import { dbRun } from '../../db/sql-helpers.js';
import type { AIScanRepository } from './repository.js';
import type { AIDiscoveredEndpoint, AIScanTask } from './types.js';
import { judgeUploadAttempts, type UploadAttemptEvidence } from './ai-judge.js';
import { normalizeOutputLanguage } from '../i18n/language.js';
import { assertUrlInTargetScope, fetchInTargetScope } from './target-scope.js';
import { CaptureRequiredError, replayHeaders } from './captured-request.js';
import { identityHeaders } from './identity-material.js';
import { verifyUploadedXss } from './browser/xss-verifier.js';
type Payload = {
    label: string;
    filename: string;
    content_type: string;
    body: Uint8Array;
    marker?: string;
};
type UploadContract = {
    url: string;
    method: string;
    headers: Record<string, string>;
    field: string;
    values: Array<[
        string,
        string
    ]>;
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const preview = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, ' ').slice(0, 8000);
function payloads(): Payload[] {
    const marker = `BSTG_${randomUUID().replace(/-/g, '')}`;
    const text = (label: string, filename: string, content_type: string, body: string): Payload => ({ label, filename, content_type, body: Buffer.from(body), marker });
    return [
        { label: 'normal', filename: `${marker}.png`, content_type: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64') },
        text('svg_xss', `${marker}.svg`, 'image/svg+xml', `<svg xmlns="http://www.w3.org/2000/svg" onload="alert('${marker}')"><text>${marker}</text></svg>`),
        text('html_xss', `${marker}.html`, 'text/html', `<!doctype html><script>alert('${marker}')</script>`),
        text('double_extension', `${marker}.png.php`, 'image/png', `<?php echo "${marker}"; ?>`),
        text('mime_bypass', `${marker}.php`, 'image/png', `<?php echo "${marker}"; ?>`),
    ];
}
/** Use an observed form or multipart capture. An endpoint name is not an upload schema. */
async function uploadContract(db: DbProvider, repo: AIScanRepository, task: AIScanTask, endpoint: AIDiscoveredEndpoint): Promise<UploadContract> {
    const captured = await repo.getCapturedRequest(task.scan_run_id, endpoint.id) || endpoint.captured_request;
    let values: Array<[
        string,
        string
    ]> = [], files: string[] = [];
    const headers = replayHeaders(captured?.headers || {});
    if (captured?.body && /multipart\/form-data/i.test(headers['content-type'] || '')) {
        try {
            const form = await new Response(captured.body, { headers: { 'content-type': headers['content-type'] } }).formData();
            for (const [name, value] of form.entries())
                if (typeof value === 'string')
                    values.push([name, value]);
                else
                    files.push(name);
        }
        catch { /* A complete observed HTML form can still supply the contract. */ }
    }
    if (!files.length) {
        const artifacts = (await repo.listArtifacts(task.scan_run_id)).filter(a => a.artifact_type === 'browser_form' && a.source_ref === endpoint.id && (!a.content_json.identity_role || a.content_json.identity_role === 'attacker'));
        const form = artifacts.sort((a, b) => Number(b.content_json.rendered === true) - Number(a.content_json.rendered === true) || b.created_at.localeCompare(a.created_at))[0]?.content_json?.form;
        if (form?.inputs) {
            files = form.inputs.filter((i: any) => i.name && i.type === 'file' && !i.disabled).map((i: any) => String(i.name));
            values = form.inputs.filter((i: any) => i.name && i.type !== 'file' && !i.disabled && !['submit', 'button', 'reset', 'password'].includes(i.type) && (!['checkbox', 'radio'].includes(i.type) || i.checked === true)).map((i: any) => [String(i.name), String(i.value ?? '')]);
        }
    }
    // This prerequisite is checked before upload plans, requests or transport.
    if (files.length !== 1)
        throw new CaptureRequiredError('upload_request_not_observed');
    const accounts = await db.repos.accounts.findAll();
    const account = accounts.find(a => a.tags?.includes(`scan:${task.scan_run_id}`) && a.tags?.includes('role:attacker'));
    const supplied = identityHeaders(account?.fields || {});
    if (Object.keys(supplied).length && !headers.authorization && !headers.cookie)
        Object.assign(headers, supplied);
    if (endpoint.auth_required && !headers.authorization && !headers.cookie)
        throw new Error('上传接口需要已登录的实际会话。');
    delete headers['content-type'];
    delete headers['content-length'];
    const method = String(captured?.method || endpoint.method).toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method))
        throw new Error('已观察的上传请求不是 POST、PUT 或 PATCH。');
    return { url: captured?.url || endpoint.url!, method, headers, field: files[0], values };
}
function uploadedLocation(base: string, headers: Record<string, string>, body: string): string | undefined {
    let value = headers.location;
    if (!value) {
        try {
            const visit = (node: any, depth: number): string | undefined => {
                if (depth > 4 || !node || typeof node !== 'object')
                    return;
                for (const key of ['url', 'file_url', 'avatar_url', 'path', 'location', 'href', 'src'])
                    if (typeof node[key] === 'string')
                        return node[key];
                for (const child of Object.values(node)) {
                    const result = visit(child, depth + 1);
                    if (result)
                        return result;
                }
            };
            value = visit(JSON.parse(body), 0) || '';
        }
        catch { }
    }
    if (!value)
        return;
    try {
        return new URL(value, base).href;
    }
    catch {
        return;
    }
}
async function upload(repo: AIScanRepository, task: AIScanTask, endpoint: AIDiscoveredEndpoint, contract: UploadContract, payload: Payload, scope: string): Promise<UploadAttemptEvidence> {
    assertUrlInTargetScope(contract.url, scope);
    const form = new FormData();
    for (const [name, value] of contract.values)
        form.append(name, value);
    form.append(contract.field, new Blob([payload.body], { type: payload.content_type }), payload.filename);
    // Request supplies the actual boundary. Save exactly the same bytes sent by fetch.
    const compiled = new Request(contract.url, { method: contract.method, headers: contract.headers, body: form });
    const bytes = new Uint8Array(await compiled.arrayBuffer()), headers = Object.fromEntries(compiled.headers);
    const record = await repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: 'upload_request', source_ref: endpoint.id,
        title: `Upload request: ${payload.label}`, content_json: { method: contract.method, url: contract.url, headers, body_base64: Buffer.from(bytes).toString('base64'), body_sha256: hash(bytes), field_name: contract.field, filename: payload.filename } });
    const attempt: UploadAttemptEvidence = { label: payload.label, filename: payload.filename, content_type: payload.content_type, accepted: false, request_artifact_id: record.id };
    try {
        const response = await fetchInTargetScope(contract.url, { method: contract.method, headers, body: bytes, signal: AbortSignal.timeout(30000) }, scope, { traffic_class: 'upload', follow_redirects: false });
        const text = await response.text();
        attempt.status = response.status;
        attempt.response_headers = Object.fromEntries(response.headers);
        attempt.response_body_preview = preview(text);
        attempt.response_body_sha256 = hash(Buffer.from(text));
        attempt.accepted = response.status >= 200 && response.status < 400 && !/invalid|forbidden|denied|not allowed|unsupported|error|failed|reject/i.test(text.slice(0, 1000));
        attempt.location = uploadedLocation(contract.url, attempt.response_headers, text);
        if (attempt.accepted && attempt.location) {
            assertUrlInTargetScope(attempt.location, scope);
            const readHeaders = { ...contract.headers };
            delete readHeaders.origin;
            delete readHeaders.referer;
            const fetched = await fetchInTargetScope(attempt.location, { method: 'GET', headers: readHeaders, signal: AbortSignal.timeout(30000) }, scope, { traffic_class: 'read' });
            const content = new Uint8Array(await fetched.arrayBuffer()), text = new TextDecoder().decode(content);
            attempt.fetch_status = fetched.status;
            attempt.fetched_content_type = fetched.headers.get('content-type') || '';
            attempt.fetched_body_preview = preview(text);
            attempt.fetched_body_sha256 = hash(content);
            attempt.uploaded_bytes_verified = fetched.ok && hash(content) === hash(payload.body);
            if (fetched.ok && payload.marker && ['double_extension', 'mime_bypass'].includes(payload.label) && text.trim() === payload.marker) {
                attempt.impact_verified = true;
                attempt.impact_proof = { kind: 'server_side_marker_execution', marker: payload.marker };
            }
            else if (fetched.ok && payload.marker && ['svg_xss', 'html_xss'].includes(payload.label) && attempt.uploaded_bytes_verified) {
                const proof = await verifyUploadedXss({ method: 'GET', url: attempt.location, headers: readHeaders }, payload.marker);
                attempt.impact_verified = proof.verified;
                const {screenshot_base64,...details}=proof;
                attempt.impact_proof = details;
                if(screenshot_base64){
                    const frame=await repo.createArtifact({scan_run_id:task.scan_run_id,task_id:task.id,artifact_type:'browser_execution_proof',source_ref:endpoint.id,
                        title:'Uploaded script execution in target browser',content_text:screenshot_base64,
                        content_json:{...details,surface:'web',observing:false,observed_at:new Date().toISOString()}});
                    attempt.impact_proof.artifact_id=frame.id;
                }
            }
        }
    }
    catch (error) {
        attempt.error = error instanceof Error ? error.message : String(error);
    }
    return attempt;
}
export async function runFileUploadTask(input: {
    db: DbProvider;
    repo: AIScanRepository;
    task: AIScanTask;
    endpoint: AIDiscoveredEndpoint;
}): Promise<Record<string, any>> {
    const { db, repo } = input;
    const { task, endpoint, run } = await resolveTaskEndpointPlan({ repo,
        scanRunId: input.task.scan_run_id, taskId: input.task.id, endpointId: input.endpoint.id, vulnType: 'file_upload' });
    const contract = await uploadContract(db, repo, task, endpoint), attempts: UploadAttemptEvidence[] = [], evidenceIds: string[] = [];
    const plan = await repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: 'upload_execution_plan', source_ref: endpoint.id, title: 'Observed multipart upload plan',
        content_json: { endpoint_id: endpoint.id, method: contract.method, url: contract.url, file_field: contract.field, field_names: contract.values.map(v => v[0]), execution_kind: 'multipart', strategy: 'normal_upload_then_mutations_then_impact_verification' } });
    await repo.updateTask(task.id, { phase: 'upload_baseline', created_assets_json: { upload_plan_artifact_id: plan.id } });
    for (const payload of payloads()) {
        const attempt = await upload(repo, task, endpoint, contract, payload, run.base_url);
        attempts.push(attempt);
        const artifact = await repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: attempt.error ? 'upload_attempt_error' : 'upload_attempt', source_ref: endpoint.id, title: `${payload.label}: ${payload.filename}`, content_json: attempt });
        evidenceIds.push(artifact.id);
        // Mutations have no usable comparison if the normal file cannot be uploaded and read.
        if (payload.label === 'normal' && (!attempt.accepted || !attempt.uploaded_bytes_verified))
            break;
    }
    if (attempts.length > 1 && attempts.slice(1).every(a => !a.error && !a.accepted && [400, 413, 415, 422].includes(a.status || 0))) {
        const normal = payloads()[0];
        normal.label = 'normal_control';
        const control = await upload(repo, task, endpoint, contract, normal, run.base_url);
        attempts.push(control);
        const artifact = await repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: 'upload_attempt', source_ref: endpoint.id, title: 'Normal upload after rejected variants', content_json: control });
        evidenceIds.push(artifact.id);
    }
    const judge = await judgeUploadAttempts(db, endpoint.path, attempts, normalizeOutputLanguage(run.language));
    const baseline = attempts[0], mutations = attempts.filter(a => !['normal', 'normal_control'].includes(a.label));
    const missing: string[] = [];
    if (!baseline?.accepted || !baseline.uploaded_bytes_verified)
        missing.push('normal_upload_and_readback_not_verified');
    if (!mutations.length || mutations.some(a => a.error || !a.status))
        missing.push('mutation_requests_incomplete');
    if (judge.verdict === 'vulnerable' && !mutations.some(a => a.impact_verified))
        missing.push('upload_impact_not_verified');
    const gate = { execution_kind: 'multipart', baseline_verified: !!baseline?.uploaded_bytes_verified, mutation_executed: mutations.length > 0 && !mutations.some(a => a.error || !a.status),
        evidence_artifact_ids: evidenceIds, missing_evidence: missing, verdict: missing.length ? 'inconclusive' : judge.verdict === 'vulnerable' ? 'confirmed' : 'inconclusive' };
    await repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: 'ai_judgement', source_ref: endpoint.id, title: judge.title, content_json: { ...judge, upload_evidence_gate: gate } });
    let findingId: string | undefined;
    if (judge.verdict === 'vulnerable' && gate.verdict === 'confirmed') {
        findingId = randomUUID();
        const strongest = mutations.find(a => a.impact_verified)!, provenance = await repo.resolveFindingProvenance(task, endpoint.id);
        await dbRun(db, `INSERT INTO findings (id,source_type,ai_scan_run_id,ai_scan_task_id,ai_campaign_task_id,ai_candidate_id,ai_feature_id,ai_endpoint_id,severity,status,title,description,template_name,request_raw,response_status,response_headers,response_body,request_evidence,response_evidence,ai_analysis,notes,discovered_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`, [findingId, 'ai_scan', provenance.ai_scan_run_id, provenance.ai_scan_task_id, provenance.ai_campaign_task_id || null, provenance.ai_candidate_id || null, provenance.ai_feature_id || null, provenance.ai_endpoint_id || null,
            judge.severity, 'new', judge.title, judge.reason, task.title, `${contract.method} ${contract.url}; request_artifact=${strongest.request_artifact_id}`, strongest.status || null, JSON.stringify(strongest.response_headers || {}), strongest.response_body_preview || '',
            JSON.stringify({ endpoint_id: endpoint.id, plan_artifact_id: plan.id, request_artifact_ids: attempts.map(a => a.request_artifact_id) }), JSON.stringify({ attempts, upload_evidence_gate: gate }), JSON.stringify(judge), `Assessment ${task.scan_run_id}`, new Date().toISOString()]);
        await repo.recordFindingProvenance(findingId, provenance);
    }
    await repo.updateTask(task.id, { phase: 'upload_evidence_evaluated', created_assets_json: { upload_plan_artifact_id: plan.id, evidence_artifact_ids: evidenceIds } });
    return { endpoint, field_name: contract.field, assets: { upload_plan_artifact_id: plan.id }, attempts, judge, upload_evidence_gate: gate, finding_id: findingId };
}
