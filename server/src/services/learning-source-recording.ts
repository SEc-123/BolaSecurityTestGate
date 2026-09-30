import { LearningEngine, type StepSnapshot } from './learning-engine.js';
import { classifyField, inferWritePolicy, suggestVariableName } from './learning-field-classifier.js';
import { conflictWithExistingSessionJar, detectSessionJarSuggestion } from './learning-session-jar-detector.js';
import type { LearningSuggestionPayload } from './learning-v2-types.js';

function safeJson(v: any, def: any) {
  if (v == null) return def;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return def; }
  }
  return v;
}

function parsePathAndQuery(url: string) {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `http://placeholder${url}`);
    const query: Record<string,string> = {};
    parsed.searchParams.forEach((value, key) => { query[key] = value; });
    return { path: parsed.pathname, query };
  } catch {
    return { path: url, query: {} };
  }
}

function mapRecordingEventsToWorkflowSteps(steps: any[], workflowDraftSteps: any[], events: any[], templates: any[] = []): Array<{ stepOrder: number; event: any; step: any }> {
  const orderedSteps = [...steps].sort((a,b)=>a.step_order-b.step_order);
  const byTemplate = new Map<string, any[]>();
  for (const d of workflowDraftSteps || []) {
    const key = String(d.template_id || '');
    if (!byTemplate.has(key)) byTemplate.set(key, []);
    byTemplate.get(key)!.push(d);
  }
  const eventById = new Map((events || []).map((e:any)=>[e.id,e]));
  const templateById = new Map(templates.map(template=>[template.id,template]));
  const draftById = new Map(workflowDraftSteps.map(draft=>[draft.id,draft]));
  const matches: Array<{ stepOrder:number; event:any; step:any }> = [];
  for (let i=0;i<orderedSteps.length;i++) {
    const step = orderedSteps[i];
    const draftStepCandidates = byTemplate.get(String(step.api_template_id)) || [];
    const sourceId = safeJson(templateById.get(step.api_template_id)?.advanced_config,{}).source_workflow_draft_step_id;
    const draftStep = sourceId ? draftById.get(sourceId) : draftStepCandidates.sort((a:any,b:any)=>(a.sequence||0)-(b.sequence||0))[0];
    const fallbackEvent = events[i];
    // Explicit provenance must never fall back to another event when missing.
    const event = draftStep ? eventById.get(draftStep.source_event_id) : sourceId ? undefined : fallbackEvent;
    if (event) matches.push({ stepOrder: step.step_order, event, step });
  }
  return matches;
}

export async function buildRecordingLearningSuggestions(db: any, workflowId: string, recordingSessionId: string, options?: { includeExtractors?: boolean; includeSessionJar?: boolean; includeAssertions?: boolean }): Promise<LearningSuggestionPayload> {
  const [workflowRows, stepRows, sessionRows, eventRows, workflowDraftStepRows, runtimeRows] = await Promise.all([
    db.runRawQuery(`SELECT * FROM workflows WHERE id = ?`, [workflowId]),
    db.runRawQuery(`SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order`, [workflowId]),
    db.runRawQuery(`SELECT * FROM recording_sessions WHERE id = ?`, [recordingSessionId]),
    db.runRawQuery(`SELECT * FROM recording_events WHERE session_id = ? ORDER BY sequence`, [recordingSessionId]),
    db.runRawQuery(`SELECT * FROM workflow_draft_steps WHERE session_id = ? ORDER BY sequence`, [recordingSessionId]),
    db.runRawQuery(`SELECT * FROM recording_runtime_context WHERE session_id = ? ORDER BY created_at`, [recordingSessionId]),
  ]);
  const workflow = workflowRows?.[0];
  if (!workflow) throw new Error('Workflow not found');
  const session = sessionRows?.[0];
  if (!session) throw new Error('Recording session not found');
  const templates = await Promise.all((stepRows || []).map(async(step:any)=>{
    const rows=await db.runRawQuery(`SELECT id, advanced_config FROM api_templates WHERE id = ?`,[step.api_template_id]);
    return rows?.[0];
  }));
  const mapped = mapRecordingEventsToWorkflowSteps(stepRows || [], workflowDraftStepRows || [], eventRows || [], templates.filter(Boolean));
  if (mapped.length === 0) throw new Error('Recording session cannot be mapped to workflow steps');
  const snapshots: StepSnapshot[] = mapped.map(({ stepOrder, event, step }: any) => {
    const pq = parsePathAndQuery(event.url || event.path || '');
    return {
      stepOrder,
      templateId: step.api_template_id,
      templateName: step.snapshot_template_name || `Step ${stepOrder}`,
      request: {
        method: event.method,
        url: event.url,
        path: event.path || pq.path,
        headers: safeJson(event.request_headers, {}),
        cookies: safeJson(event.request_cookies, {}),
        query: safeJson(event.query_params, pq.query),
        body: safeJson(event.parsed_request_body, event.request_body_text),
      },
      response: {
        status: Number(event.response_status || 0),
        headers: safeJson(event.response_headers, {}),
        cookies: safeJson(event.response_cookies, {}),
        body: safeJson(event.parsed_response_body, event.response_body_text),
      },
    };
  });
  const engine = new LearningEngine(db);
  const executionLike = await engine.learn(workflowId, snapshots);
  const mappingBoost = new Map<string, number>();
  for (const ctx of runtimeRows || []) {
    if (!ctx.value_text || !ctx.context_key) continue;
    for (const candidate of executionLike.mappingCandidates) {
      if (String(candidate.variableName).includes(String(ctx.context_key).toLowerCase().replace(/[^a-z0-9]+/g, ''))) {
        const key = `${candidate.fromStepOrder}:${candidate.fromPath}:${candidate.toStepOrder}:${candidate.toPath}`;
        mappingBoost.set(key, 0.12);
      }
    }
  }
  const mappings = executionLike.mappingCandidates.map((mapping, idx) => {
    const key = `${mapping.fromStepOrder}:${mapping.fromPath}:${mapping.toStepOrder}:${mapping.toPath}`;
    const boost = mappingBoost.get(key) || 0.08;
    return {
      id: `rec-map-${idx}`,
      fromStepOrder: mapping.fromStepOrder,
      fromLocation: mapping.fromLocation,
      fromPath: mapping.fromPath,
      toStepOrder: mapping.toStepOrder,
      toLocation: mapping.toLocation,
      toPath: mapping.toPath,
      variableName: mapping.variableName,
      transformHint: /authorization/i.test(mapping.toPath) ? 'wrap_bearer' : undefined,
      confidence: Math.min(1, mapping.confidence + boost),
      evidenceCount: 1 + (boost > 0.1 ? 1 : 0),
      reason: boost > 0.1 ? 'recording_factual_evidence' : mapping.reason,
      predictedType: mapping.predictedType,
      source: 'recording' as const,
      selectedByDefault: Math.min(1, mapping.confidence + boost) >= 0.65,
    };
  });
  const variables = mappings.reduce<any[]>((acc, mapping) => {
    if (acc.some((item) => item.variableName === mapping.variableName)) return acc;
    acc.push({
      id: `rec-var-${mapping.variableName}`,
      variableName: mapping.variableName,
      predictedType: mapping.predictedType,
      sourceStepOrder: mapping.fromStepOrder,
      sourceLocation: mapping.fromLocation,
      sourcePath: mapping.fromPath,
      confidence: mapping.confidence,
      reason: `recording:${mapping.reason}`,
      writePolicySuggestion: inferWritePolicy(mapping.predictedType),
      lockSuggestion: mapping.predictedType === 'IDENTITY',
      source: 'recording' as const,
    });
    return acc;
  }, []);
  // Extracted authentication material must be populated by the first actual
  // response. Locking an empty IDENTITY variable before that response prevents
  // the native pool from ever learning it. Rotating CSRF/session fields also
  // cannot use a first-value policy; observed changes establish rotation.
  for(const variable of variables){
    const values=new Set<string>();
    for(const mapping of mappings.filter(item=>item.variableName===variable.variableName)){
      const snapshot=snapshots.find(item=>item.stepOrder===mapping.fromStepOrder);
      const source=mapping.fromLocation==='response.body'?snapshot?.response.body:
        mapping.fromLocation==='response.header'?snapshot?.response.headers:snapshot?.response.cookies;
      let value:any=source;
      for(const part of mapping.fromPath.replace(/^\$\.?/,'').replace(/\[(\d+)\]/g,'.$1').split('.').filter(Boolean))value=value?.[part];
      if(value!==undefined&&value!==null)values.add(JSON.stringify(value));
    }
    variable.lockSuggestion=false;
    if(values.size>1){variable.writePolicySuggestion='on_success_only';variable.reason+='; observed rotating values across source steps';}
  }
  const extractors = (options?.includeExtractors === false ? [] : mappings).map((mapping, idx) => ({
    id: `rec-ext-${idx}`,
    stepOrder: mapping.fromStepOrder,
    extractorType: mapping.fromLocation === 'response.header' ? 'header' as const : mapping.fromLocation === 'response.cookie' ? 'cookie' as const : 'json_path' as const,
    sourceLocation: mapping.fromLocation,
    sourcePath: mapping.fromPath,
    targetVariableName: mapping.variableName,
    confidence: Math.max(mapping.confidence, 0.7),
    reason: 'recording propagation evidence',
    source: 'recording' as const,
    required: mapping.predictedType !== 'GENERIC',
  }));
  const responseNodes: any[] = executionLike.candidateFields ? Object.values(executionLike.candidateFields).flat().map((field) => ({
    id: `resp:${field.stepOrder}:${field.location}:${field.path}`,
    stepOrder: field.stepOrder,
    location: field.location,
    path: field.path,
    label: `${field.location}:${field.path}`,
    predictedType: field.predictedType,
    valuePreview: field.valuePreview,
    source: 'recording' as const,
    confidence: Math.min(1, field.score / 100 + 0.05),
  })) : [];
  const requestNodes: any[] = Object.values(executionLike.requestFields).flat().map((field) => ({
    id: `req:${field.stepOrder}:${field.location}:${field.path}`,
    stepOrder: field.stepOrder,
    location: field.location,
    path: field.path,
    label: `${field.location}:${field.path}`,
    predictedType: classifyField(field.path, field.currentValue).predictedType,
    valuePreview: field.currentValue == null ? '' : String(field.currentValue),
    source: 'recording' as const,
    confidence: 0.62,
  }));
  const graphNodes: any[] = [...responseNodes, ...requestNodes];
  const edges = mappings.map((mapping) => ({
    id: mapping.id,
    fromNodeId: `resp:${mapping.fromStepOrder}:${mapping.fromLocation}:${mapping.fromPath}`,
    toNodeId: `req:${mapping.toStepOrder}:${mapping.toLocation}:${mapping.toPath}`,
    variableName: mapping.variableName,
    confidence: mapping.confidence,
    reason: mapping.reason,
    source: 'recording' as const,
    evidenceCount: mapping.evidenceCount,
    transformHint: mapping.transformHint,
  }));
  let sessionJar = options?.includeSessionJar === false ? null : detectSessionJarSuggestion(mappings, 'recording');
  const observedCookiePropagation=snapshots.some((source,index)=>Object.entries(source.response.cookies||{}).some(([name,value])=>
    snapshots.slice(index+1).some(target=>target.request.cookies?.[name]!==undefined&&target.request.cookies[name]===value)));
  // A cookie need not be a scored mapping candidate (for example an opaque
  // "sid" name). The recorder still proves Set-Cookie → Cookie propagation.
  if(options?.includeSessionJar!==false&&observedCookiePropagation)sessionJar={cookieMode:true,headerKeys:sessionJar?.headerKeys||[],bodyJsonPaths:sessionJar?.bodyJsonPaths||[],
    confidence:0.9,reason:'Observed response cookie value is sent by a later recorded request',source:'recording'};
  return {
    workflowId,
    learningVersion: (workflow.learning_version || 0) + 1,
    sourceType: 'recording_only',
    sourceRecordingSessionId: recordingSessionId,
    stepSnapshots: snapshots,
    graph: { nodes: graphNodes, edges },
    suggestions: {
      workflowVariables: variables,
      mappings,
      extractors,
      sessionJar,
      assertions: options?.includeAssertions ? snapshots.map((step, idx) => ({ id: `recording-assert-${idx}`, stepOrder: step.stepOrder, type: 'status' as const, config: { operator: 'equals', expected: step.response.status || 200 }, confidence: 0.7, reason: 'recorded response status', source: 'recording' as const })) : [],
    },
    conflicts: {
      mappings: [],
      extractors: [],
      sessionJar: conflictWithExistingSessionJar(safeJson(workflow.session_jar_config, null), sessionJar),
    },
    summary: {
      nodeCount: graphNodes.length,
      edgeCount: edges.length,
      variableSuggestionCount: variables.length,
      mappingSuggestionCount: mappings.length,
      extractorSuggestionCount: extractors.length,
      assertionSuggestionCount: options?.includeAssertions ? snapshots.length : 0,
    },
    evidence: mappings.map((mapping) => ({ fromStepOrder: mapping.fromStepOrder, toStepOrder: mapping.toStepOrder, evidenceType: 'recording_propagation', confidence: mapping.confidence, payload: { variableName: mapping.variableName, fromPath: mapping.fromPath, toPath: mapping.toPath, sourceSessionId: recordingSessionId } })),
  };
}
