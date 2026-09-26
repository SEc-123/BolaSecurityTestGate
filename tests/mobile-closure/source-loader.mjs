// Test-only source loader. Production runs compiled server/dist, never this file.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
let ts;
for (const candidate of [process.env.BSTG_TYPESCRIPT_PATH, '../../server/node_modules/typescript', '../../node_modules/typescript'].filter(Boolean)) {
  try { ts = require(candidate); break; } catch {}
}
if (!ts) { try { ts = require(path.join(execFileSync('npm', ['root','-g'], { encoding: 'utf8', timeout: 5000 }).trim(), 'typescript')); } catch { throw new Error('Install TypeScript or set BSTG_TYPESCRIPT_PATH for source-level tests.'); } }
const adapters = process.env.BSTG_TEST_ADAPTERS === '1';
export async function resolve(specifier, context, nextResolve) {
  if (adapters && ['uuid','better-sqlite3','pg'].includes(specifier)) return { url: new URL(`./adapters/${specifier}.mjs`, import.meta.url).href, shortCircuit: true };
  if (context.parentURL?.startsWith('file:') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
    const candidate = new URL(specifier, context.parentURL);
    if (candidate.protocol === 'file:') {
      const p = fileURLToPath(candidate);
      if (/\.js$/.test(p) && !fs.existsSync(p) && fs.existsSync(p.slice(0,-3)+'.ts')) return { url: pathToFileURL(p.slice(0,-3)+'.ts').href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (/\.tsx?$/.test(url)) {
    const source = fs.readFileSync(fileURLToPath(url), 'utf8');
    const result = ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
    return { format: 'module', source: result.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
