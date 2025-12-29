#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

interface GateResult {
  decision: 'PASS' | 'WARN' | 'BLOCK';
  exit_code: number;
  test_run_findings: number;
  workflow_findings: number;
  weighted_score: number;
  thresholds_hit: Array<{
    type: string;
    value: number;
    threshold: number;
    operator: string;
    action: string;
  }>;
  artifact_links?: {
    report_url?: string;
  };
  summary?: string;
}

interface RunOptions {
  suite: string;
  env: string;
  git?: string;
  pipeline?: string;
  baseUrl?: string;
  apiKey?: string;
  out?: string;
  report?: boolean;
  failOnWarn?: boolean;
}

async function fetchGateResult(
  baseUrl: string,
  apiKey: string | undefined,
  suite: string,
  env: string,
  git?: string,
  pipeline?: string
): Promise<GateResult> {
  const url = `${baseUrl}/run/gate-by-suite`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({
    suite,
    env,
    git_sha: git,
    pipeline_url: pipeline,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gate API request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const json = await response.json() as { data?: GateResult } & GateResult;
  return json.data || json;
}

function printSummary(result: GateResult) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('           SECURITY GATE RESULT');
  console.log('═══════════════════════════════════════════════════\n');

  console.log(`Decision:          ${getDecisionIcon(result.decision)} ${result.decision}`);
  console.log(`Exit Code:         ${result.exit_code}`);
  console.log(`Weighted Score:    ${result.weighted_score.toFixed(2)}`);
  console.log(`Test Run Findings: ${result.test_run_findings}`);
  console.log(`Workflow Findings: ${result.workflow_findings}`);

  if (result.thresholds_hit && result.thresholds_hit.length > 0) {
    console.log('\nThresholds Triggered:');
    result.thresholds_hit.forEach((threshold) => {
      console.log(`  - ${threshold.type}: ${threshold.value} ${threshold.operator} ${threshold.threshold} → ${threshold.action}`);
    });
  }

  if (result.summary) {
    console.log(`\nSummary: ${result.summary}`);
  }

  console.log('\n═══════════════════════════════════════════════════\n');
}

function getDecisionIcon(decision: string): string {
  switch (decision) {
    case 'PASS':
      return '✓';
    case 'WARN':
      return '⚠';
    case 'BLOCK':
      return '✗';
    default:
      return '?';
  }
}

function writeArtifacts(result: GateResult, outDir: string, generateReport: boolean) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const gateResultPath = path.join(outDir, 'gate-result.json');
  fs.writeFileSync(gateResultPath, JSON.stringify(result, null, 2));
  console.log(`✓ Wrote gate result to: ${gateResultPath}`);

  if (generateReport) {
    const reportPath = path.join(outDir, 'gate-summary.md');
    const reportContent = generateMarkdownReport(result);
    fs.writeFileSync(reportPath, reportContent);
    console.log(`✓ Wrote summary report to: ${reportPath}`);
  }
}

function generateMarkdownReport(result: GateResult): string {
  let md = '# Security Gate Report\n\n';

  md += `## Decision: ${result.decision}\n\n`;
  md += `- **Exit Code**: ${result.exit_code}\n`;
  md += `- **Weighted Score**: ${result.weighted_score.toFixed(2)}\n`;
  md += `- **Test Run Findings**: ${result.test_run_findings}\n`;
  md += `- **Workflow Findings**: ${result.workflow_findings}\n\n`;

  if (result.thresholds_hit && result.thresholds_hit.length > 0) {
    md += '## Thresholds Triggered\n\n';
    result.thresholds_hit.forEach((threshold) => {
      md += `- **${threshold.type}**: ${threshold.value} ${threshold.operator} ${threshold.threshold} → **${threshold.action}**\n`;
    });
    md += '\n';
  }

  if (result.summary) {
    md += `## Summary\n\n${result.summary}\n\n`;
  }

  if (result.artifact_links?.report_url) {
    md += `## Full Report\n\n[View Full Report](${result.artifact_links.report_url})\n`;
  }

  return md;
}

const program = new Command();

program
  .name('sec-runner')
  .description('CLI tool for running security gate checks in CI/CD')
  .version('1.0.0');

program
  .command('run')
  .description('Run security gate check')
  .requiredOption('--suite <suite>', 'Test suite name (e.g., P0, P1)')
  .requiredOption('--env <environment>', 'Environment name (e.g., staging, production)')
  .option('--git <sha>', 'Git commit SHA')
  .option('--pipeline <url>', 'CI pipeline URL')
  .option('--base-url <url>', 'API base URL (default: from SEC_RUNNER_BASE_URL env var)', process.env.SEC_RUNNER_BASE_URL || 'http://localhost:3001/api')
  .option('--api-key <key>', 'API key for authentication (default: from SEC_RUNNER_API_KEY env var)', process.env.SEC_RUNNER_API_KEY)
  .option('--out <directory>', 'Output directory for artifacts (default: ./artifacts)', './artifacts')
  .option('--report', 'Generate markdown report (default: true)', true)
  .option('--fail-on-warn', 'Fail (exit 1) on WARN decision (default: false)', false)
  .action(async (options: RunOptions) => {
    try {
      console.log('Running security gate check...\n');
      console.log(`Suite: ${options.suite}`);
      console.log(`Environment: ${options.env}`);
      if (options.git) console.log(`Git SHA: ${options.git}`);
      if (options.pipeline) console.log(`Pipeline: ${options.pipeline}`);
      console.log('');

      const result = await fetchGateResult(
        options.baseUrl!,
        options.apiKey,
        options.suite,
        options.env,
        options.git,
        options.pipeline
      );

      printSummary(result);

      if (options.out) {
        writeArtifacts(result, options.out, options.report !== false);
      }

      let exitCode = result.exit_code;

      if (options.failOnWarn && result.decision === 'WARN') {
        exitCode = 1;
      } else if (result.decision === 'WARN' && result.exit_code === 0) {
        exitCode = 0;
      }

      process.exit(exitCode);
    } catch (error) {
      console.error('\n✗ Error running security gate check:');
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse(process.argv);
