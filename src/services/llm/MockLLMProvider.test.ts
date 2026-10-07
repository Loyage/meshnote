import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from './MockLLMProvider';

const provider = new MockLLMProvider(0);
describe('MockLLMProvider', () => {
  it('streams multiple chunks and explicitly labels preset content', async () => {
    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: 'user', content: 'Q 和 K 为什么分开？' }])) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join('')).toContain('Mock 演示');
    expect(chunks.join('')).toContain('Query');
  });
  it('handles scaling, positions and unknown questions honestly', async () => {
    for (const [question, expected] of [['sqrt(d)', '方差'], ['位置编码', '顺序'], ['未知问题', '不是对当前问题的真实推理']]) {
      let text = '';
      for await (const chunk of provider.chat([{ role: 'user', content: question }])) text += chunk;
      expect(text).toContain(expected);
    }
  });
  it('generates short titles and marked summaries without a network', async () => {
    expect(await provider.generateTitle('为什么除以 sqrt(d)？', '')).toBe('Attention 为什么缩放');
    expect(Array.from(await provider.generateTitle('一个很长很长很长很长很长很长很长的问题。', '')).length).toBeLessThanOrEqual(15);
    expect(await provider.summarize([{ role: 'user', content: '问题' }])).toContain('Mock 摘要');
  });
  it('supports abort before and during chat/title/summary', async () => {
    const controller = new AbortController();
    const iterator = new MockLLMProvider(1000).chat([{ role: 'user', content: 'x' }], controller.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.generateTitle('x', '', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.summarize([], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
