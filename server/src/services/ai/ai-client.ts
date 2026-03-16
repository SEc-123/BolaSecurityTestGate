import type {
  AIProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ConnectionTestResult
} from './types.js';

const DEFAULT_TIMEOUT = 60000;
const DEFAULT_MAX_RETRIES = 1;

export class AIClient {
  private provider: AIProvider;

  constructor(provider: AIProvider) {
    this.provider = provider;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const response = await this.makeRequest(request);
        return response;
      } catch (error) {
        lastError = error as Error;
        console.error(`AI request attempt ${attempt + 1} failed:`, error);

        if (attempt < DEFAULT_MAX_RETRIES) {
          await this.sleep(1000 * (attempt + 1));
        }
      }
    }

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
        max_tokens: 10
      });

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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.provider.api_key}`
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI provider returned ${response.status}: ${errorText}`);
      }

      const data = await response.json();
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
