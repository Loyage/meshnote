import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLLMSettings, saveLLMSettings, testLLMSettings, validateDraft, type LLMDraft } from './llmSettings';
const settings = { mode: 'openai-compatible' as const, baseUrl: 'https://api.example/v1', model: 'm', timeoutMs: 120000, hasApiKey: true };
const draft: LLMDraft = { mode: settings.mode, baseUrl: settings.baseUrl, model: settings.model, timeoutMs: settings.timeoutMs };
afterEach(() => vi.unstubAllGlobals());
describe('LLM settings client', () => {
  it('loads only safe metadata and preserves keys by omission', async () => {
    const fetcher = vi.fn(async () => Response.json(settings)); vi.stubGlobal('fetch', fetcher);
    expect(await loadLLMSettings()).toEqual(settings);
    expect(await saveLLMSettings(draft)).toEqual(settings);
    const init = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(init[0]).toBe('/api/settings/llm');
    expect(init[1].method).toBe('PUT');
    expect(JSON.parse(init[1].body as string)).not.toHaveProperty('apiKey');
    expect(init[1].credentials).toBe('same-origin');
  });
  it('tests the draft without saving and requires explicit success', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    await testLLMSettings({ ...draft, apiKey: 'new-key' });
    expect(fetcher).toHaveBeenCalledWith('/api/settings/llm/test', expect.objectContaining({ method: 'POST', body: JSON.stringify({ ...draft, apiKey: 'new-key' }) }));
    fetcher.mockImplementation(async () => Response.json({ ok: false }));
    await expect(testLLMSettings(draft)).rejects.toThrow('连接测试失败');
  });
  it('never displays upstream/body/network secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private-key', { status: 502 })));
    await expect(testLLMSettings(draft)).rejects.toThrow('连接测试失败');
    await expect(saveLLMSettings(draft)).rejects.not.toThrow('private-key');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private-key'); }));
    await expect(loadLLMSettings()).rejects.toThrow('无法连接本机');
  });
  it('rejects invalid metadata and malformed responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...settings, hasApiKey: 'secret' })));
    await expect(loadLLMSettings()).rejects.toThrow('响应格式无效');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json')));
    await expect(saveLLMSettings(draft)).rejects.toThrow('响应格式无效');
  });
  it('validates URL, key preservation/deletion and timeouts', () => {
    expect(validateDraft(draft, true)).toBeNull();
    expect(validateDraft(draft, false)).toContain('需要 API Key');
    expect(validateDraft({ ...draft, clearApiKey: true }, true)).toContain('需要 API Key');
    expect(validateDraft({ ...draft, mode: 'mock', clearApiKey: true }, true)).toBeNull();
    expect(validateDraft({ ...draft, apiKey: 'new-key' }, false)).toBeNull();
    for (const baseUrl of ['file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com?q=key', 'not-url'])
      expect(validateDraft({ ...draft, baseUrl }, true)).not.toBeNull();
    expect(validateDraft({ ...draft, baseUrl: 'https://example.com/v1/chat/completions' }, true)).toContain('/chat/completions');
    for (const timeoutMs of [0, NaN, 600001, 1200.5]) expect(validateDraft({ ...draft, timeoutMs }, true)).not.toBeNull();
    expect(validateDraft({ ...draft, model: ' ' }, true)).not.toBeNull();
    expect(validateDraft({ ...draft, apiKey: 'key\nheader' }, true)).not.toBeNull();
  });
});
