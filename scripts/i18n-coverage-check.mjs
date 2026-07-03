#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import ts from 'typescript';

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, 'src');
const catalogPath = path.join(srcRoot, 'i18n/catalog.ts');
const mainPath = path.join(srcRoot, 'main.tsx');
const layoutPath = path.join(srcRoot, 'components/Layout.tsx');
const feedbackPath = path.join(srcRoot, 'i18n/feedback.ts');
const skipAttributes = /^(className|type|id|key|value|name|href|src|role|htmlFor|colSpan|rowSpan|size|variant|method|target|rel)$/;
const requiredCatalogEntries = [
  'Assessment',
  'Findings',
  'Run History',
  'Reports',
  'Operations console',
  'Primary workflow',
  'System tools',
  'Switch language',
  'Bola Security Test Gate',
  '快速',
  '标准',
  '深度',
  '文件上传',
  '状态机 / 跨包竞态',
];

function fail(message, details) {
  console.error(`[i18n-coverage] ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const itemPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(itemPath));
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      results.push(itemPath);
    }
  }
  return results;
}

function sourceFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function extractCatalogEntries() {
  const sf = sourceFile(catalogPath);
  const entries = new Set();
  const invalid = [];
  const duplicates = [];

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sf) === 'TRANSLATION_ENTRIES' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (!ts.isArrayLiteralExpression(element)) continue;
        const [source, en, zh] = element.elements;
        if (!source || !en || !zh || !ts.isStringLiteralLike(source) || !ts.isStringLiteralLike(en) || !ts.isStringLiteralLike(zh)) {
          invalid.push(element.getText(sf).slice(0, 160));
          continue;
        }
        if (!source.text.trim() || !en.text.trim() || !zh.text.trim()) {
          invalid.push(source.text || element.getText(sf).slice(0, 160));
          continue;
        }
        if (entries.has(source.text)) {
          duplicates.push(source.text);
        }
        entries.add(source.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return { entries, invalid, duplicates };
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function isTextCandidate(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (/^[-+]?\d+(\.\d+)?$/.test(text)) return false;
  if (/^[{}[\]().,;:/*_#|=<>!?&%$@~^-]+$/.test(text)) return false;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(text)) return false;
  return true;
}

function extractVisibleTexts() {
  const texts = new Map();
  const files = walk(srcRoot);

  for (const filePath of files) {
    if (filePath.includes(`${path.sep}i18n${path.sep}`)) continue;
    const sf = sourceFile(filePath);
    const add = (value, node) => {
      const text = normalizeText(value);
      if (!isTextCandidate(text)) return;
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const relative = path.relative(repoRoot, filePath);
      const locations = texts.get(text) || [];
      locations.push(`${relative}:${line}`);
      texts.set(text, locations);
    };

    function visit(node) {
      if (ts.isJsxText(node)) {
        add(node.getText(), node);
      } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const prop = node.name.getText(sf);
        if (!skipAttributes.test(prop)) add(node.initializer.text, node.initializer);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.getText(sf) === 'confirm' &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        add(node.arguments[0].text, node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    }

    visit(sf);
  }

  return texts;
}

function findForbiddenFeedbackCalls() {
  const violations = [];
  for (const filePath of walk(srcRoot)) {
    if (filePath === feedbackPath) continue;
    const sf = sourceFile(filePath);
    function callName(node) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && (expr.text === 'alert' || expr.text === 'confirm')) return expr.text;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'window' &&
        (expr.name.text === 'alert' || expr.name.text === 'confirm')
      ) {
        return `window.${expr.name.text}`;
      }
      return null;
    }
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const name = callName(node);
        if (name) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${path.relative(repoRoot, filePath)}:${line} ${name}()`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return violations;
}

function checkBackendLanguageGuards() {
  const requiredFiles = [
    ['server/src/services/ai/prompts.ts', ['outputLanguageInstruction(language)', 'buildVerdictPrompt(input', 'buildReportPrompt(verdicts']],
    ['server/src/services/finding-evidence.ts', ['outputLanguageInstruction(language)', 'normalizeOutputLanguage(options.language)', "question: options.question || '', language", 'COALESCE(language, ?) = ?']],
    ['server/src/services/ai-scan/ai-planner.ts', ['outputLanguageInstruction(language)', 'normalizeOutputLanguage(run?.language)']],
    ['server/src/services/ai-scan/ai-judge.ts', ['outputLanguageInstruction(language)', 'judgeUploadAttempts', 'language: OutputLanguage']],
    ['server/src/services/ai-scan/ai-generic-judge.ts', ['outputLanguageInstruction(language)', 'judgeGenericAttempts', 'language?: OutputLanguage']],
    ['server/src/routes/ai.ts', ['requestLanguage({ body: req.body', 'buildVerdictPrompt(input, language)', 'buildReportPrompt(verdicts, language)']],
  ];

  const missing = [];
  for (const [relative, snippets] of requiredFiles) {
    const filePath = path.join(repoRoot, relative);
    const source = fs.readFileSync(filePath, 'utf8');
    for (const snippet of snippets) {
      if (!source.includes(snippet)) {
        missing.push(`${relative} missing ${snippet}`);
      }
    }
  }

  const bannedPromptFragments = [
    '请用中文解释',
    'Please use Chinese',
    'Generate a comprehensive Markdown security report based on the provided vulnerability verdicts.\\n\\nREQUIREMENTS:',
  ];
  for (const relative of requiredFiles.map(([relative]) => relative)) {
    const filePath = path.join(repoRoot, relative);
    const source = fs.readFileSync(filePath, 'utf8');
    for (const fragment of bannedPromptFragments) {
      if (fragment.includes('Markdown') && relative === 'server/src/services/ai/prompts.ts') continue;
      if (source.includes(fragment)) {
        missing.push(`${relative} contains hard-coded language fragment: ${fragment}`);
      }
    }
  }

  return missing;
}

function main() {
  const catalogAudit = extractCatalogEntries();
  const catalogEntries = catalogAudit.entries;
  if (catalogAudit.invalid.length > 0) {
    fail('catalog entries must have non-empty source/en/zh strings', catalogAudit.invalid.slice(0, 20).join('\n'));
  }
  if (catalogAudit.duplicates.length > 0) {
    fail('duplicate catalog source entries detected', catalogAudit.duplicates.slice(0, 20).join('\n'));
  }

  for (const entry of requiredCatalogEntries) {
    if (!catalogEntries.has(entry)) {
      fail(`required catalog entry missing: ${entry}`);
    }
  }

  const mainSource = fs.readFileSync(mainPath, 'utf8');
  if (!mainSource.includes('I18nProvider') || !mainSource.includes('I18nDomBridge')) {
    fail('main.tsx must mount I18nProvider and I18nDomBridge');
  }

  const layoutSource = fs.readFileSync(layoutPath, 'utf8');
  if (!layoutSource.includes('data-testid="language-switch"') || !layoutSource.includes('setLanguage')) {
    fail('Layout must expose the visible language switch control');
  }

  const feedbackViolations = findForbiddenFeedbackCalls();
  if (feedbackViolations.length > 0) {
    fail('raw alert/confirm calls are forbidden; use i18nAlert/i18nConfirm', feedbackViolations.slice(0, 40).join('\n'));
  }

  const backendLanguageGuardViolations = checkBackendLanguageGuards();
  if (backendLanguageGuardViolations.length > 0) {
    fail('backend AI/report language guards are incomplete', backendLanguageGuardViolations.join('\n'));
  }

  const visibleTexts = extractVisibleTexts();
  const frequentUncovered = [...visibleTexts.entries()]
    .filter(([text, locations]) => locations.length >= 3 && !catalogEntries.has(text))
    .sort((a, b) => b[1].length - a[1].length);

  if (frequentUncovered.length > 25) {
    fail(
      'too many high-frequency visible texts are outside the i18n catalog',
      frequentUncovered.slice(0, 40).map(([text, locations]) => `${locations.length}x ${text} (${locations[0]})`).join('\n'),
    );
  }

  console.log('[i18n-coverage] passed', JSON.stringify({
    catalogEntries: catalogEntries.size,
    visibleTextCandidates: visibleTexts.size,
    highFrequencyUncovered: frequentUncovered.length,
    rawFeedbackCalls: feedbackViolations.length,
    backendLanguageGuardViolations: backendLanguageGuardViolations.length,
    highestFrequencyUncovered: frequentUncovered.slice(0, 10).map(([text, locations]) => ({ text, count: locations.length })),
  }, null, 2));
}

main();
