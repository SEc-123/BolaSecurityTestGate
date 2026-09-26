import type { AITechFingerprint } from './types.js';
import { safeFetch } from '../security/target-policy.js';

export interface NormalizedHistoricalVuln {
  fingerprint_id?: string;
  component_name: string;
  component_version?: string;
  source: string;
  source_id: string;
  cve_id?: string;
  ghsa_id?: string;
  osv_id?: string;
  title: string;
  severity?: string;
  cvss?: number;
  cisa_kev?: boolean;
  affected_versions: string[];
  fixed_versions: string[];
  references: string[];
  match_confidence: number;
  match_reason?: string;
  raw_json: Record<string, any>;
}

export interface HistoricalVulnLookupResult {
  matches: NormalizedHistoricalVuln[];
  source_status: Array<{ source: string; ok: boolean; count?: number; error?: string; mode?: string }>;
}

interface McpServerConfig {
  name?: string;
  type?: 'streamable_http' | 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  tool?: string;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function safeJsonParse(value: unknown): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseMcpServers(): McpServerConfig[] {
  if (!envFlag('BSTG_MCP_ENABLED')) return [];
  const parsed = safeJsonParse(process.env.BSTG_MCP_SERVERS_JSON);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      name: String(item.name || item.url || item.command || 'mcp-intel'),
      type: item.type === 'stdio' ? 'stdio' : 'streamable_http',
      url: item.url ? String(item.url) : undefined,
      command: item.command ? String(item.command) : undefined,
      args: Array.isArray(item.args) ? item.args.map(String) : [],
      env: item.env && typeof item.env === 'object' ? Object.fromEntries(Object.entries(item.env).map(([key, value]) => [key, String(value)])) : undefined,
      cwd: item.cwd ? String(item.cwd) : undefined,
      headers: item.headers && typeof item.headers === 'object' ? Object.fromEntries(Object.entries(item.headers).map(([key, value]) => [key, String(value)])) : undefined,
      tool: item.tool ? String(item.tool) : 'vuln_intel.lookup_history',
      timeout_ms: Number(item.timeout_ms || DEFAULT_TIMEOUT_MS),
    }));
}

function sanitizeMcpServer(server: McpServerConfig): Record<string, any> {
  return {
    name: server.name,
    type: server.type,
    url: server.url,
    command: server.command,
    args_count: server.args?.length || 0,
    headers: Object.keys(server.headers || {}),
    tool: server.tool,
    timeout_ms: server.timeout_ms,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label}_timeout`)), Math.max(1000, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function textFromMcpResult(result: any): string {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .map((item: any) => item?.type === 'text' ? String(item.text || '') : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function callMcpVulnIntel(components: AITechFingerprint[]): Promise<HistoricalVulnLookupResult | null> {
  const servers = parseMcpServers();
  if (servers.length === 0) return null;
  const sourceStatus: HistoricalVulnLookupResult['source_status'] = [];
  for (const server of servers) {
    let client: any;
    let transport: any;
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      if (server.type === 'stdio') {
        if (!server.command) throw new Error('stdio MCP server requires command');
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        transport = new StdioClientTransport({
          command: server.command,
          args: server.args || [],
          env: server.env,
          cwd: server.cwd,
          stderr: 'pipe',
        });
      } else {
        if (!server.url) throw new Error('HTTP MCP server requires url');
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        transport = new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: server.headers ? { headers: server.headers } : undefined,
        });
      }
      client = new Client({ name: 'bstg-ai-scan-intel', version: '1.0.0' }, { capabilities: {} });
      await withTimeout(client.connect(transport), Number(server.timeout_ms || DEFAULT_TIMEOUT_MS), 'mcp_connect');
      const result = await withTimeout(
        client.callTool({
          name: server.tool || 'vuln_intel.lookup_history',
          arguments: {
            components: components.map(item => ({
              id: item.id,
              name: item.component_name,
              type: item.component_type,
              version: item.version,
              confidence: item.confidence,
              cpe_candidates: item.cpe_candidates,
              purl_candidates: item.purl_candidates,
            })),
          },
        }),
        Number(server.timeout_ms || DEFAULT_TIMEOUT_MS),
        'mcp_tool_call'
      );
      const rawResult = result as any;
      const parsed = safeJsonParse(textFromMcpResult(result)) || rawResult?.structuredContent || rawResult;
      const rawMatches = Array.isArray(parsed?.matches) ? parsed.matches : Array.isArray(parsed) ? parsed : [];
      const matches = normalizeExternalMatches(rawMatches, components, 'mcp');
      sourceStatus.push({ source: `mcp:${server.name || server.tool || 'server'}`, ok: true, count: matches.length, mode: JSON.stringify(sanitizeMcpServer(server)) });
      return { matches, source_status: sourceStatus };
    } catch (error: any) {
      sourceStatus.push({ source: `mcp:${server.name || server.tool || 'server'}`, ok: false, error: error.message || String(error), mode: JSON.stringify(sanitizeMcpServer(server)) });
    } finally {
      try { await client?.close?.(); } catch {}
      try { await transport?.close?.(); } catch {}
    }
  }
  return { matches: [], source_status: sourceStatus };
}

function parsePurl(purl: string): { ecosystem?: string; name?: string; version?: string } {
  const match = String(purl || '').match(/^pkg:([^/]+)\/([^@]+)(?:@(.+))?$/);
  if (!match) return {};
  const ecosystemMap: Record<string, string> = {
    npm: 'npm',
    pypi: 'PyPI',
    rubygems: 'RubyGems',
    packagist: 'Packagist',
    maven: 'Maven',
    go: 'Go',
  };
  return { ecosystem: ecosystemMap[match[1].toLowerCase()] || match[1], name: match[2], version: match[3] };
}

function ecosystemForGithub(ecosystem?: string): string | null {
  const value = String(ecosystem || '').toLowerCase();
  if (value === 'npm') return 'NPM';
  if (value === 'pypi') return 'PIP';
  if (value === 'rubygems') return 'RUBYGEMS';
  if (value === 'packagist') return 'COMPOSER';
  if (value === 'maven') return 'MAVEN';
  if (value === 'go') return 'GO';
  return null;
}

function versionParts(version?: string): number[] {
  return String(version || '')
    .split(/[.+-]/)
    .map(part => Number.parseInt(part, 10))
    .filter(Number.isFinite);
}

export function compareVersions(a?: string, b?: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

export function versionSatisfiesRange(version: string | undefined, ranges: string[]): boolean | undefined {
  if (!version) return undefined;
  if (!ranges.length) return undefined;
  let anyComparable = false;
  for (const rawRange of ranges) {
    const parts = String(rawRange || '').split(/\s+/).filter(Boolean);
    let matched = true;
    let comparable = false;
    for (let index = 0; index < parts.length; index += 1) {
      const token = parts[index];
      const direct = token.match(/^(<=|<|>=|>|=)?(.+)$/);
      const operator = direct?.[1] || (['<', '<=', '>', '>=', '='].includes(token) ? token : '=');
      const rhs = ['<', '<=', '>', '>=', '='].includes(token) ? parts[++index] : direct?.[2];
      if (!rhs || !/\d/.test(rhs)) continue;
      comparable = true;
      const cmp = compareVersions(version, rhs);
      if (operator === '<' && !(cmp < 0)) matched = false;
      if (operator === '<=' && !(cmp <= 0)) matched = false;
      if (operator === '>' && !(cmp > 0)) matched = false;
      if (operator === '>=' && !(cmp >= 0)) matched = false;
      if (operator === '=' && cmp !== 0) matched = false;
    }
    if (comparable) anyComparable = true;
    if (comparable && matched) return true;
  }
  return anyComparable ? false : undefined;
}

function confidenceFor(component: AITechFingerprint, affected: string[], rawConfidence = 0.55): { confidence: number; reason: string } {
  const inRange = versionSatisfiesRange(component.version, affected);
  if (component.version && inRange === true) {
    return { confidence: Math.min(0.99, Math.max(rawConfidence, component.confidence, 0.92)), reason: 'component version is inside affected range' };
  }
  if (component.version && inRange === false) {
    return { confidence: Math.min(0.35, rawConfidence), reason: 'component version appears outside affected range' };
  }
  if (component.version) {
    return { confidence: Math.min(0.78, Math.max(rawConfidence, component.confidence * 0.82)), reason: 'component version observed but affected range could not be strictly evaluated' };
  }
  return { confidence: Math.min(0.54, Math.max(0.35, rawConfidence)), reason: 'component product exposure without observed version' };
}

function cveFromIdentifiers(identifiers: any[] = []): string | undefined {
  return identifiers.find(item => String(item?.type || '').toUpperCase() === 'CVE')?.value;
}

function normalizeSeverity(value: any): string | undefined {
  const text = String(value || '').toLowerCase();
  if (['critical', 'high', 'medium', 'low', 'info', 'moderate'].includes(text)) return text === 'moderate' ? 'medium' : text;
  return undefined;
}

function normalizeExternalMatches(rawMatches: any[], components: AITechFingerprint[], defaultSource: string): NormalizedHistoricalVuln[] {
  const byId = new Map(components.map(item => [item.id, item]));
  return rawMatches.map(raw => {
    const fingerprint = byId.get(String(raw.fingerprint_id || raw.component_id || '')) || components.find(item => item.component_name === raw.component_name || item.component_name === raw.package_name) || components[0];
    const affected = Array.isArray(raw.affected_versions) ? raw.affected_versions.map(String) : [];
    const confidence = confidenceFor(fingerprint, affected, Number(raw.match_confidence || raw.confidence || 0.62));
    return {
      fingerprint_id: fingerprint?.id,
      component_name: raw.component_name || fingerprint?.component_name || 'unknown',
      component_version: raw.component_version || fingerprint?.version,
      source: String(raw.source || defaultSource),
      source_id: String(raw.source_id || raw.id || raw.cve_id || raw.ghsa_id || raw.osv_id || 'external-intel'),
      cve_id: raw.cve_id || cveFromIdentifiers(raw.identifiers),
      ghsa_id: raw.ghsa_id,
      osv_id: raw.osv_id,
      title: String(raw.title || raw.summary || raw.details || raw.cve_id || raw.ghsa_id || raw.osv_id || 'Historical vulnerability').slice(0, 300),
      severity: normalizeSeverity(raw.severity),
      cvss: Number.isFinite(Number(raw.cvss)) ? Number(raw.cvss) : undefined,
      cisa_kev: Boolean(raw.cisa_kev),
      affected_versions: affected,
      fixed_versions: Array.isArray(raw.fixed_versions) ? raw.fixed_versions.map(String) : [],
      references: Array.isArray(raw.references) ? raw.references.map((item: any) => typeof item === 'string' ? item : String(item?.url || '')).filter(Boolean) : [],
      match_confidence: confidence.confidence,
      match_reason: raw.match_reason || confidence.reason,
      raw_json: raw && typeof raw === 'object' ? raw : { raw },
    };
  });
}

function rangesFromOsvAffected(affected: any[], component: AITechFingerprint): { affected: string[]; fixed: string[] } {
  const affectedRanges: string[] = [];
  const fixed: string[] = [];
  for (const item of affected || []) {
    const pkg = item.package || {};
    if (pkg.name && !String(pkg.name).toLowerCase().includes(component.component_name.replace(/^@/, '').toLowerCase())) {
      const purls = component.purl_candidates.join(' ').toLowerCase();
      if (!purls.includes(String(pkg.name).toLowerCase())) continue;
    }
    for (const range of item.ranges || []) {
      let introduced = '0';
      for (const event of range.events || []) {
        if (event.introduced !== undefined) introduced = String(event.introduced);
        if (event.fixed !== undefined) {
          fixed.push(String(event.fixed));
          affectedRanges.push(`>= ${introduced} < ${event.fixed}`);
        }
        if (event.last_affected !== undefined) affectedRanges.push(`>= ${introduced} <= ${event.last_affected}`);
      }
    }
    for (const version of item.versions || []) {
      affectedRanges.push(`= ${version}`);
    }
  }
  return { affected: Array.from(new Set(affectedRanges)), fixed: Array.from(new Set(fixed)) };
}

async function postJson(url: string, body: any, headers: Record<string, string> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await safeFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, 'historical vulnerability POST request');
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await safeFetch(url, { headers, signal: controller.signal }, 'historical vulnerability GET request');
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function queryOsv(components: AITechFingerprint[], timeoutMs: number): Promise<NormalizedHistoricalVuln[]> {
  const matches: NormalizedHistoricalVuln[] = [];
  for (const component of components) {
    const purl = component.purl_candidates[0];
    const pkg = purl ? parsePurl(purl) : {};
    if (!pkg.name && !component.component_name) continue;
    const body = pkg.name
      ? { package: { ecosystem: pkg.ecosystem, name: pkg.name }, version: component.version || pkg.version }
      : { package: { name: component.component_name }, version: component.version };
    if (!body.package.name) continue;
    const data = await postJson('https://api.osv.dev/v1/query', body, {}, timeoutMs);
    for (const vuln of data.vulns || []) {
      const ranges = rangesFromOsvAffected(vuln.affected || [], component);
      const confidence = confidenceFor(component, ranges.affected, 0.7);
      if (confidence.confidence < 0.36) continue;
      matches.push({
        fingerprint_id: component.id,
        component_name: component.component_name,
        component_version: component.version,
        source: 'osv',
        source_id: String(vuln.id || vuln.aliases?.[0] || 'OSV'),
        cve_id: (vuln.aliases || []).find((item: string) => item.startsWith('CVE-')),
        ghsa_id: (vuln.aliases || []).find((item: string) => item.startsWith('GHSA-')),
        osv_id: vuln.id,
        title: vuln.summary || vuln.details || vuln.id,
        severity: normalizeSeverity(vuln.database_specific?.severity),
        cvss: Array.isArray(vuln.severity) ? Number(vuln.severity.find((item: any) => item.type === 'CVSS_V3')?.score?.match(/\d+(?:\.\d+)?/)?.[0]) : undefined,
        cisa_kev: false,
        affected_versions: ranges.affected,
        fixed_versions: ranges.fixed,
        references: (vuln.references || []).map((item: any) => String(item.url || '')).filter(Boolean),
        match_confidence: confidence.confidence,
        match_reason: confidence.reason,
        raw_json: vuln,
      });
    }
  }
  return matches;
}

async function queryNvd(components: AITechFingerprint[], timeoutMs: number): Promise<NormalizedHistoricalVuln[]> {
  const matches: NormalizedHistoricalVuln[] = [];
  const headers: Record<string, string> | undefined = process.env.NVD_API_KEY ? { apiKey: process.env.NVD_API_KEY } : undefined;
  for (const component of components.filter(item => item.confidence >= 0.55).slice(0, 12)) {
    const keyword = [component.component_name, component.version].filter(Boolean).join(' ');
    const url = new URL('https://services.nvd.nist.gov/rest/json/cves/2.0');
    url.searchParams.set('keywordSearch', keyword || component.component_name);
    url.searchParams.set('resultsPerPage', '20');
    const data = await getJson(url.toString(), headers, timeoutMs);
    for (const item of data.vulnerabilities || []) {
      const cve = item.cve || {};
      const id = cve.id || '';
      const description = (cve.descriptions || []).find((desc: any) => desc.lang === 'en')?.value || id;
      const metric = cve.metrics?.cvssMetricV31?.[0]?.cvssData || cve.metrics?.cvssMetricV30?.[0]?.cvssData || cve.metrics?.cvssMetricV2?.[0]?.cvssData || {};
      const affected = component.version ? [`= ${component.version}`] : [];
      const confidence = confidenceFor(component, affected, component.version && description.toLowerCase().includes(component.version.toLowerCase()) ? 0.66 : 0.48);
      if (confidence.confidence < 0.36) continue;
      matches.push({
        fingerprint_id: component.id,
        component_name: component.component_name,
        component_version: component.version,
        source: 'nvd',
        source_id: id,
        cve_id: id,
        title: description.slice(0, 300),
        severity: normalizeSeverity(metric.baseSeverity),
        cvss: Number.isFinite(Number(metric.baseScore)) ? Number(metric.baseScore) : undefined,
        cisa_kev: Boolean(cve.cisaExploitAdd),
        affected_versions: affected,
        fixed_versions: [],
        references: (cve.references?.referenceData || cve.references || []).map((ref: any) => String(ref.url || '')).filter(Boolean),
        match_confidence: confidence.confidence,
        match_reason: confidence.reason,
        raw_json: item,
      });
    }
  }
  return matches;
}

async function queryGithubAdvisories(components: AITechFingerprint[], timeoutMs: number): Promise<NormalizedHistoricalVuln[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];
  const matches: NormalizedHistoricalVuln[] = [];
  const query = `
    query($ecosystem: SecurityAdvisoryEcosystem!, $package: String!) {
      securityVulnerabilities(first: 20, ecosystem: $ecosystem, package: $package) {
        nodes {
          vulnerableVersionRange
          firstPatchedVersion { identifier }
          advisory {
            ghsaId
            summary
            severity
            identifiers { type value }
            references { url }
            cvss { score }
          }
        }
      }
    }
  `;
  for (const component of components) {
    const purl = component.purl_candidates[0];
    const pkg = purl ? parsePurl(purl) : {};
    const ecosystem = ecosystemForGithub(pkg.ecosystem);
    if (!ecosystem || !pkg.name) continue;
    const data = await postJson('https://api.github.com/graphql', { query, variables: { ecosystem, package: pkg.name } }, {
      authorization: `Bearer ${token}`,
      'user-agent': 'BSTG-AI-Agent/1.0',
    }, timeoutMs);
    if (data.errors?.length) throw new Error(data.errors.map((item: any) => item.message).join('; '));
    for (const node of data.data?.securityVulnerabilities?.nodes || []) {
      const advisory = node.advisory || {};
      const affected = node.vulnerableVersionRange ? [String(node.vulnerableVersionRange)] : [];
      const confidence = confidenceFor(component, affected, 0.72);
      if (confidence.confidence < 0.36) continue;
      matches.push({
        fingerprint_id: component.id,
        component_name: component.component_name,
        component_version: component.version,
        source: 'github_advisory',
        source_id: advisory.ghsaId,
        cve_id: cveFromIdentifiers(advisory.identifiers || []),
        ghsa_id: advisory.ghsaId,
        title: advisory.summary || advisory.ghsaId,
        severity: normalizeSeverity(advisory.severity),
        cvss: Number.isFinite(Number(advisory.cvss?.score)) ? Number(advisory.cvss.score) : undefined,
        cisa_kev: false,
        affected_versions: affected,
        fixed_versions: node.firstPatchedVersion?.identifier ? [node.firstPatchedVersion.identifier] : [],
        references: (advisory.references || []).map((item: any) => String(item.url || '')).filter(Boolean),
        match_confidence: confidence.confidence,
        match_reason: confidence.reason,
        raw_json: node,
      });
    }
  }
  return matches;
}

async function loadCisaKev(timeoutMs: number): Promise<Set<string>> {
  const data = await getJson('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', {}, timeoutMs);
  return new Set((data.vulnerabilities || []).map((item: any) => String(item.cveID || '')).filter(Boolean));
}

function dedupe(matches: NormalizedHistoricalVuln[]): NormalizedHistoricalVuln[] {
  const byKey = new Map<string, NormalizedHistoricalVuln>();
  for (const match of matches) {
    const key = `${match.fingerprint_id || match.component_name}:${match.cve_id || match.ghsa_id || match.osv_id || match.source_id}`;
    const existing = byKey.get(key);
    if (!existing || match.match_confidence > existing.match_confidence || (match.cisa_kev && !existing.cisa_kev)) {
      byKey.set(key, {
        ...match,
        references: Array.from(new Set([...(existing?.references || []), ...(match.references || [])])),
        affected_versions: Array.from(new Set([...(existing?.affected_versions || []), ...(match.affected_versions || [])])),
        fixed_versions: Array.from(new Set([...(existing?.fixed_versions || []), ...(match.fixed_versions || [])])),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => Number(b.cisa_kev) - Number(a.cisa_kev) || b.match_confidence - a.match_confidence || (b.cvss || 0) - (a.cvss || 0));
}

function mockMatches(scanConfig: Record<string, any>, components: AITechFingerprint[]): NormalizedHistoricalVuln[] {
  const configured = Array.isArray(scanConfig.mock_historical_vulns)
    ? scanConfig.mock_historical_vulns
    : Array.isArray(safeJsonParse(process.env.BSTG_INTEL_MOCK_JSON))
      ? safeJsonParse(process.env.BSTG_INTEL_MOCK_JSON)
      : [];
  if (!configured.length) return [];
  return normalizeExternalMatches(configured, components, 'mock_intel');
}

export async function lookupHistoricalVulnerabilities(input: {
  components: AITechFingerprint[];
  scan_config?: Record<string, any>;
  timeout_ms?: number;
}): Promise<HistoricalVulnLookupResult> {
  const components = input.components.filter(item => item.confidence >= 0.55 || item.version);
  const sourceStatus: HistoricalVulnLookupResult['source_status'] = [];
  const mocked = mockMatches(input.scan_config || {}, components);
  if (mocked.length) {
    return { matches: dedupe(mocked), source_status: [{ source: 'mock_intel', ok: true, count: mocked.length, mode: 'scan_config_or_env' }] };
  }

  const mcp = await callMcpVulnIntel(components);
  if (mcp && mcp.matches.length > 0) return { matches: dedupe(mcp.matches), source_status: mcp.source_status };
  if (mcp) sourceStatus.push(...mcp.source_status);

  if (!envFlag('BSTG_INTEL_HTTP_FALLBACK', true)) {
    return { matches: [], source_status: [...sourceStatus, { source: 'http_fallback', ok: false, error: 'disabled' }] };
  }

  const timeoutMs = Number(input.timeout_ms || DEFAULT_TIMEOUT_MS);
  const httpMatches: NormalizedHistoricalVuln[] = [];
  const runSource = async (source: string, fn: () => Promise<NormalizedHistoricalVuln[]>) => {
    try {
      const matches = await fn();
      httpMatches.push(...matches);
      sourceStatus.push({ source, ok: true, count: matches.length });
    } catch (error: any) {
      sourceStatus.push({ source, ok: false, error: error.message || String(error) });
    }
  };

  await runSource('osv', () => queryOsv(components, timeoutMs));
  await runSource('nvd', () => queryNvd(components, timeoutMs));
  await runSource('github_advisory', () => queryGithubAdvisories(components, timeoutMs));
  try {
    const kev = await loadCisaKev(timeoutMs);
    for (const match of httpMatches) {
      if (match.cve_id && kev.has(match.cve_id)) match.cisa_kev = true;
    }
    sourceStatus.push({ source: 'cisa_kev', ok: true, count: kev.size });
  } catch (error: any) {
    sourceStatus.push({ source: 'cisa_kev', ok: false, error: error.message || String(error) });
  }

  return { matches: dedupe(httpMatches), source_status: sourceStatus };
}
