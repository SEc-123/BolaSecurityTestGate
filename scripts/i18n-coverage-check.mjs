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

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sf) === 'TRANSLATION_ENTRIES' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (!ts.isArrayLiteralExpression(element)) continue;
        const first = element.elements[0];
        if (first && ts.isStringLiteralLike(first)) {
          entries.add(first.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return entries;
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

function main() {
  const catalogEntries = extractCatalogEntries();
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
    highestFrequencyUncovered: frequentUncovered.slice(0, 10).map(([text, locations]) => ({ text, count: locations.length })),
  }, null, 2));
}

main();
