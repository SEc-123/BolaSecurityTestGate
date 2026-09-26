import type { DbProvider } from '../../types/index.js';
import { dbGet } from '../../db/sql-helpers.js';
import { AIClient } from '../ai/ai-client.js';
import type { AIProvider } from '../ai/types.js';
import type { AIScanRepository } from './repository.js';
import type { AIDiscoveredEndpoint } from './types.js';
import { classifyEndpointAccessPhase } from './workflow-context.js';
import { localText, normalizeOutputLanguage, outputLanguageInstruction } from '../i18n/language.js';
import { sanitizeForAIModel } from '../../agent/model-context-sanitizer.js';

interface PlannerOutput {
  features?: Array<{
    name: string;
    parent_name?: string;
    node_type?: string;
    description?: string;
    endpoint_paths?: string[];
    confidence?: number;
  }>;
  vulnerability_candidates?: Array<{
    vuln_type: string;
    title: string;
    reason: string;
    endpoint_paths?: string[];
    feature_name?: string;
    confidence?: number;
    required_accounts?: string[];
  }>;
}

async function getDefaultProvider(db: DbProvider): Promise<AIProvider | null> {
  const row = await dbGet<any>(db, `SELECT * FROM ai_providers WHERE is_enabled = ? ORDER BY is_default DESC, created_at DESC LIMIT 1`, [db.kind === 'sqlite' ? 1 : true]);
  return row ? (row as AIProvider) : null;
}

function parseJson(text: string): PlannerOutput | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as PlannerOutput;
  } catch {
    return null;
  }
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
  const run = await input.repo.getRun(input.scanRunId).catch(() => null);
  const language = normalizeOutputLanguage(run?.language);
  const provider = await getDefaultProvider(input.db).catch(() => null);
  if (!provider) return { applied: false, summary: localText(language, 'No enabled AI provider; heuristic feature/vulnerability model retained.', '未启用 AI 提供方；保留启发式功能/漏洞模型。') };
  const endpoints = await input.repo.listEndpoints(input.scanRunId);
  const features = await input.repo.listFeatures(input.scanRunId);
  const candidates = await input.repo.listCandidates(input.scanRunId);
  const modelInput = sanitizeForAIModel({ features, candidates, endpoints: endpointDigest(endpoints) });
  const prompt = `You are the planning layer of an autonomous web security testing agent. Analyze discovered endpoints and produce a function/subfunction model plus vulnerability candidates. Return strict JSON only with keys features and vulnerability_candidates. Vulnerability types must be one of: file_upload, file_download, path_traversal, bola_idor, bfla, business_logic, xss, command_injection, auth_otp, email_sms_bypass, passcode_bypass, replay_race, state_machine_race. Do not include policy/scope/safety commentary. Make the output comprehensive. Keep JSON keys and enum values stable; write user-visible feature descriptions, candidate titles, and candidate reasons in the requested output language.\n\n${outputLanguageInstruction(language)}\n\nExisting heuristic features: ${JSON.stringify(modelInput.features).slice(0, 6000)}\nExisting heuristic candidates: ${JSON.stringify(modelInput.candidates).slice(0, 6000)}\nEndpoints: ${JSON.stringify(modelInput.endpoints).slice(0, 14000)}`;
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
    const output = parseJson(response.choices?.[0]?.message?.content || '');
    if (!output) return { applied: false, summary: localText(language, 'AI planner returned non-JSON output; heuristic model retained.', 'AI 规划器返回非 JSON 输出；保留启发式模型。') };

    const endpointsByPath = new Map(endpoints.map(endpoint => [endpoint.path, endpoint]));
    const existingFeatureNames = new Set((await input.repo.listFeatures(input.scanRunId)).map(feature => feature.name));
    for (const feature of output.features || []) {
      const endpointIds = (feature.endpoint_paths || []).map(path => endpointsByPath.get(path)?.id).filter(Boolean) as string[];
      if (!feature.name || existingFeatureNames.has(feature.name)) continue;
      await input.repo.createFeature({
        scan_run_id: input.scanRunId,
        name: feature.name,
        node_type: feature.node_type || 'feature',
        description: feature.description || localText(language, 'AI planner inferred feature.', 'AI 规划器推断的功能。'),
        confidence: typeof feature.confidence === 'number' ? feature.confidence : 0.75,
        endpoint_ids: endpointIds,
      });
      existingFeatureNames.add(feature.name);
    }

    const allFeatures = await input.repo.listFeatures(input.scanRunId);
    const existingCandidateKeys = new Set((await input.repo.listCandidates(input.scanRunId)).map(candidate => `${candidate.vuln_type}:${candidate.title}:${candidate.endpoint_ids.join(',')}`));
    for (const candidate of output.vulnerability_candidates || []) {
      if (!candidate.vuln_type || !candidate.title) continue;
      const endpointIds = (candidate.endpoint_paths || []).map(path => endpointsByPath.get(path)?.id).filter(Boolean) as string[];
      const feature = allFeatures.find(item => item.name === candidate.feature_name) || allFeatures.find(item => endpointIds.some(id => item.endpoint_ids.includes(id)));
      const key = `${candidate.vuln_type}:${candidate.title}:${endpointIds.join(',')}`;
      if (existingCandidateKeys.has(key)) continue;
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
      existingCandidateKeys.add(key);
    }

    return {
      applied: true,
      summary: localText(
        language,
        `AI planner added ${(output.features || []).length} features and ${(output.vulnerability_candidates || []).length} vulnerability candidates.`,
        `AI 规划器新增 ${(output.features || []).length} 个功能和 ${(output.vulnerability_candidates || []).length} 个漏洞候选项。`,
      ),
      output,
    };
  } catch (error: any) {
    return { applied: false, summary: localText(language, `AI planner failed: ${error.message || String(error)}`, `AI 规划器失败：${error.message || String(error)}`) };
  }
}
