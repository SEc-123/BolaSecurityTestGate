#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteProvider } from '../../server/dist/db/sqlite-provider.js';
import { AIScanAgentRuntime } from '../../server/dist/agent/agent-runtime.js';

process.env.BSTG_TARGET_ALLOW_PRIVATE ||= '1';
process.env.BSTG_TARGET_ALLOW_LOCALHOST ||= '1';

function waitForTarget(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('fixture target startup timeout')), 10000);
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      const match = text.match(/historical-vuln-target (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`fixture target exited early with code ${code}`));
    });
  });
}

const target = spawn(process.execPath, [path.resolve('tests/ai-scan/fixtures/historical-vuln-blackbox-target.mjs')], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let db;
try {
  const baseUrl = await waitForTarget(target);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstg-historical-vuln-'));
  const dbPath = path.join(tempDir, 'app.db');
  db = new SqliteProvider('historical-vuln-blackbox', { file: dbPath });
  await db.connect();
  await db.migrate();

  const runtime = new AIScanAgentRuntime(db);
  const repo = runtime.getRepository();
  const run = await repo.createRun({
    base_url: `${baseUrl}/`,
    name: 'Historical vuln blackbox regression',
    selected_vuln_types: ['known_vulnerable_component'],
    scan_config: {
      driving_mode: 'autopilot',
      selected_scope_strategy: 'manual_vulnerability_types',
      account_mode: 'autonomous',
      enable_account_auto_execution: false,
      max_pages: 1,
      max_parallel_agents: 1,
      mock_historical_vulns: [
        {
          source: 'mock_intel',
          source_id: 'CVE-2099-0001',
          cve_id: 'CVE-2099-0001',
          component_name: 'express',
          title: 'Mock Express historical vulnerability with safe black-box POC',
          severity: 'high',
          cvss: 8.8,
          cisa_kev: true,
          affected_versions: ['>= 4.0.0 < 4.18.3'],
          fixed_versions: ['4.18.3'],
          references: ['https://example.test/CVE-2099-0001'],
          match_confidence: 0.96,
          poc_template: {
            preconditions: ['Express version 4.17.1 observed from X-Powered-By header'],
            request_sequence: [
              {
                method: 'GET',
                path: '/__bstg-poc/cve-2099-0001',
              },
            ],
            success_signals: [
              { type: 'status', value: 200 },
              { type: 'body_contains', value: 'BSTG-MOCK-CVE-2099-0001' },
            ],
            failure_signals: [
              { type: 'status', value: 404 },
              { type: 'status', value: 403 },
            ],
            risk_level: 'read_only',
            requires_lab_mode: false,
          },
        },
      ],
    },
  });

  const result = await runtime.run(run.id, { max_steps: 80, max_parallel_agents: 1 });
  const snapshot = result.snapshot;
  const express = snapshot.tech_fingerprints.find(item => item.component_name === 'express');
  const jquery = snapshot.tech_fingerprints.find(item => item.component_name === 'jquery');
  const historical = snapshot.historical_vulns.find(item => item.cve_id === 'CVE-2099-0001');
  const poc = snapshot.poc_executions.find(item => item.historical_vuln_id === historical?.id);
  const knownTasks = snapshot.tasks.filter(item => item.vuln_type === 'known_vulnerable_component');
  const findings = await db.runRawQuery(
    `SELECT id, title, severity, status, notes FROM findings WHERE source_type = ? AND notes LIKE ?`,
    ['ai_scan', '%known_vulnerable_component:CVE-2099-0001%']
  );

  assert.ok(express, 'Express fingerprint should be detected');
  assert.equal(express.version, '4.17.1');
  assert.ok(express.confidence >= 0.9, 'Express fingerprint should be high-confidence');
  assert.ok(jquery, 'jQuery asset fingerprint should be detected');
  assert.equal(jquery.version, '3.5.1');
  assert.ok(historical, 'Mock CVE should be normalized and persisted');
  assert.equal(historical.cisa_kev, true);
  assert.ok(historical.match_confidence >= 0.9, 'Mock CVE match should remain high-confidence');
  assert.ok(poc, 'POC execution should be planned and persisted');
  assert.equal(poc.status, 'confirmed');
  assert.ok(knownTasks.some(item => item.task_type === 'test_known_vulnerable_component'), 'Known vulnerable component task should be expanded');
  assert.equal(findings.length, 1, 'Confirmed known vulnerable component finding should be created');
  assert.equal(findings[0].status, 'confirmed');

  console.log(JSON.stringify({
    ok: true,
    scan_run_id: run.id,
    tech_fingerprints: snapshot.tech_fingerprints.map(item => ({ name: item.component_name, version: item.version, confidence: item.confidence })),
    historical_vulns: snapshot.historical_vulns.map(item => ({ id: item.cve_id || item.source_id, confidence: item.match_confidence, kev: item.cisa_kev })),
    poc_executions: snapshot.poc_executions.map(item => ({ id: item.id, status: item.status, result_summary: item.result_summary })),
    findings,
  }, null, 2));
} catch (error) {
  console.error('[historical-vuln-blackbox] FAILED:', error.message);
  process.exitCode = 1;
} finally {
  if (db) await db.disconnect().catch(() => {});
  target.kill('SIGTERM');
}
