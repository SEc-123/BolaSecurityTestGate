#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const apiClientPath = path.join(repoRoot, 'src/lib/api-client.ts');
const content = fs.readFileSync(apiClientPath, 'utf8');

function normalizeRoute(value) {
  return value
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\?.*$/, '')
    .replace(/(?<!\/):param$/, '')
    .replace(/\/+/g, '/');
}

const rawMatches = [...content.matchAll(/['"`]((?:\/api|\/admin)[^'"`]+)['"`]/g)].map((m) => m[1]);
const normalized = [...new Set(rawMatches.map(normalizeRoute))].sort();

const serverPatterns = [
  /^\/api\/dashboard\/summary$/,
  /^\/api\/debug\/last\/:param$/,
  /^\/api\/debug\/last\/:param\/export$/,
  /^\/api\/(environments|accounts|api-templates|failure-pattern-templates|account-binding-templates|security-rules|test-runs|findings|checklists|workflows|workflow-steps|workflow-variable-configs|workflow-extractors|suppression-rules|gate-policies|security-suites|test-run-presets|security-runs|drop-rules)(\/:param)?$/,
  /^\/api\/accounts\/recording-apply-logs$/,
  /^\/api\/workflows\/:param\/(full|steps|variable-configs|extractors|variables|mappings|mutations)$/,
  /^\/api\/workflows\/:param\/(learn|learn-v2|apply-learning-v2)$/,
  /^\/api\/workflows\/:param\/learning-suggestions\/:param$/,
  /^\/api\/workflows\/:param\/mappings\/apply$/,
  /^\/api\/workflows\/:param\/variables\/:param$/,
  /^\/api\/workflows\/:param\/mappings\/:param$/,
  /^\/api\/workflow-steps\/:param\/assertions$/,
  /^\/api\/template-variables\/(search|bulk-update)$/,
  /^\/api\/drop-rules\/preview$/,
  /^\/api\/mutations\/:param$/,
  /^\/api\/governance\/(settings|cleanup)$/,
  /^\/api\/recordings\/(config|sessions|test-run-drafts|publish-logs)$/,
  /^\/api\/recordings\/ops\/(summary|audit-logs|dead-letters)$/,
  /^\/api\/recordings\/ops\/dead-letters\/:param\/(retry|discard)$/,
  /^\/api\/recordings\/sessions\/:param$/,
  /^\/api\/recordings\/sessions\/:param\/(candidates|finish|regenerate|account-draft|account-preview|apply-account|export\/raw)$/,
  /^\/api\/recordings\/sessions\/:param\/account-draft\/regenerate$/,
  /^\/api\/recordings\/sessions\/:param\/publish-account$/,
  /^\/api\/recordings\/sessions\/:param\/events$/,
  /^\/api\/recordings\/sessions\/:param\/events\/batch$/,
  /^\/api\/recordings\/sessions\/:param\/api-test-drafts$/,
  /^\/api\/recordings\/workflow-drafts\/:param$/,
  /^\/api\/recordings\/workflow-drafts\/:param\/publish$/,
  /^\/api\/recordings\/test-run-drafts\/:param$/,
  /^\/api\/recordings\/test-run-drafts\/:param\/(template|publish|test-run)$/,
  /^\/api\/recordings\/api-test-drafts\/:param$/,
  /^\/api\/recordings\/api-test-drafts\/:param\/(publish|publish-and-run)$/,
  /^\/api\/run\/(template|workflow|suite|preset|gate|gate-by-suite)$/,
  /^\/api\/dictionary(\/:param)?$/,
  /^\/api\/ai\/(providers|analyses|reports)$/,
  /^\/api\/ai\/providers\/:param$/,
  /^\/api\/ai\/providers\/:param\/test$/,
  /^\/api\/ai\/(analyze-run|generate-report)$/,
  /^\/api\/ai\/reports\/:param\/export$/,
  /^\/api\/security-suites\/:param\/bundle$/,
  /^\/admin\/db\/(status|profiles|test-connection|migrate|switch|export|import)$/,
  /^\/admin\/db\/profiles\/:param$/,
];

const unmatched = normalized.filter((route) => !serverPatterns.some((pattern) => pattern.test(route)));
console.log(JSON.stringify({ totalFrontendRoutes: normalized.length, unmatchedCount: unmatched.length, unmatched, routes: normalized }, null, 2));
if (unmatched.length > 0) process.exit(1);
