import type { LearningSuggestionPayload, MappingSuggestion, SessionJarSuggestion } from './learning-v2-types.js';

export function detectSessionJarSuggestion(mappings: MappingSuggestion[], source: 'recording' | 'execution' | 'hybrid'): SessionJarSuggestion | null {
  const cookieTargets = new Set<string>();
  const headerTargets = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.toLocation === 'request.cookie') cookieTargets.add(mapping.toPath);
    if (mapping.toLocation === 'request.header' && /authorization|token|cookie|session/i.test(mapping.toPath)) headerTargets.add(mapping.toPath);
  }
  if (cookieTargets.size === 0 && headerTargets.size === 0) return null;
  return {
    cookieMode: cookieTargets.size > 0,
    headerKeys: Array.from(headerTargets),
    bodyJsonPaths: [],
    confidence: cookieTargets.size > 0 ? 0.82 : 0.68,
    reason: cookieTargets.size > 0 ? 'cookie/header propagation detected across steps' : 'auth header propagation detected',
    source,
  };
}

export function conflictWithExistingSessionJar(existing: any, suggestion: SessionJarSuggestion | null) {
  if (!existing || !suggestion) return null;
  const existingHeaders = Array.isArray(existing.header_keys) ? existing.header_keys : [];
  const same = JSON.stringify([...existingHeaders].sort()) === JSON.stringify([...suggestion.headerKeys].sort()) && !!existing.cookie_mode === !!suggestion.cookieMode;
  return same ? null : { reason: 'Existing session jar config differs from learned suggestion', existing };
}
