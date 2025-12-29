import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbManager } from '../db/db-manager.js';
import { dbAll, dbGet, dbRun } from '../db/sql-helpers.js';
import { AIClient } from '../services/ai/ai-client.js';
import { InputStandardizer } from '../services/ai/input-standardizer.js';
import { EvidenceBuilder, type EvidenceBuilderOptions } from '../services/ai/evidence-builder.js';
import { computeInputHash } from '../services/ai/hash.js';
import { buildVerdictPrompt, buildReportPrompt, VERDICT_PROMPT_VERSION, REPORT_PROMPT_VERSION } from '../services/ai/prompts.js';
import type { AIProvider, AIVerdict, SeverityLevel } from '../services/ai/types.js';

const router = express.Router();

const toDbBool = (dbKind: string, v: boolean) => (dbKind === 'sqlite' ? (v ? 1 : 0) : v);
const fromDbBool = (dbKind: string, v: any) => (dbKind === 'sqlite' ? v === 1 : !!v);

router.get('/providers', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const providers = await dbAll<any>(
      db,
      'SELECT id, name, provider_type, base_url, model, is_enabled, is_default, created_at, updated_at FROM ai_providers ORDER BY created_at DESC'
    );

    const normalized = providers.map(p => ({
      ...p,
      is_enabled: fromDbBool(db.kind, p.is_enabled),
      is_default: fromDbBool(db.kind, p.is_default)
    }));

    res.json(normalized);
  } catch (error) {
    console.error('Error fetching providers:', error);
    res.status(500).json({ error: 'Failed to fetch providers' });
  }
});

router.get('/providers/:id', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const provider = await dbGet<any>(
      db,
      'SELECT id, name, provider_type, base_url, model, is_enabled, is_default, created_at, updated_at FROM ai_providers WHERE id = ?',
      [req.params.id]
    );

    if (!provider) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const normalized = {
      ...provider,
      is_enabled: fromDbBool(db.kind, provider.is_enabled),
      is_default: fromDbBool(db.kind, provider.is_default)
    };

    res.json(normalized);
  } catch (error) {
    console.error('Error fetching provider:', error);
    res.status(500).json({ error: 'Failed to fetch provider' });
  }
});

router.post('/providers', async (req, res) => {
  try {
    const { name, provider_type, base_url, api_key, model, is_enabled, is_default } = req.body;

    if (!name || !provider_type || !api_key || !model) {
      return res.status(400).json({ error: 'Missing required fields: name, provider_type, api_key, model' });
    }

    const validTypes = ['openai', 'deepseek', 'qwen', 'llama', 'openai_compat'];
    if (!validTypes.includes(provider_type)) {
      return res.status(400).json({ error: 'Invalid provider_type' });
    }

    const db = dbManager.getActive();

    if (is_default) {
      await dbRun(db, `UPDATE ai_providers SET is_default = ${toDbBool(db.kind, false)}`);
    }

    const id = uuidv4();
    await dbRun(
      db,
      `INSERT INTO ai_providers (id, name, provider_type, base_url, api_key, model, is_enabled, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        provider_type,
        base_url || null,
        api_key,
        model,
        toDbBool(db.kind, is_enabled !== false),
        toDbBool(db.kind, is_default || false)
      ]
    );

    const provider = await dbGet<any>(
      db,
      'SELECT id, name, provider_type, base_url, model, is_enabled, is_default, created_at, updated_at FROM ai_providers WHERE id = ?',
      [id]
    );

    const normalized = provider ? {
      ...provider,
      is_enabled: fromDbBool(db.kind, provider.is_enabled),
      is_default: fromDbBool(db.kind, provider.is_default)
    } : null;

    res.status(201).json(normalized);
  } catch (error) {
    console.error('Error creating provider:', error);
    res.status(500).json({ error: 'Failed to create provider' });
  }
});

router.put('/providers/:id', async (req, res) => {
  try {
    const { name, provider_type, base_url, api_key, model, is_enabled, is_default } = req.body;

    const db = dbManager.getActive();
    const existing = await dbGet<any>(db, 'SELECT id FROM ai_providers WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    if (is_default) {
      await dbRun(db, `UPDATE ai_providers SET is_default = ${toDbBool(db.kind, false)}`);
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (provider_type !== undefined) {
      updates.push('provider_type = ?');
      values.push(provider_type);
    }
    if (base_url !== undefined) {
      updates.push('base_url = ?');
      values.push(base_url || null);
    }
    if (api_key !== undefined) {
      updates.push('api_key = ?');
      values.push(api_key);
    }
    if (model !== undefined) {
      updates.push('model = ?');
      values.push(model);
    }
    if (is_enabled !== undefined) {
      updates.push('is_enabled = ?');
      values.push(toDbBool(db.kind, is_enabled));
    }
    if (is_default !== undefined) {
      updates.push('is_default = ?');
      values.push(toDbBool(db.kind, is_default));
    }

    if (db.kind === 'sqlite') {
      updates.push('updated_at = CURRENT_TIMESTAMP');
    } else {
      updates.push('updated_at = now()');
    }

    values.push(req.params.id);

    await dbRun(
      db,
      `UPDATE ai_providers SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    const provider = await dbGet<any>(
      db,
      'SELECT id, name, provider_type, base_url, model, is_enabled, is_default, created_at, updated_at FROM ai_providers WHERE id = ?',
      [req.params.id]
    );

    const normalized = provider ? {
      ...provider,
      is_enabled: fromDbBool(db.kind, provider.is_enabled),
      is_default: fromDbBool(db.kind, provider.is_default)
    } : null;

    res.json(normalized);
  } catch (error) {
    console.error('Error updating provider:', error);
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

router.delete('/providers/:id', async (req, res) => {
  try {
    const db = dbManager.getActive();
    await dbRun(db, 'DELETE FROM ai_providers WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting provider:', error);
    res.status(500).json({ error: 'Failed to delete provider' });
  }
});

router.post('/providers/:id/test', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const provider = await dbGet<AIProvider>(
      db,
      'SELECT * FROM ai_providers WHERE id = ?',
      [req.params.id]
    );

    if (!provider) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const normalizedProvider = {
      ...provider,
      is_enabled: fromDbBool(db.kind, provider.is_enabled),
      is_default: fromDbBool(db.kind, provider.is_default)
    };

    const client = new AIClient(normalizedProvider as AIProvider);
    const result = await client.testConnection();

    res.json(result);
  } catch (error) {
    console.error('Error testing connection:', error);
    res.status(500).json({
      ok: false,
      error_message: (error as Error).message
    });
  }
});

router.post('/analyze-run', async (req, res) => {
  try {
    const { run_id, provider_id, options } = req.body;

    if (!run_id || !provider_id) {
      return res.status(400).json({ error: 'Missing required fields: run_id, provider_id' });
    }

    const db = dbManager.getActive();
    const provider = await dbGet<any>(
      db,
      `SELECT * FROM ai_providers WHERE id = ? AND is_enabled = ${toDbBool(db.kind, true)}`,
      [provider_id]
    );

    if (!provider) {
      return res.status(404).json({ error: 'Provider not found or disabled' });
    }

    const normalizedProvider = {
      ...provider,
      is_enabled: fromDbBool(db.kind, provider.is_enabled),
      is_default: fromDbBool(db.kind, provider.is_default)
    };

    const only_unsuppressed = options?.only_unsuppressed !== false;
    const max_findings = options?.max_findings || 200;

    if (options) {
      if (options.prompt_max_body_chars_test_run && (options.prompt_max_body_chars_test_run < 0 || options.prompt_max_body_chars_test_run > 2000000)) {
        return res.status(400).json({ error: 'prompt_max_body_chars_test_run must be between 0 and 2000000' });
      }
      if (options.prompt_max_body_chars_workflow_step && (options.prompt_max_body_chars_workflow_step < 0 || options.prompt_max_body_chars_workflow_step > 2000000)) {
        return res.status(400).json({ error: 'prompt_max_body_chars_workflow_step must be between 0 and 2000000' });
      }
      if (options.prompt_max_headers_chars_test_run && (options.prompt_max_headers_chars_test_run < 0 || options.prompt_max_headers_chars_test_run > 2000000)) {
        return res.status(400).json({ error: 'prompt_max_headers_chars_test_run must be between 0 and 2000000' });
      }
      if (options.prompt_max_headers_chars_workflow_step && (options.prompt_max_headers_chars_workflow_step < 0 || options.prompt_max_headers_chars_workflow_step > 2000000)) {
        return res.status(400).json({ error: 'prompt_max_headers_chars_workflow_step must be between 0 and 2000000' });
      }
      if (options.max_steps && (options.max_steps < 0 || options.max_steps > 100)) {
        return res.status(400).json({ error: 'max_steps must be between 0 and 100' });
      }
    }

    let query = `SELECT * FROM findings WHERE (test_run_id = ? OR security_run_id = ?)`;
    const params: any[] = [run_id, run_id];

    if (only_unsuppressed) {
      query += ` AND is_suppressed = ${toDbBool(db.kind, false)}`;
    }

    query += ' LIMIT ?';
    params.push(max_findings);

    const findings = await dbAll<any>(db, query, params);

    if (findings.length === 0) {
      return res.json({
        completed: 0,
        failed: 0,
        skipped: 0,
        message: 'No findings to analyze'
      });
    }

    const client = new AIClient(normalizedProvider as AIProvider);

    const builderOptions: EvidenceBuilderOptions = {
      redaction_enabled: options?.redaction_enabled ?? false,
      include_all_steps: options?.include_all_steps ?? true,
      key_steps_only: options?.key_steps_only ?? false,
      key_steps_limit: options?.key_steps_limit ?? 5,
      max_steps: options?.max_steps ?? 0,
      max_body_chars: options?.max_body_chars ?? 2000000,
      max_headers_chars: options?.max_headers_chars ?? 200000,
      prompt_max_body_chars_test_run: options?.prompt_max_body_chars_test_run ?? 50000,
      prompt_max_body_chars_workflow_step: options?.prompt_max_body_chars_workflow_step ?? 10000,
      prompt_max_headers_chars_test_run: options?.prompt_max_headers_chars_test_run ?? 50000,
      prompt_max_headers_chars_workflow_step: options?.prompt_max_headers_chars_workflow_step ?? 20000,
    };
    const evidenceBuilder = new EvidenceBuilder(builderOptions);

    const results = {
      completed: 0,
      failed: 0,
      skipped: 0
    };

    const require_baseline = options?.require_baseline ?? false;

    const CONCURRENT_LIMIT = 3;
    for (let i = 0; i < findings.length; i += CONCURRENT_LIMIT) {
      const batch = findings.slice(i, i + CONCURRENT_LIMIT);
      const promises = batch.map(finding =>
        analyzeOneFinding(finding, normalizedProvider as AIProvider, client, evidenceBuilder, run_id, db, require_baseline)
      );
      const batchResults = await Promise.allSettled(promises);

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          if (result.value === 'skipped') {
            results.skipped++;
          } else {
            results.completed++;
          }
        } else {
          results.failed++;
          console.error('Analysis failed:', result.reason);
        }
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Error analyzing run:', error);
    res.status(500).json({ error: 'Failed to analyze run' });
  }
});

async function analyzeOneFinding(
  finding: any,
  provider: AIProvider,
  client: AIClient,
  evidenceBuilder: EvidenceBuilder,
  run_id: string,
  db: any,
  require_baseline: boolean
): Promise<string> {
  const input = evidenceBuilder.build(finding);

  if (require_baseline) {
    const hasBaseline = input.meta.source_type === 'test_run'
      ? !!input.baseline
      : (input.workflow_steps && input.workflow_steps.length > 0 && input.workflow_steps.some(s => s.baseline));

    if (!hasBaseline) {
      const id = uuidv4();
      await dbRun(
        db,
        `INSERT INTO ai_analyses (id, run_id, finding_id, provider_id, model, prompt_version, input_hash, result_json, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          run_id,
          finding.id,
          provider.id,
          provider.model,
          VERDICT_PROMPT_VERSION,
          '',
          JSON.stringify({ skipped: true, reason: 'No baseline available (require_baseline=true)' }),
          0
        ]
      );
      return 'skipped';
    }
  }

  const inputHash = computeInputHash(input);

  const existing = await dbGet<any>(
    db,
    'SELECT id FROM ai_analyses WHERE finding_id = ? AND input_hash = ? AND provider_id = ?',
    [finding.id, inputHash, provider.id]
  );

  if (existing) {
    return 'skipped';
  }

  const prompt = buildVerdictPrompt(input);
  const startTime = Date.now();

  let verdict: AIVerdict;
  let retries = 0;
  const MAX_RETRIES = 1;

  const supportsJsonMode = ['openai', 'deepseek'].includes(provider.provider_type);

  while (retries <= MAX_RETRIES) {
    try {
      const chatRequest: any = {
        model: provider.model,
        messages: [
          { role: 'system', content: 'You are a security vulnerability analyzer. Output only valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3
      };

      if (supportsJsonMode) {
        chatRequest.response_format = { type: 'json_object' };
      }

      const response = await client.chat(chatRequest);

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from AI');
      }

      let jsonContent = content;
      if (!supportsJsonMode) {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonContent = jsonMatch[0];
        }
      }

      verdict = JSON.parse(jsonContent);

      if (!validateVerdict(verdict)) {
        throw new Error('Invalid verdict schema');
      }

      const latency = Date.now() - startTime;
      const id = uuidv4();

      const resultJson = db.kind === 'postgres' || db.kind === 'supabase_postgres'
        ? JSON.stringify(verdict)
        : JSON.stringify(verdict);

      await dbRun(
        db,
        `INSERT INTO ai_analyses (id, run_id, finding_id, provider_id, model, prompt_version, input_hash, result_json, tokens_in, tokens_out, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          run_id,
          finding.id,
          provider.id,
          provider.model,
          VERDICT_PROMPT_VERSION,
          inputHash,
          resultJson,
          response.usage?.prompt_tokens || null,
          response.usage?.completion_tokens || null,
          latency
        ]
      );

      return 'completed';
    } catch (error) {
      retries++;
      if (retries > MAX_RETRIES) {
        const id = uuidv4();
        await dbRun(
          db,
          `INSERT INTO ai_analyses (id, run_id, finding_id, provider_id, model, prompt_version, input_hash, result_json, latency_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            run_id,
            finding.id,
            provider.id,
            provider.model,
            VERDICT_PROMPT_VERSION,
            inputHash,
            JSON.stringify({ error: (error as Error).message }),
            Date.now() - startTime
          ]
        );
        throw error;
      }
    }
  }

  return 'failed';
}

function validateVerdict(verdict: any): boolean {
  if (typeof verdict !== 'object' || verdict === null) return false;
  if (typeof verdict.is_vulnerability !== 'boolean') return false;
  if (typeof verdict.confidence !== 'number') return false;
  if (typeof verdict.title !== 'string') return false;
  if (typeof verdict.severity !== 'string') return false;

  const validSeverities = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  if (!validSeverities.includes(verdict.severity)) return false;

  if (!Array.isArray(verdict.exploit_steps)) return false;
  if (!Array.isArray(verdict.mitigations)) return false;
  if (!Array.isArray(verdict.key_signals)) return false;
  if (!Array.isArray(verdict.evidence_citations)) return false;

  return true;
}

router.post('/generate-report', async (req, res) => {
  try {
    const { run_id, provider_id, filters } = req.body;

    if (!run_id || !provider_id) {
      return res.status(400).json({ error: 'Missing required fields: run_id, provider_id' });
    }

    const db = dbManager.getActive();
    const provider = await dbGet<any>(
      db,
      `SELECT * FROM ai_providers WHERE id = ? AND is_enabled = ${toDbBool(db.kind, true)}`,
      [provider_id]
    );

    if (!provider) {
      return res.status(404).json({ error: 'Provider not found or disabled' });
    }

    const normalizedProvider = {
      ...provider,
      is_enabled: fromDbBool(db.kind, provider.is_enabled),
      is_default: fromDbBool(db.kind, provider.is_default)
    };

    const analyses = await dbAll<any>(
      db,
      'SELECT * FROM ai_analyses WHERE run_id = ? AND provider_id = ?',
      [run_id, provider_id]
    );

    if (analyses.length === 0) {
      return res.status(400).json({ error: 'No analyses found for this run' });
    }

    const min_confidence = filters?.min_confidence || 0;
    const include_severities = filters?.include_severities || ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

    const verdicts = analyses
      .map((a: any) => {
        try {
          return typeof a.result_json === 'string' ? JSON.parse(a.result_json) : a.result_json;
        } catch {
          return null;
        }
      })
      .filter((v: any) =>
        v &&
        v.is_vulnerability === true &&
        v.confidence >= min_confidence &&
        include_severities.includes(v.severity)
      );

    if (verdicts.length === 0) {
      return res.status(400).json({ error: 'No vulnerabilities match the filter criteria' });
    }

    const reportMarkdown = await generateMarkdownReport(verdicts, normalizedProvider as AIProvider, new AIClient(normalizedProvider as AIProvider));

    const stats = {
      total_findings: analyses.length,
      vulnerabilities_found: verdicts.length,
      severity_distribution: verdicts.reduce((acc: any, v: any) => {
        acc[v.severity] = (acc[v.severity] || 0) + 1;
        return acc;
      }, {})
    };

    const id = uuidv4();

    const filtersJson = db.kind === 'postgres' || db.kind === 'supabase_postgres'
      ? JSON.stringify(filters || {})
      : JSON.stringify(filters || {});

    const statsJson = db.kind === 'postgres' || db.kind === 'supabase_postgres'
      ? JSON.stringify(stats)
      : JSON.stringify(stats);

    await dbRun(
      db,
      `INSERT INTO ai_reports (id, run_id, provider_id, model, prompt_version, filters, report_markdown, stats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        run_id,
        provider_id,
        normalizedProvider.model,
        REPORT_PROMPT_VERSION,
        filtersJson,
        reportMarkdown,
        statsJson
      ]
    );

    const report = await dbGet<any>(
      db,
      'SELECT * FROM ai_reports WHERE id = ?',
      [id]
    );

    if (report) {
      report.stats = typeof report.stats === 'string' ? JSON.parse(report.stats) : report.stats;
      report.filters = typeof report.filters === 'string' ? JSON.parse(report.filters) : report.filters;
    }

    res.status(201).json(report);
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

async function generateMarkdownReport(verdicts: any[], provider: AIProvider, client: AIClient): Promise<string> {
  const prompt = buildReportPrompt(verdicts);

  try {
    const response = await client.chat({
      model: provider.model,
      messages: [
        { role: 'system', content: 'You are a security report writer. Generate clear, professional Markdown reports.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.5
    });

    return response.choices[0]?.message?.content || 'Failed to generate report';
  } catch (error) {
    console.error('AI report generation failed, using template:', error);
    return generateTemplateReport(verdicts);
  }
}

function generateTemplateReport(verdicts: any[]): string {
  const severityOrder: SeverityLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
  const grouped: Record<SeverityLevel, any[]> = {
    CRITICAL: [],
    HIGH: [],
    MEDIUM: [],
    LOW: [],
    INFO: []
  };

  verdicts.forEach(v => {
    if (grouped[v.severity as SeverityLevel]) {
      grouped[v.severity as SeverityLevel].push(v);
    }
  });

  let markdown = '# Security Vulnerability Report\n\n';
  markdown += '## Executive Summary\n\n';
  markdown += `- **Total Vulnerabilities Found**: ${verdicts.length}\n`;

  for (const severity of severityOrder) {
    if (grouped[severity].length > 0) {
      markdown += `- **${severity}**: ${grouped[severity].length}\n`;
    }
  }

  markdown += '\n---\n\n';

  for (const severity of severityOrder) {
    const items = grouped[severity];
    if (items.length === 0) continue;

    markdown += `## ${severity} Severity Vulnerabilities\n\n`;

    items.forEach((v, idx) => {
      markdown += `### ${idx + 1}. ${v.title}\n\n`;
      markdown += `**Category**: ${v.category}\n\n`;
      markdown += `**Confidence**: ${(v.confidence * 100).toFixed(0)}%\n\n`;
      markdown += `**Risk Description**:\n${v.risk_description}\n\n`;

      if (v.exploit_steps && v.exploit_steps.length > 0) {
        markdown += `**Exploit Steps**:\n`;
        v.exploit_steps.forEach((step: string, i: number) => {
          markdown += `${i + 1}. ${step}\n`;
        });
        markdown += '\n';
      }

      markdown += `**Impact**:\n${v.impact}\n\n`;

      if (v.mitigations && v.mitigations.length > 0) {
        markdown += `**Mitigation Recommendations**:\n`;
        v.mitigations.forEach((mit: string) => {
          markdown += `- ${mit}\n`;
        });
        markdown += '\n';
      }

      markdown += '---\n\n';
    });
  }

  return markdown;
}

router.get('/reports/:id/export', async (req, res) => {
  try {
    const db = dbManager.getActive();
    const report = await dbGet<any>(
      db,
      'SELECT * FROM ai_reports WHERE id = ?',
      [req.params.id]
    );

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const format = req.query.format || 'md';

    if (format !== 'md') {
      return res.status(400).json({ error: 'Only markdown format is supported' });
    }

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="security-report-${report.id}.md"`);
    res.send(report.report_markdown);
  } catch (error) {
    console.error('Error exporting report:', error);
    res.status(500).json({ error: 'Failed to export report' });
  }
});

router.get('/reports', async (req, res) => {
  try {
    const { run_id } = req.query;

    const db = dbManager.getActive();
    let query = 'SELECT * FROM ai_reports';
    const params: any[] = [];

    if (run_id) {
      query += ' WHERE run_id = ?';
      params.push(run_id);
    }

    query += ' ORDER BY created_at DESC';

    const reports = await dbAll<any>(db, query, params);

    const reportsWithStats = reports.map((r: any) => ({
      ...r,
      stats: typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats,
      filters: typeof r.filters === 'string' ? JSON.parse(r.filters) : r.filters
    }));

    res.json(reportsWithStats);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

router.get('/analyses', async (req, res) => {
  try {
    const { run_id, finding_id } = req.query;

    const db = dbManager.getActive();
    let query = 'SELECT * FROM ai_analyses';
    const params: any[] = [];
    const conditions: string[] = [];

    if (run_id) {
      conditions.push('run_id = ?');
      params.push(run_id);
    }

    if (finding_id) {
      conditions.push('finding_id = ?');
      params.push(finding_id);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    const analyses = await dbAll<any>(db, query, params);

    const analysesWithJson = analyses.map((a: any) => ({
      ...a,
      result_json: typeof a.result_json === 'string' ? JSON.parse(a.result_json) : a.result_json
    }));

    res.json(analysesWithJson);
  } catch (error) {
    console.error('Error fetching analyses:', error);
    res.status(500).json({ error: 'Failed to fetch analyses' });
  }
});

export default router;
