import { expect, it } from 'vitest';
import type { LLMProvider } from '../../domain/contracts';
import { RuntimeLLMProvider } from './RuntimeLLMProvider';
function provider(text: string): LLMProvider {
  return { async *chat() { yield text; }, async generateTitle() { return text; }, async summarize() { return text; } };
}
it('changes future calls without replacing in-flight streams', async () => {
  const runtime = new RuntimeLLMProvider(provider('old'));
  const old = runtime.chat([]);
  runtime.replace(provider('new'));
  const collect = async (stream: AsyncIterable<string>) => { let result = ''; for await (const part of stream) result += part; return result; };
  expect(await collect(old)).toBe('old');
  expect(await collect(runtime.chat([]))).toBe('new');
  expect(await runtime.generateTitle('q', 'a')).toBe('new');
  expect(await runtime.summarize([])).toBe('new');
});
