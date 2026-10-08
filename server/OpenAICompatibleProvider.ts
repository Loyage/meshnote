import type { LLMMessage, LLMProvider } from '../src/domain/contracts';
import { combineSignal, readLines, readSSE } from '../src/services/llm/streams';
import type { ServerConfig } from './config';

type Config = Pick<ServerConfig, 'baseUrl' | 'apiKey' | 'model' | 'timeoutMs'>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Server-only: do not import this module from the web entrypoint. */
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly config: Config) {}

  private async request(messages: LLMMessage[], stream: boolean, signal: AbortSignal, maxTokens?: number) {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, messages, stream, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Never retain the response body: gateways may echo credentials and confidential prompts.
      throw new Error(`上游模型请求失败 (HTTP ${response.status})`);
    }
    if (!response.body) throw new Error('上游模型返回空响应');
    return response;
  }

  async *chat(messages: LLMMessage[], signal?: AbortSignal): AsyncIterable<string> {
    const combined = combineSignal(signal, this.config.timeoutMs);
    const response = await this.request(messages, true, combined);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body!.cancel();
      throw new Error('上游模型未返回 SSE 流');
    }
    let hasText = false;
    for await (const event of readSSE(response.body!, combined)) {
      if (event.event === 'error') throw new Error('上游模型报告流错误');
      if (event.data.trim() === '[DONE]') {
        if (!hasText) throw new Error('上游模型没有返回文本');
        return;
      }
      let packet: unknown;
      try { packet = JSON.parse(event.data); } catch { throw new Error('上游模型 SSE 数据无效'); }
      if (!record(packet) || packet.error || !Array.isArray(packet.choices)) throw new Error('上游模型 SSE 数据无效');
      // Usage-only final chunks have an empty choices array.
      const choice: unknown = packet.choices[0];
      if (choice === undefined) continue;
      if (!record(choice)) throw new Error('上游模型 SSE 数据无效');
      if (choice.finish_reason && choice.finish_reason !== 'stop') {
        throw new Error('上游模型未完整回答（长度限制、过滤或不支持的工具调用）');
      }
      if (record(choice.delta)) {
        const content = choice.delta.content;
        if (content != null && typeof content !== 'string') throw new Error('上游模型文本格式不受支持');
        if (typeof content === 'string' && content) { hasText = true; yield content; }
      }
    }
    // A closed TCP/HTTP stream is not evidence of a completed model response.
    throw new Error('上游模型流中断，未收到 [DONE]');
  }

  private async completion(messages: LLMMessage[], signal?: AbortSignal, maxTokens?: number, allowLength = false): Promise<string> {
    const combined = combineSignal(signal, this.config.timeoutMs);
    const response = await this.request(messages, false, combined, maxTokens);
    let raw = '';
    for await (const line of readLines(response.body!, combined)) raw += line;
    let packet: unknown;
    try { packet = JSON.parse(raw); } catch { throw new Error('上游模型响应格式无效'); }
    if (!record(packet) || packet.error || !Array.isArray(packet.choices)) throw new Error('上游模型响应格式无效');
    const choice: unknown = packet.choices[0];
    if (!record(choice) || !record(choice.message) || typeof choice.message.content !== 'string') {
      throw new Error('上游模型响应没有文本');
    }
    if (choice.finish_reason && choice.finish_reason !== 'stop' && !(allowLength && choice.finish_reason === 'length')) {
      throw new Error('上游模型响应不完整');
    }
    const text = choice.message.content.trim();
    if (!text) throw new Error('上游模型响应没有文本');
    return text;
  }

  /** Minimal non-streaming request; discard the response text rather than exposing it. */
  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.completion([{ role: 'user', content: 'Reply OK.' }], signal, 1, true);
  }

  async generateTitle(question: string, answer: string, signal?: AbortSignal): Promise<string> {
    const title = await this.completion([
      { role: 'system', content: '根据下面这次问答，为知识节点生成非常简短的中文标题。要求：5～15 个字左右，表达核心问题，不要“关于”“介绍一下”等无意义前缀，不要句号。只输出标题，不要引号、Markdown 或解释。' },
      { role: 'user', content: `问题：${question}\n\n回答：${answer}` },
    ], signal, 80);
    const clean = title.split(/[\r\n]/)[0].replace(/^[\s#"'“”「」]+|[\s。.!！?？"'“”「」]+$/g, '');
    if (!clean) throw new Error('上游模型标题为空');
    return Array.from(clean).slice(0, 24).join('');
  }

  summarize(messages: LLMMessage[], signal?: AbortSignal): Promise<string> {
    return this.completion([
      { role: 'system', content: '请用简洁的中文总结以下知识探索路径，保留关键结论、不确定性和未解决问题，不要编造原文之外的事实。' },
      ...messages,
    ], signal, 600);
  }
}
