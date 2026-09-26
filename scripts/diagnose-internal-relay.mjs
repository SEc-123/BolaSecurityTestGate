import { AIClient } from '../server/dist/services/ai/ai-client.js';

const configuredBase = process.env.BUILT_IN_FORGE_API_URL || process.env.OPENAI_API_BASE;
const apiKey = process.env.BUILT_IN_FORGE_API_KEY || process.env.OPENAI_API_KEY;
if (!configuredBase || !apiKey) throw new Error('internal relay environment is unavailable');
const base = configuredBase.replace(/\/+$/, '');
const provider = {
  id: 'internal-agent-relay-diagnostic',
  provider_type: 'openai_compat',
  base_url: base.endsWith('/v1') ? base : `${base}/v1`,
  api_key: apiKey,
  model: process.env.BSTG_INTERNAL_AGENT_MODEL || 'gpt-5-mini',
};
const client = new AIClient(provider);
const response = await client.chat({
  model: provider.model,
  messages: [{ role: 'user', content: 'Return strict JSON with one key: status, value: ok.' }],
  temperature: 0,
  max_tokens: 80,
}, { scan_run_id: 'diagnostic-run', task_id: 'diagnostic-task' });
console.log(JSON.stringify({ keys: Object.keys(response || {}), response_type: typeof response, choices_type: typeof response?.choices, choices_length: Array.isArray(response?.choices) ? response.choices.length : null, raw_json: JSON.stringify(response || {}).slice(0, 2000) }, null, 2));
