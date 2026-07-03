#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const languageModule = await import(pathToFileURL(path.join(repoRoot, 'server/dist/services/i18n/language.js')).href);
const promptsModule = await import(pathToFileURL(path.join(repoRoot, 'server/dist/services/ai/prompts.js')).href);

const zhInstruction = languageModule.outputLanguageInstruction('zh');
const enInstruction = languageModule.outputLanguageInstruction('en');

assert.match(zhInstruction, /Simplified Chinese/);
assert.match(enInstruction, /English/);
assert.equal(languageModule.normalizeOutputLanguage('zh-CN'), 'zh');
assert.equal(languageModule.normalizeOutputLanguage('en-US'), 'en');

const reportPromptZh = promptsModule.buildReportPrompt([
  {
    is_vulnerability: true,
    confidence: 0.9,
    title: 'Access control bypass',
    category: 'BOLA',
    severity: 'HIGH',
    risk_description: 'Attacker can read another account.',
    exploit_steps: ['Send GET /orders/2 as attacker.'],
    impact: 'Data exposure.',
    mitigations: ['Check object ownership.'],
    false_positive_reason: '',
    key_signals: ['finding.response.status=200'],
    evidence_citations: ['baseline.response.status=403'],
  },
], 'zh');
assert.match(reportPromptZh, /Output language: Simplified Chinese/);
assert.match(reportPromptZh, /Keep machine-readable JSON keys/);

const verdictPromptEn = promptsModule.buildVerdictPrompt({
  source_type: 'test_run',
  template_or_workflow: 'orders-read',
  method: 'GET',
  path: '/orders/2',
  host: 'example.test',
  evidence_signals: ['baseline.response.status=403', 'finding.response.status=200'],
}, 'en');
assert.match(verdictPromptEn, /Output language: English/);
assert.match(verdictPromptEn, /Keep machine-readable JSON keys/);

console.log('[i18n-language-contracts] passed');
