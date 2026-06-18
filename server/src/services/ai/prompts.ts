import type { StandardizedFindingInput } from './types.js';
import type { AIAnalysisInput } from './evidence-builder.js';

export const VERDICT_PROMPT_VERSION = 'v2.0.0';
export const REPORT_PROMPT_VERSION = 'v1.0.0';

function truncateText(s: string, max: number): string {
  if (!max || max <= 0) return '';
  if (s.length <= max) return s;
  return s.substring(0, max) + '\n...[truncated]';
}

function formatHeaders(headers: any, max: number): string {
  const raw = JSON.stringify(headers ?? {}, null, 2);
  return truncateText(raw, max);
}

export function buildVerdictPrompt(input: AIAnalysisInput | StandardizedFindingInput): string {
  const isNewFormat = 'meta' in input;

  if (isNewFormat) {
    return buildVerdictPromptV2(input as AIAnalysisInput);
  } else {
    return buildVerdictPromptV1(input as StandardizedFindingInput);
  }
}

function buildVerdictPromptV2(input: AIAnalysisInput): string {
  return `You are a security vulnerability analyzer. Your task is to determine if the provided evidence represents a real security vulnerability.

CRITICAL DEFINITIONS:
- BASELINE: Expected normal behavior using original parameters (legitimate user's account/data)
- FINDING: Behavior after parameter tampering (attempting to access another user's data or perform unauthorized actions)
- YOU MUST COMPARE baseline vs finding to detect vulnerabilities

STRICT RULES:
1. Output MUST be valid JSON matching the exact schema below
2. Base your judgment ONLY on the evidence provided by comparing BASELINE vs FINDING
3. If evidence is insufficient to make a determination, set is_vulnerability=false and explain why in false_positive_reason
4. Do NOT make assumptions about business logic or API behavior not shown in evidence
5. severity MUST be one of: INFO, LOW, MEDIUM, HIGH, CRITICAL
6. exploit_steps, mitigations, and evidence_citations MUST be arrays of strings
7. evidence_citations MUST reference specific differences between baseline and finding (e.g., "baseline.response.status=403", "finding.response.status=200")

REQUIRED OUTPUT SCHEMA:
{
  "is_vulnerability": boolean,
  "confidence": number (0.0 to 1.0),
  "title": string,
  "category": string,
  "severity": "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "risk_description": string,
  "exploit_steps": string[],
  "impact": string,
  "mitigations": string[],
  "false_positive_reason": string (required if is_vulnerability=false, explain what evidence is missing),
  "key_signals": string[],
  "evidence_citations": string[] (REQUIRED: cite specific baseline vs finding differences)
}

EVIDENCE:
${formatEvidenceV2(input)}

NOTE: ${input.notes.what_is_baseline}
NOTE: ${input.notes.what_is_finding}

Analyze the evidence by comparing BASELINE vs FINDING and output ONLY the JSON object. No additional text before or after.`;
}

function buildVerdictPromptV1(input: StandardizedFindingInput): string {
  return `You are a security vulnerability analyzer. Your task is to determine if the provided evidence represents a real security vulnerability.

STRICT RULES:
1. Output MUST be valid JSON matching the exact schema below
2. Base your judgment ONLY on the evidence provided - do NOT fabricate details
3. If evidence is insufficient, set is_vulnerability=false and explain why in false_positive_reason
4. Do NOT make assumptions about business logic or API behavior not shown in evidence
5. severity MUST be one of: INFO, LOW, MEDIUM, HIGH, CRITICAL
6. exploit_steps and mitigations MUST be arrays of strings

REQUIRED OUTPUT SCHEMA:
{
  "is_vulnerability": boolean,
  "confidence": number (0.0 to 1.0),
  "title": string,
  "category": string,
  "severity": "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "risk_description": string,
  "exploit_steps": string[],
  "impact": string,
  "mitigations": string[],
  "false_positive_reason": string (required if is_vulnerability=false),
  "key_signals": string[],
  "evidence_excerpt": {
    "source_type": "${input.source_type}",
    "template_or_workflow": "${input.template_or_workflow}",
    "baseline_summary": string,
    "mutated_summary": string
  }
}

EVIDENCE:
${formatEvidence(input)}

Analyze the evidence and output ONLY the JSON object. No additional text before or after.`;
}

function formatEvidenceV2(input: AIAnalysisInput): string {
  const maxBodyTestRun = input.config.prompt_max_body_chars_test_run;
  const maxBodyWorkflowStep = input.config.prompt_max_body_chars_workflow_step;
  const maxHeadersTestRun = input.config.prompt_max_headers_chars_test_run;
  const maxHeadersWorkflowStep = input.config.prompt_max_headers_chars_workflow_step;

  let evidence = `Source Type: ${input.meta.source_type}\n`;
  evidence += `Finding ID: ${input.meta.finding_id}\n`;
  evidence += `Run ID: ${input.meta.run_id}\n`;

  if (input.meta.template_name) {
    evidence += `Template: ${input.meta.template_name}\n`;
  }
  if (input.meta.workflow_name) {
    evidence += `Workflow: ${input.meta.workflow_name}\n`;
  }

  evidence += '\n';

  if (input.meta.source_type === 'test_run') {
    if (input.baseline) {
      evidence += `=== BASELINE (Expected Normal Behavior) ===\n`;
      evidence += `Request:\n`;
      evidence += `  Method: ${input.baseline.request.method}\n`;
      evidence += `  URL: ${input.baseline.request.url}\n`;
      evidence += `  Headers: ${formatHeaders(input.baseline.request.headers, maxHeadersTestRun)}\n`;
      if (input.baseline.request.body) {
        evidence += `  Body: ${input.baseline.request.body.substring(0, maxBodyTestRun)}\n`;
      }
      evidence += `\nResponse:\n`;
      evidence += `  Status: ${input.baseline.response.status}\n`;
      evidence += `  Headers: ${formatHeaders(input.baseline.response.headers, maxHeadersTestRun)}\n`;
      evidence += `  Body: ${input.baseline.response.body.substring(0, maxBodyTestRun)}\n\n`;
    }

    if (input.finding) {
      evidence += `=== FINDING (After Parameter Tampering) ===\n`;
      evidence += `Request:\n`;
      evidence += `  Method: ${input.finding.request.method}\n`;
      evidence += `  URL: ${input.finding.request.url}\n`;
      evidence += `  Headers: ${formatHeaders(input.finding.request.headers, maxHeadersTestRun)}\n`;
      if (input.finding.request.body) {
        evidence += `  Body: ${input.finding.request.body.substring(0, maxBodyTestRun)}\n`;
      }
      evidence += `\nResponse:\n`;
      evidence += `  Status: ${input.finding.response.status}\n`;
      evidence += `  Headers: ${formatHeaders(input.finding.response.headers, maxHeadersTestRun)}\n`;
      evidence += `  Body: ${input.finding.response.body.substring(0, maxBodyTestRun)}\n\n`;
    }

    if (input.mutation) {
      evidence += `=== MUTATION INFO ===\n`;
      evidence += `Variables Changed:\n`;
      input.mutation.variables_changed.forEach(v => {
        evidence += `  - ${v.name}: "${v.from}" → "${v.to}"${v.source_account ? ` (from ${v.source_account})` : ''}\n`;
      });
      if (input.mutation.assertion_strategy) {
        evidence += `Assertion Strategy: ${input.mutation.assertion_strategy}\n`;
      }
      if (input.mutation.diff_summary) {
        evidence += `Diff Summary: ${input.mutation.diff_summary}\n`;
      }
      evidence += '\n';
    }
  } else if (input.meta.source_type === 'workflow') {
    if (input.workflow_steps && input.workflow_steps.length > 0) {
      evidence += `=== WORKFLOW STEPS ===\n`;
      input.workflow_steps.forEach((step) => {
        evidence += `\n--- Step ${step.step_index} ---\n`;

        if (step.baseline) {
          evidence += `BASELINE Request:\n`;
          evidence += `  Method: ${step.baseline.request.method}\n`;
          evidence += `  URL: ${step.baseline.request.url}\n`;
          const baselineReqHeadersStr = JSON.stringify(step.baseline.request.headers, null, 2);
          if (baselineReqHeadersStr.length > maxHeadersWorkflowStep) {
            evidence += `  Headers: ${baselineReqHeadersStr.substring(0, maxHeadersWorkflowStep)}...[truncated]\n`;
          } else {
            evidence += `  Headers: ${baselineReqHeadersStr}\n`;
          }
          if (step.baseline.request.body) {
            evidence += `  Body: ${step.baseline.request.body.substring(0, maxBodyWorkflowStep)}\n`;
          }
          evidence += `BASELINE Response:\n`;
          evidence += `  Status: ${step.baseline.response.status}\n`;
          const baselineResHeadersStr = JSON.stringify(step.baseline.response.headers, null, 2);
          if (baselineResHeadersStr.length > maxHeadersWorkflowStep) {
            evidence += `  Headers: ${baselineResHeadersStr.substring(0, maxHeadersWorkflowStep)}...[truncated]\n`;
          } else {
            evidence += `  Headers: ${baselineResHeadersStr}\n`;
          }
          evidence += `  Body: ${step.baseline.response.body.substring(0, maxBodyWorkflowStep)}\n`;
        }

        if (step.finding) {
          evidence += `FINDING Request:\n`;
          evidence += `  Method: ${step.finding.request.method}\n`;
          evidence += `  URL: ${step.finding.request.url}\n`;
          const findingReqHeadersStr = JSON.stringify(step.finding.request.headers, null, 2);
          if (findingReqHeadersStr.length > maxHeadersWorkflowStep) {
            evidence += `  Headers: ${findingReqHeadersStr.substring(0, maxHeadersWorkflowStep)}...[truncated]\n`;
          } else {
            evidence += `  Headers: ${findingReqHeadersStr}\n`;
          }
          if (step.finding.request.body) {
            evidence += `  Body: ${step.finding.request.body.substring(0, maxBodyWorkflowStep)}\n`;
          }
          evidence += `FINDING Response:\n`;
          evidence += `  Status: ${step.finding.response.status}\n`;
          const findingResHeadersStr = JSON.stringify(step.finding.response.headers, null, 2);
          if (findingResHeadersStr.length > maxHeadersWorkflowStep) {
            evidence += `  Headers: ${findingResHeadersStr.substring(0, maxHeadersWorkflowStep)}...[truncated]\n`;
          } else {
            evidence += `  Headers: ${findingResHeadersStr}\n`;
          }
          evidence += `  Body: ${step.finding.response.body.substring(0, maxBodyWorkflowStep)}\n`;
        }
      });
      evidence += '\n';
    }

    if (input.mutation) {
      evidence += `=== MUTATION INFO ===\n`;
      evidence += `Variables Changed:\n`;
      input.mutation.variables_changed.forEach(v => {
        evidence += `  - ${v.name}: "${v.from}" → "${v.to}"${v.source_account ? ` (from ${v.source_account})` : ''}\n`;
      });
      if (input.mutation.assertion_strategy) {
        evidence += `Assertion Strategy: ${input.mutation.assertion_strategy}\n`;
      }
      if (input.mutation.diff_summary) {
        evidence += `Diff Summary: ${input.mutation.diff_summary}\n`;
      }
      evidence += '\n';
    }
  }

  return evidence;
}

function formatEvidence(input: StandardizedFindingInput): string {
  let evidence = `Source Type: ${input.source_type}\n`;
  evidence += `Template/Workflow: ${input.template_or_workflow}\n\n`;

  if (input.source_type === 'test_run') {
    if (input.method && input.path) {
      evidence += `Request: ${input.method} ${input.path}\n`;
    }
    if (input.host) {
      evidence += `Host: ${input.host}\n`;
    }

    if (input.baseline) {
      evidence += `\nBASELINE Response:\n`;
      evidence += `  Status: ${input.baseline.status}\n`;
      evidence += `  Key Fields: ${JSON.stringify(input.baseline.key_fields, null, 2)}\n`;
      evidence += `  Body Excerpt: ${input.baseline.body_excerpt}\n`;
    }

    if (input.mutated) {
      evidence += `\nMUTATED Response:\n`;
      evidence += `  Status: ${input.mutated.status}\n`;
      evidence += `  Key Fields: ${JSON.stringify(input.mutated.key_fields, null, 2)}\n`;
      evidence += `  Body Excerpt: ${input.mutated.body_excerpt}\n`;
    }

    if (input.mutation) {
      evidence += `\nMutation Applied:\n`;
      evidence += `  Variable: ${input.mutation.variable_name}\n`;
      evidence += `  Original Value: ${JSON.stringify(input.mutation.original_value)}\n`;
      evidence += `  Mutated Value: ${JSON.stringify(input.mutation.mutated_value)}\n`;
    }

    if (input.assertion_result) {
      evidence += `\nAssertion Result: ${input.assertion_result}\n`;
    }
  } else if (input.source_type === 'workflow') {
    if (input.workflow_steps && input.workflow_steps.length > 0) {
      evidence += `\nWorkflow Steps:\n`;
      input.workflow_steps.forEach((step) => {
        evidence += `  Step ${step.step_index} [${step.variant || 'unknown'}]: Status ${step.status || 'N/A'}\n`;
        if (step.body_excerpt) {
          evidence += `    Response: ${step.body_excerpt}\n`;
        }
      });
    }

    if (input.extractors) {
      evidence += `\nExtracted Variables:\n`;
      evidence += JSON.stringify(input.extractors, null, 2) + '\n';
    }

    if (input.baseline && input.mutated) {
      evidence += `\nBaseline vs Mutated Difference Detected\n`;
      evidence += `Baseline Status: ${input.baseline.status}\n`;
      evidence += `Mutated Status: ${input.mutated.status}\n`;
    }
  }

  if (input.evidence_signals.length > 0) {
    evidence += `\nKey Signals:\n`;
    input.evidence_signals.forEach(signal => {
      evidence += `  - ${signal}\n`;
    });
  }

  return evidence;
}

export function buildReportPrompt(verdicts: any[]): string {
  return `You are a security report generator. Generate a comprehensive Markdown security report based on the provided vulnerability verdicts.

REQUIREMENTS:
1. Only include vulnerabilities where is_vulnerability=true
2. Group vulnerabilities by severity (CRITICAL, HIGH, MEDIUM, LOW, INFO)
3. For each vulnerability, include:
   - Title and severity
   - Category
   - Risk description
   - Exploit steps (numbered list)
   - Impact
   - Mitigation recommendations (bulleted list)
4. Include an executive summary at the top with statistics
5. Use proper Markdown formatting
6. Be concise but comprehensive

VERDICTS:
${JSON.stringify(verdicts, null, 2)}

Generate the Markdown report now:`;
}
