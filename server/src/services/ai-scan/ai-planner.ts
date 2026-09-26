import { assertScanActive } from './run-control.js';
import type { DbProvider } from '../../types/index.js';
import { dbGet } from '../../db/sql-helpers.js';
import { AIClient } from '../ai/ai-client.js';
import type { AIProvider } from '../ai/types.js';
import type { AIScanRepository } from './repository.js';
import type { AIDiscoveredEndpoint } from './types.js';
import { classifyEndpointAccessPhase } from './workflow-context.js';
import { localText, normalizeOutputLanguage, outputLanguageInstruction } from '../i18n/language.js';
import { sanitizeForAIModel } from '../../agent/model-context-sanitizer.js';
import { VULN_TYPES } from './feature-vuln-engine.js';

interface PlannerOutput {
  features?: Array<{
    name: string;
    parent_name?: string;
    node_type?: string;
    description?: string;
    endpoint_ids: string[];
    confidence?: number;
  }>;
  vulnerability_candidates?: Array<{
    vuln_type: string;
    title: string;
    reason?: string;
    endpoint_ids: string[];
    feature_name?: string;
    confidence?: number;
    required_accounts?: string[];
  }>;
}

async function getDefaultProvider(db: DbProvider): Promise<AIProvider | null> {
  const row = await dbGet<any>(db, `SELECT * FROM ai_providers WHERE is_enabled = ? ORDER BY is_default DESC, created_at DESC LIMIT 1`, [db.kind === 'sqlite' ? 1 : true]);
  return row ? (row as AIProvider) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!isRecord(parsed)) return null;
    if (['features', 'vulnerability_candidates'].some(key => parsed[key] !== undefined && !Array.isArray(parsed[key]))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** All references must resolve within this scan; never drop invalid references. */
function resolveEndpointIds(value: Record<string, unknown>, endpoints: AIDiscoveredEndpoint[]): string[] | null {
  const resolved = new Set<string>();
  for (const field of ['endpoint_ids', 'endpoint_paths']) {
    const references = value[field];
    if (references === undefined) continue;
    if (!Array.isArray(references)) return null;
    for (const reference of references) {
      if (typeof reference !== 'string' || !reference) return null;
      const matches = endpoints.filter(endpoint => field === 'endpoint_ids' ? endpoint.id === reference : endpoint.path === reference);
      // A path shared by multiple methods needs an explicit ID, not an arbitrary match.
      if (matches.length !== 1) return null;
      resolved.add(matches[0].id);
    }
  }
  return [...resolved];
}

function normalizePlannerOutput(raw: Record<string, unknown>, endpoints: AIDiscoveredEndpoint[]): PlannerOutput {
  const output: Required<PlannerOutput> = { features: [], vulnerability_candidates: [] };
  for (const feature of (raw.features || []) as unknown[]) {
    if (!isRecord(feature) || typeof feature.name !== 'string' || !feature.name.trim()) continue;
    const endpointIds = resolveEndpointIds(feature, endpoints);
    if (!endpointIds) continue;
    output.features.push({
      name: feature.name.trim(),
      node_type: typeof feature.node_type === 'string' ? feature.node_type : undefined,
      description: typeof feature.description === 'string' ? feature.description : undefined,
      confidence: typeof feature.confidence === 'number' && Number.isFinite(feature.confidence) ? feature.confidence : undefined,
      endpoint_ids: endpointIds,
    });
  }
  const supportedTypes = new Set<string>(VULN_TYPES);
  for (const candidate of (raw.vulnerability_candidates || []) as unknown[]) {
    if (!isRecord(candidate) || typeof candidate.title !== 'string' || !candidate.title.trim()) continue;
    const types = ['vuln_type', 'type', 'vulnerability_type'].filter(key => key in candidate).map(key => candidate[key]);
    const vulnType = types[0];
    // Known aliases may agree; conflicting or unknown values cannot override validation.
    if (typeof vulnType !== 'string' || !supportedTypes.has(vulnType) || types.some(type => type !== vulnType)) continue;
    const endpointIds = resolveEndpointIds(candidate, endpoints);
    if (!endpointIds?.length) continue;
    output.vulnerability_candidates.push({
      vuln_type: vulnType,
      title: candidate.title.trim(),
      reason: typeof candidate.reason === 'string' ? candidate.reason : undefined,
      endpoint_ids: endpointIds,
      feature_name: typeof candidate.feature_name === 'string' ? candidate.feature_name : undefined,
      confidence: typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence) ? candidate.confidence : undefined,
      required_accounts: Array.isArray(candidate.required_accounts) ? candidate.required_accounts.filter((item): item is string => typeof item === 'string') : undefined,
    });
  }
  return output;
}

function candidateKey(candidate: { vuln_type: string; title: string; endpoint_ids: string[] }): string {
  return JSON.stringify([candidate.vuln_type, candidate.title, [...new Set(candidate.endpoint_ids)].sort()]);
}

function endpointDigest(endpoints: AIDiscoveredEndpoint[]) {
  return endpoints.map(endpoint => ({
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    content_type: endpoint.content_type,
    feature_guess: endpoint.feature_guess,
    request_summary: endpoint.request_summary,
    response_summary: endpoint.response_summary,
  })).slice(0, 400);
}

function requiredAccountsForAI(endpointIds: string[], endpoints: AIDiscoveredEndpoint[], vulnType: string, provided?: string[]): string[] {
  const out = new Set((provided || []).filter(item => item && item !== 'auto').map(String));
  const phases = endpointIds
    .map(id => endpoints.find(endpoint => endpoint.id === id))
    .filter(Boolean)
    .map(endpoint => classifyEndpointAccessPhase(endpoint as AIDiscoveredEndpoint));
  if (phases.includes('pre_auth')) out.add('anonymous');
  if (phases.includes('auth_transition')) out.add('auth_transition');
  if (phases.includes('post_auth')) {
    out.add('authenticated');
    out.add('session');
  }
  if (['bola_idor', 'bfla'].includes(vulnType)) {
    out.add('attacker');
    out.add(vulnType === 'bola_idor' ? 'victim' : 'admin');
    out.add('session');
  }
  if (['business_logic', 'replay_race', 'state_machine_race', 'passcode_bypass'].includes(vulnType)) {
    out.add('authenticated');
    out.add('session');
    out.add('object_state');
  }
  if (['auth_otp', 'email_sms_bypass'].includes(vulnType)) {
    out.add('auth_transition');
    out.add('verification_ticket');
  }
  return [...out];
}

export async function enhanceFeatureAndVulnModelWithAI(input: {
  db: DbProvider;
  repo: AIScanRepository;
  scanRunId: string;
}): Promise<{ applied: boolean; summary: string; output?: PlannerOutput }> {
  assertScanActive();
  const run = await input.repo.getRun(input.scanRunId).catch(() => null);
  const language = normalizeOutputLanguage(run?.language);
  const provider = await getDefaultProvider(input.db).catch(() => null);
  assertScanActive();
  if (!provider) return { applied: false, summary: localText(language, 'No enabled AI provider; heuristic feature/vulnerability model retained.', '未启用 AI 提供方；保留启发式功能/漏洞模型。') };
  const endpoints = (await input.repo.listEndpoints(input.scanRunId)).filter(endpoint => endpoint.scan_run_id === input.scanRunId);
  const features = await input.repo.listFeatures(input.scanRunId);
  const candidates = await input.repo.listCandidates(input.scanRunId);
  const modelInput = sanitizeForAIModel({ features, candidates, endpoints: endpointDigest(endpoints) });
  const prompt = `You are the planning layer of an autonomous web security testing agent. Analyze discovered endpoints and produce a function/subfunction model plus vulnerability candidates. Return strict JSON only with keys features and vulnerability_candidates. Each candidate must have vuln_type, title, reason and endpoint_ids containing at least one discovered endpoint ID from this scan. Features may use endpoint_ids as well. If using endpoint_paths instead, copy exact discovered paths; use IDs when multiple methods share a path. Vulnerability types must be one of: ${VULN_TYPES.join(', ')}. Do not include policy/scope/safety commentary. Make the output comprehensive. Keep JSON keys and enum values stable; write user-visible feature descriptions, candidate titles, and candidate reasons in the requested output language.\n\n${outputLanguageInstruction(language)}\n\nExisting heuristic features: ${JSON.stringify(modelInput.features).slice(0, 6000)}\nExisting heuristic candidates: ${JSON.stringify(modelInput.candidates).slice(0, 6000)}\nEndpoints: ${JSON.stringify(modelInput.endpoints).slice(0, 14000)}`;
  try {
    const client = new AIClient(provider);
    const response = await client.chat({
      model: provider.model,
      messages: [{ role: 'system', content: 'Return strict JSON only. No prose.' }, { role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4000,
      timeout_ms: 12000,
      max_retries: 0,
    });
    const rawOutput = parseJson(response.choices?.[0]?.message?.content || '');
    if (!rawOutput) return { applied: false, summary: localText(language, 'AI planner returned invalid JSON output; heuristic model retained.', 'AI 规划器返回无效 JSON 输出；保留启发式模型。') };
    const output = normalizePlannerOutput(rawOutput, endpoints);

    const existingFeatures = await input.repo.listFeatures(input.scanRunId);
    const existingFeatureNames = new Set(existingFeatures.map(feature => feature.name));
    let addedFeatures = 0;
    let addedCandidates = 0;
    for (const feature of output.features || []) {
      if (existingFeatureNames.has(feature.name)) continue;
      assertScanActive();
      await input.repo.createFeature({
        scan_run_id: input.scanRunId,
        name: feature.name,
        node_type: feature.node_type || 'feature',
        description: feature.description || localText(language, 'AI planner inferred feature.', 'AI 规划器推断的功能。'),
        confidence: typeof feature.confidence === 'number' ? feature.confidence : 0.75,
        endpoint_ids: feature.endpoint_ids,
      });
      addedFeatures += 1;
      existingFeatureNames.add(feature.name);
    }

    const allFeatures = await input.repo.listFeatures(input.scanRunId);
    const existingCandidates = await input.repo.listCandidates(input.scanRunId);
    const existingCandidateKeys = new Set(existingCandidates.map(candidateKey));
    for (const candidate of output.vulnerability_candidates || []) {
      const endpointIds = candidate.endpoint_ids;
      const feature = allFeatures.find(item => item.name === candidate.feature_name) || allFeatures.find(item => endpointIds.some(id => item.endpoint_ids.includes(id)));
      const key = candidateKey(candidate);
      if (existingCandidateKeys.has(key)) continue;
      assertScanActive();
      await input.repo.createCandidate({
        scan_run_id: input.scanRunId,
        feature_id: feature?.id,
        vuln_type: candidate.vuln_type,
        title: candidate.title,
        reason: candidate.reason,
        confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0.72,
        endpoint_ids: endpointIds,
        required_accounts: requiredAccountsForAI(endpointIds, endpoints, candidate.vuln_type, candidate.required_accounts),
      });
      addedCandidates += 1;
      existingCandidateKeys.add(key);
    }

    return {
      applied: addedFeatures > 0 || addedCandidates > 0,
      summary: localText(
        language,
        `AI planner added ${addedFeatures} features and ${addedCandidates} vulnerability candidates. Retained ${existingFeatures.length} existing features and ${existingCandidates.length} existing vulnerability candidates.`,
        `AI 规划器新增 ${addedFeatures} 个功能和 ${addedCandidates} 个漏洞候选项。保留 ${existingFeatures.length} 个已有功能和 ${existingCandidates.length} 个已有漏洞候选项。`,
      ),
      output,
    };
  } catch (error: any) {
    assertScanActive();
    return { applied: false, summary: localText(language, `AI planner failed: ${error.message || String(error)}`, `AI 规划器失败：${error.message || String(error)}`) };
  }
}
