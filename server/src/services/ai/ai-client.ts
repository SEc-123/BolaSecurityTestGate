import type {
  AIProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ConnectionTestResult
} from './types.js';
import { sanitizeForAIModel } from '../../agent/model-context-sanitizer.js';
import { agentEventBus } from '../../observability/agent-event-bus.js';
import { assertScanActive, scanAbortSignal, scanPolicyDenial, stopScanForPolicyDenial } from '../ai-scan/run-control.js';

function positiveIntEnv(name: string, fallback?: number): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const DEFAULT_TIMEOUT = positiveIntEnv('BSTG_AI_TIMEOUT_MS', 60000) || 60000;
const MIN_TIMEOUT = positiveIntEnv('BSTG_AI_MIN_TIMEOUT_MS');
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_REASONING_EFFORT = process.env.BSTG_AI_REASONING_EFFORT?.trim();

type WireChatCompletionRequest = Omit<ChatCompletionRequest, 'timeout_ms' | 'max_retries'>;

class AIProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`AI provider returned ${status}: ${body}`);
    this.name = 'AIProviderHttpError';
  }
}

function isProviderPolicyDenial(error: unknown): boolean {
  return error instanceof AIProviderHttpError && /provider_policy_denied|flagged for possible cybersecurity risk|Daybreak access|content_policy_violation/i.test(error.body);
}

function isJsonModeUnsupported(error: unknown): error is AIProviderHttpError {
  if (isProviderPolicyDenial(error)) return false;
  if (!(error instanceof AIProviderHttpError)) return false;
  if (![400, 422].includes(error.status)) return false;
  return /response_format|json_object|json mode|unsupported|not supported|unrecognized|unknown parameter|extra fields/i.test(error.body);
}

function isNonRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof AIProviderHttpError)) return false;
  // An upstream policy denial can arrive through a legacy gateway as HTTP 502.
  // It is never a transport retry or a reason to switch to a native execution policy.
  if (isProviderPolicyDenial(error)) return true;
  if (/input exceeds the maximum length|context_length_exceeded|input_too_large/i.test(error.body)) return true;
  return [400,401,403,404,413,422].includes(error.status);
}

export interface AIChatObservabilityMeta {
  scan_run_id?: string;
  task_id?: string;
  emit_events?: boolean;
}

export class AIClient {
  private provider: AIProvider;

  constructor(provider: AIProvider) {
    this.provider = provider;
  }

  async chat(request: ChatCompletionRequest, meta: AIChatObservabilityMeta = {}): Promise<ChatCompletionResponse> {
    assertScanActive();
    const telemetry = meta.emit_events === false ? null : agentEventBus.beginLLM({
      scan_run_id: meta.scan_run_id,
      task_id: meta.task_id,
      provider_id: this.provider.id,
      model: request.model || this.provider.model,
      request: { model: request.model || this.provider.model, messages: request.messages, response_format: request.response_format, tools: (request as any).tools },
      message_count: request.messages?.length,
    });
    let lastError: Error | null = null;
    const maxRetries = Math.max(0, Number.isFinite(Number(request.max_retries)) ? Number(request.max_retries) : DEFAULT_MAX_RETRIES);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        assertScanActive();
        const response = await this.makeRequest(request);
        assertScanActive();
        telemetry?.succeed(response);
        return response;
      } catch (error) {
        if (scanPolicyDenial()) {
          telemetry?.fail(error);
          assertScanActive();
        }
        lastError = error as Error;
        console.error(`AI request attempt ${attempt + 1} failed:`, error);

        if (isNonRetryableProviderError(error)) break;

        if (attempt < maxRetries) {
          await this.sleep(1000 * (attempt + 1));
        }
      }
    }

    telemetry?.fail(lastError || new Error('AI request failed'));
    throw lastError || new Error('AI request failed');
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const startTime = Date.now();

    try {
      const response = await this.chat({
        model: this.provider.model,
        messages: [
          { role: 'user', content: 'Respond with OK' }
        ],
        max_tokens: 128
      });
      const content = response.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('AI provider returned an empty assistant message');
      }

      return {
        ok: true,
        latency_ms: Date.now() - startTime,
        model: response.model
      };
    } catch (error) {
      return {
        ok: false,
        latency_ms: Date.now() - startTime,
        error_message: (error as Error).message
      };
    }
  }

  private async makeRequest(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/chat/completions`;

    const requestedTimeout = Number.isFinite(Number(request.timeout_ms)) ? Number(request.timeout_ms) : DEFAULT_TIMEOUT;
    const timeoutMs = Math.max(1000, requestedTimeout, MIN_TIMEOUT || 0);
    const { timeout_ms, max_retries, ...wireRequest } = request;
    const requestBody: WireChatCompletionRequest = DEFAULT_REASONING_EFFORT && !wireRequest.reasoning_effort
      ? { ...wireRequest, reasoning_effort: DEFAULT_REASONING_EFFORT }
      : wireRequest;

    try {
      return await this.sendChatCompletion(url, requestBody, timeoutMs);
    } catch (error) {
      assertScanActive();
      if (requestBody.response_format?.type === 'json_object' && isJsonModeUnsupported(error)) {
        const { response_format, ...withoutResponseFormat } = requestBody;
        console.warn('AI provider rejected response_format=json_object; retrying once without response_format.');
        return this.sendChatCompletion(url, withoutResponseFormat, timeoutMs);
      }
      throw error;
    }
  }

  private async sendChatCompletion(
    url: string,
    wireRequest: WireChatCompletionRequest,
    timeoutMs: number
  ): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const safeWireRequest = sanitizeForAIModel(wireRequest) as WireChatCompletionRequest;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.provider.api_key}`
        },
        body: JSON.stringify(safeWireRequest),
        signal: scanAbortSignal(controller.signal)
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new AIProviderHttpError(response.status, errorText);
        if (isProviderPolicyDenial(error)) stopScanForPolicyDenial({ provider_id: this.provider.id, model: wireRequest.model || this.provider.model });
        throw error;
      }

      const data: any = await response.json();
      if (data && typeof data === 'object' && data.error) {
        throw new Error(`AI relay returned an error payload: ${JSON.stringify(data.error).slice(0, 800)}`);
      }
      if (!data || !Array.isArray(data.choices)) {
        throw new Error('AI relay returned no standard choices array');
      }
      if (data.choices.some((choice:any)=>choice?.message?.refusal)) {
        stopScanForPolicyDenial({ provider_id: this.provider.id, model: wireRequest.model || this.provider.model });
        throw new AIProviderHttpError(403,JSON.stringify({error:{code:'provider_policy_denied',message:data.choices.find((choice:any)=>choice?.message?.refusal).message.refusal}}));
      }
      assertScanActive();
      return data as ChatCompletionResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private getBaseUrl(): string {
    if (this.provider.base_url) {
      return this.provider.base_url.replace(/\/$/, '');
    }

    switch (this.provider.provider_type) {
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'deepseek':
        return 'https://api.deepseek.com/v1';
      case 'qwen':
        return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      case 'llama':
        return 'http://localhost:11434/v1';
      case 'openai_compat':
        throw new Error('base_url is required for openai_compat provider type');
      default:
        throw new Error(`Unknown provider type: ${this.provider.provider_type}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
