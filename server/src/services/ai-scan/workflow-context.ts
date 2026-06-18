import type { AIDiscoveredEndpoint } from './types.js';

function text(e: AIDiscoveredEndpoint): string {
  return `${e.method || ''} ${e.path || ''} ${e.url || ''} ${e.request_summary || ''} ${e.response_summary || ''} ${e.feature_guess || ''}`.toLowerCase();
}

function scoreWorkflowPrecursor(e: AIDiscoveredEndpoint, vulnType: string): number {
  const t = text(e);
  let score = 0;
  if (/csrf|token|nonce|session|sanctum|xsrf/.test(t)) score += 80;
  if (/captcha|verify|otp|send.*code|sms|email.*code|codebefore/.test(t)) score += 70;
  if (/login|signin|auth|oauth|token/.test(t)) score += 65;
  if (/me|profile|userinfo|currentuser/.test(t)) score += 50;
  if (/cart|order|create|store|add|submit|prepare|init/.test(t) && /business_logic|bola_idor|replay_race|state_machine_race/.test(vulnType)) score += 55;
  if (/upload|avatar|media|file/.test(t) && /file_upload|bola_idor/.test(vulnType)) score += 45;
  if (/list|index|search|query/.test(t) && /bola_idor|bfla|file_download/.test(vulnType)) score += 40;
  if (/admin|manage|role|permission/.test(t) && /bfla/.test(vulnType)) score += 50;
  if (e.method.toUpperCase() === 'GET') score += 5;
  return score;
}

function sameFunctionalArea(a: AIDiscoveredEndpoint, b: AIDiscoveredEndpoint): boolean {
  const pa = (a.path || '').split('/').filter(Boolean).slice(0, 2).join('/');
  const pb = (b.path || '').split('/').filter(Boolean).slice(0, 2).join('/');
  if (pa && pb && pa === pb) return true;
  const fa = (a.feature_guess || '').toLowerCase();
  const fb = (b.feature_guess || '').toLowerCase();
  return Boolean(fa && fb && fa === fb);
}

export function buildWorkflowEndpointContext(input: {
  allEndpoints: AIDiscoveredEndpoint[];
  selectedEndpointIds: string[];
  vulnType: string;
  maxPreSteps?: number;
}): AIDiscoveredEndpoint[] {
  const selected = input.selectedEndpointIds
    .map(id => input.allEndpoints.find(endpoint => endpoint.id === id))
    .filter(Boolean) as AIDiscoveredEndpoint[];
  const selectedSet = new Set(selected.map(e => e.id));
  const target = selected[selected.length - 1];
  if (!target) return [];

  const candidates = input.allEndpoints
    .filter(endpoint => !selectedSet.has(endpoint.id))
    .map(endpoint => {
      let score = scoreWorkflowPrecursor(endpoint, input.vulnType);
      if (sameFunctionalArea(endpoint, target)) score += 25;
      return { endpoint, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxPreSteps ?? 2)
    .map(item => item.endpoint);

  const ordered = [...candidates, ...selected];
  const seen = new Set<string>();
  return ordered.filter(endpoint => {
    if (seen.has(endpoint.id)) return false;
    seen.add(endpoint.id);
    return true;
  });
}
