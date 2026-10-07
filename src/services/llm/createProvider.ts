import type { LLMProvider } from '../../domain/contracts';
import { MockLLMProvider } from './MockLLMProvider';
import { ProxyLLMProvider } from './ProxyLLMProvider';

export async function createProvider(): Promise<{ provider: LLMProvider; label: string }> {
  try {
    const response = await fetch('/api/config', { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
    if (!response.ok) throw new Error('配置服务不可用');
    const config: unknown = await response.json();
    if (!config || typeof config !== 'object' || !('mode' in config)) throw new Error('配置格式无效');
    if (config.mode === 'mock') return { provider: new MockLLMProvider(), label: 'Mock · 演示模式' };
    if (config.mode === 'openai-compatible' && 'model' in config && typeof config.model === 'string') {
      return { provider: new ProxyLLMProvider(), label: config.model };
    }
    throw new Error('配置格式无效');
  } catch {
    // Do not silently change a configured real-provider session to fabricated Mock content.
    throw new Error('无法连接本地模型服务。请使用 bun run dev 启动，或检查 bun run start 服务。');
  }
}
