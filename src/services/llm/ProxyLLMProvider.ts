import type { LLMMessage, LLMProvider } from '../../domain/contracts';
import { combineSignal, readLines, safeModelError } from './streams';

export class ProxyLLMProvider implements LLMProvider {
  constructor(private readonly apiBase = '/api', private readonly timeoutMs = 125_000) {}

  private async request(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.apiBase}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(body), signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('模型服务请求失败');
    }
    return response;
  }

  async *chat(messages: LLMMessage[], signal?: AbortSignal): AsyncIterable<string> {
    const combined = combineSignal(signal, this.timeoutMs);
    try {
      const response = await this.request('chat', { messages }, combined);
      if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
        await response.body?.cancel();
        throw new Error('无效模型流');
      }
      for await (const line of readLines(response.body, combined)) {
        if (!line.trim()) continue;
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== 'object' || !('type' in event)) throw new Error('无效模型流');
        if (event.type === 'done') return;
        if (event.type === 'delta' && 'text' in event && typeof event.text === 'string') {
          yield event.text;
        } else {
          // Never display arbitrary server/upstream payloads, even when event.type === 'error'.
          throw new Error('模型流中断');
        }
      }
      throw new Error('模型流未正常结束');
    } catch (error) {
      throw new Error(safeModelError(error, combined));
    }
  }

  private async text(path: string, body: unknown, signal?: AbortSignal): Promise<string> {
    const combined = combineSignal(signal, this.timeoutMs);
    try {
      const response = await this.request(path, body, combined);
      if (!response.body) throw new Error('无效模型响应');
      let raw = '';
      for await (const line of readLines(response.body, combined, 2_000_000)) raw += line;
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string') {
        throw new Error('无效模型响应');
      }
      return data.text;
    } catch (error) {
      throw new Error(safeModelError(error, combined));
    }
  }

  generateTitle(question: string, answer: string, signal?: AbortSignal): Promise<string> {
    return this.text('title', { question, answer }, signal);
  }

  summarize(messages: LLMMessage[], signal?: AbortSignal): Promise<string> {
    return this.text('summarize', { messages }, signal);
  }
}
