import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyLLMProvider } from './ProxyLLMProvider';
import { createProvider } from './createProvider';
import { MockLLMProvider } from './MockLLMProvider';

async function collect(stream: AsyncIterable<string>) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('browser proxy protocol', () => {
  it.each([
    '{"type":"delta","text":"partial"}\n',
    '{"type":"error","message":"private-key"}\n',
    'not-json\n',
    '{"type":"unknown"}\n',
    '{"type":"delta","text":4}\n',
  ])('rejects incomplete/invalid/error streams and sanitizes messages', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })));
    await expect(collect(new ProxyLLMProvider().chat([]))).rejects.toThrow('模型请求失败');
    await expect(collect(new ProxyLLMProvider().chat([]))).rejects.not.toThrow('private-key');
  });
  it('accepts final done without newline and split Unicode bytes', async () => {
    const bytes = new TextEncoder().encode('{"type":"delta","text":"你好"}\r\n{"type":"done"}');
    let index = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull(c) {
      if (index === bytes.length) c.close(); else c.enqueue(bytes.slice(index, ++index));
    } }), { headers: { 'Content-Type': 'application/x-ndjson' } })));
    expect(await collect(new ProxyLLMProvider().chat([]))).toBe('你好');
  });
  it('rejects HTTP errors without returning response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private-key', { status: 401 })));
    await expect(new ProxyLLMProvider().generateTitle('q', 'a')).rejects.toThrow('模型请求失败');
    await expect(new ProxyLLMProvider().generateTitle('q', 'a')).rejects.not.toThrow('private-key');
  });
  it('supports cancellation of a stalled browser stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream(), { headers: { 'Content-Type': 'application/x-ndjson' } })));
    const controller = new AbortController();
    const pending = collect(new ProxyLLMProvider().chat([], controller.signal));
    controller.abort();
    await expect(pending).rejects.toThrow('已停止生成');
  });
});

describe('provider composition', () => {
  it('chooses Mock explicitly from safe runtime config', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mode: 'mock', model: null })));
    const runtime = await createProvider();
    expect(runtime.provider).toBeInstanceOf(MockLLMProvider);
    expect(runtime.label).toContain('Mock');
  });
  it('chooses same-origin proxy for configured real models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mode: 'openai-compatible', model: 'local-model' })));
    const runtime = await createProvider();
    expect(runtime.provider).toBeInstanceOf(ProxyLLMProvider);
    expect(runtime.label).toBe('local-model');
  });
  it('does not silently replace unavailable real service with mock', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network unavailable'); }));
    await expect(createProvider()).rejects.toThrow('无法连接本地模型服务');
  });
});
