import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMeshNoteServer } from './app';
import { readConfig, readSettingsFile } from './config';
import { initialLLMSettings, loadLLMSettings, LLMSettingsManager, persistLLMSettings, resolveDraft, type LLMSettings } from './llmSettings';
import { close, listen } from './testHelpers';

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const defaults = initialLLMSettings(readConfig({}));
const draft = { mode: 'mock', baseUrl: defaults.baseUrl, model: defaults.model, timeoutMs: defaults.timeoutMs };
async function filename() {
  const directory = await mkdtemp(resolve('.llm-settings-test-'));
  directories.push(directory);
  return resolve(directory, '.meshnote/llm-settings.json');
}
async function setup(settingsFile?: string, settings = defaults) {
  const server = createMeshNoteServer({ ...readConfig({}), ...settings }, { settings, settingsFile });
  servers.push(server);
  return listen(server);
}
function save(base: string, value: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/settings/llm`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
}
function testDraft(base: string, value: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/settings/llm/test`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
}
async function get(base: string) { return (await fetch(`${base}/api/settings/llm`)).json(); }
function post(base: string, path: string, value: unknown) {
  return fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}
function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

describe('LLM settings HTTP API', () => {
  it('returns only the fixed public shape and retains/clears secrets explicitly', async () => {
    const base = await setup();
    expect(await get(base)).toEqual({ ...draft, hasApiKey: false });
    const real = { ...draft, mode: 'openai-compatible', apiKey: 'secret-key' };
    const response = await save(base, real);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ...draft, mode: 'openai-compatible', hasApiKey: true });
    expect(await (await fetch(`${base}/api/config`)).json()).toEqual({ mode: 'openai-compatible', model: draft.model });
    expect(await (await save(base, { ...draft, model: 'new-model' })).json()).toMatchObject({ mode: 'mock', hasApiKey: true });
    expect(await (await fetch(`${base}/api/config`)).json()).toEqual({ mode: 'mock', model: null });
    expect((await save(base, { ...real, apiKey: undefined })).status).toBe(200);
    expect((await save(base, { ...draft, mode: 'openai-compatible', clearApiKey: true })).status).toBe(400);
    expect(await get(base)).toMatchObject({ hasApiKey: true, mode: 'openai-compatible' });
    expect((await save(base, { ...draft, clearApiKey: true })).status).toBe(200);
    expect(await get(base)).toMatchObject({ hasApiKey: false, mode: 'mock' });
    expect((await save(base, { ...draft, mode: 'openai-compatible' })).status).toBe(400);
  });

  it.each([
    null, [], {}, { ...draft, mode: 'unknown' }, { ...draft, timeoutMs: '1000' },
    { ...draft, timeoutMs: 999 }, { ...draft, timeoutMs: 600001 }, { ...draft, timeoutMs: 1234.5 },
    { ...draft, baseUrl: 'file:///secret' }, { ...draft, baseUrl: 'https://user:secret@example.com' },
    { ...draft, baseUrl: 'https://example.com/?key=secret' }, { ...draft, baseUrl: 'https://example.com/#secret' },
    { ...draft, model: '' }, { ...draft, model: 'model\nsecret' }, { ...draft, model: 'x'.repeat(201) },
    { ...draft, apiKey: '' }, { ...draft, apiKey: null }, { ...draft, apiKey: 'secret\nheader' },
    { ...draft, clearApiKey: 'true' }, { ...draft, apiKey: 'secret', clearApiKey: true },
    { ...draft, unexpected: 'secret' },
  ])('rejects invalid drafts without changing state or leaking inputs: %#', async value => {
    const base = await setup();
    for (const send of [save, testDraft]) {
      const response = await send(base, value);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: expect.any(String) });
      expect(text).not.toContain('secret');
    }
    expect(await get(base)).toEqual({ ...draft, hasApiKey: false });
  });

  it('tests Mock without outbound traffic and never saves drafts', async () => {
    const file = await filename();
    const base = await setup(file);
    const response = await testDraft(base, { ...draft, model: 'unsaved-model', baseUrl: 'http://127.0.0.1:1', apiKey: 'unsaved-key' });
    expect(await response.json()).toEqual({ ok: true, message: expect.stringContaining('不访问外部') });
    expect(await get(base)).toEqual({ ...draft, hasApiKey: false });
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires strict browser same-origin for PUT/test, while preserving existing Host/Origin boundaries', async () => {
    const base = await setup();
    for (const send of [save, testDraft]) {
      const hostileHeaders: Record<string, string>[] = [
        { Origin: 'http://127.0.0.1:5173' }, { Origin: 'null' }, { Origin: 'https://evil.example' },
        { Origin: base, 'Sec-Fetch-Site': 'same-site' }, { Origin: base, 'Sec-Fetch-Site': 'cross-site' },
        { 'Sec-Fetch-Site': 'same-origin' },
      ];
      for (const headers of hostileHeaders) {
        const response = await send(base, draft, headers);
        expect(response.status, JSON.stringify(headers)).toBe(403);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      }
      expect((await send(base, draft, { Origin: base, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
      // Raw HTTP is needed: fetch normalizes Host. Matches Vite changeOrigin:false.
      const rawStatus = (headers: Record<string, string>) => new Promise<number | undefined>((resolveStatus, reject) => {
        const request = httpRequest(`${base}/api/settings/llm${send === testDraft ? '/test' : ''}`, {
          method: send === testDraft ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json', ...headers },
        }, response => {
          expect(response.headers['access-control-allow-origin']).toBeUndefined();
          response.resume(); resolveStatus(response.statusCode);
        });
        request.on('error', reject); request.end(JSON.stringify(draft));
      });
      expect(await rawStatus({ Host: 'evil.example:8787' })).toBe(403);
      expect(await rawStatus({ Host: '127.0.0.1:5173', Origin: 'http://127.0.0.1:5173', 'Sec-Fetch-Site': 'same-origin' })).toBe(200);
    }
    expect((await fetch(`${base}/api/config`, { headers: { Origin: 'http://127.0.0.1:5173' } })).status).toBe(200);
    expect((await fetch(`${base}/api/settings/llm`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/api/settings/llm/test`)).status).toBe(405);
    expect((await save(base, draft, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await save(base, { ...draft, padding: 'x'.repeat(1_048_576) })).status).toBe(413);
    expect((await fetch(`${base}/api/settings/llm`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
  });

  it('uses latest settings for chat/title/summary and tests a separate draft with stored or new credentials', async () => {
    const received: { key: string | undefined; body: Record<string, unknown> }[] = [];
    let fail = false;
    const upstream = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push({ key: request.headers.authorization, body });
      if (fail) { response.writeHead(401); response.end('private-key echoed confidential body'); return; }
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: body.model } }] })}\n\ndata: [DONE]\n\n`);
      } else {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: body.model }, finish_reason: body.max_tokens === 1 ? 'length' : 'stop' }] }));
      }
    });
    servers.push(upstream);
    const url = await listen(upstream);
    const file = await filename();
    const base = await setup(file);
    const real = { ...draft, mode: 'openai-compatible', baseUrl: url, model: 'saved-model', apiKey: 'private-key' };
    expect((await save(base, real)).status).toBe(200);
    const saved = await readFile(file, 'utf8');
    for (const suppliedKey of [undefined, 'draft-key']) {
      const response = await testDraft(base, { ...real, model: 'unsaved-model', apiKey: suppliedKey });
      expect(await response.json()).toEqual({ ok: true, message: expect.any(String) });
      expect(received.at(-1)).toEqual({ key: `Bearer ${suppliedKey ?? 'private-key'}`, body: {
        model: 'unsaved-model', stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK.' }],
      } });
    }
    expect(await readFile(file, 'utf8')).toBe(saved);
    expect(await get(base)).toMatchObject({ model: 'saved-model', hasApiKey: true });
    expect(await (await post(base, 'chat', { messages: [{ role: 'user', content: 'hello' }] })).text()).toContain('saved-model');
    expect(await (await post(base, 'title', { question: 'hello', answer: 'world' })).json()).toEqual({ text: 'saved-model' });
    expect(await (await post(base, 'summarize', { messages: [{ role: 'user', content: 'hello' }] })).json()).toEqual({ text: 'saved-model' });
    expect(received.slice(-3).every(item => item.key === 'Bearer private-key' && item.body.model === 'saved-model')).toBe(true);
    fail = true;
    const failed = await testDraft(base, { ...real, apiKey: undefined });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: '模型请求失败，请检查本地服务的模型配置或稍后重试' });
    expect(await readFile(file, 'utf8')).toBe(saved);
    await save(base, draft);
    const count = received.length;
    expect(await (await post(base, 'chat', { messages: [{ role: 'user', content: 'hello' }] })).text()).toContain('Mock');
    expect(received).toHaveLength(count);
  });

  it('sanitizes malformed, empty, filtered and redirect test responses without following redirects', async () => {
    let mode = 'malformed';
    let redirectedRequests = 0;
    const target = createServer((_request, response) => { redirectedRequests++; response.end('stolen'); });
    servers.push(target);
    const targetUrl = await listen(target);
    const upstream = createServer((request, response) => {
      request.resume();
      if (mode === 'redirect') { response.writeHead(307, { Location: targetUrl }); response.end(); }
      else if (mode === 'malformed') response.end('secret-key invalid JSON');
      else response.end(JSON.stringify({ choices: [{ message: { content: mode === 'empty' ? '' : 'secret-key' }, finish_reason: 'content_filter' }] }));
    });
    servers.push(upstream);
    const url = await listen(upstream);
    const base = await setup();
    for (mode of ['malformed', 'empty', 'filtered', 'redirect']) {
      const response = await testDraft(base, { ...draft, mode: 'openai-compatible', baseUrl: url, apiKey: 'secret-key' });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: '模型请求失败，请检查本地服务的模型配置或稍后重试' });
    }
    expect(redirectedRequests).toBe(0);
    expect(await get(base)).toEqual({ ...draft, hasApiKey: false });
  });

  it('times out a stalled real test and cancels its upstream connection', async () => {
    const closed = deferred<void>();
    const upstream = createServer((request, response) => {
      request.resume(); response.writeHead(200); response.flushHeaders();
      response.once('close', () => closed.resolve());
    });
    servers.push(upstream);
    const url = await listen(upstream);
    const base = await setup();
    const response = await testDraft(base, { ...draft, mode: 'openai-compatible', baseUrl: url, apiKey: 'timeout-key', timeoutMs: 1000 });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: '模型请求失败，请检查本地服务的模型配置或稍后重试' });
    await closed.promise;
    expect(await get(base)).toEqual({ ...draft, hasApiKey: false });
  });

  it('cancels a test when its browser disconnects, without saving the draft', async () => {
    const started = deferred<void>();
    const closed = deferred<void>();
    const upstream = createServer((request, response) => {
      request.resume(); response.writeHead(200); response.flushHeaders();
      response.once('close', () => closed.resolve()); started.resolve();
    });
    servers.push(upstream);
    const url = await listen(upstream);
    const file = await filename();
    const base = await setup(file);
    const controller = new AbortController();
    const pending = fetch(`${base}/api/settings/llm/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ ...draft, mode: 'openai-compatible', baseUrl: url, apiKey: 'abort-key' }),
    });
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await closed.promise;
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['chat', 'title', 'summarize'])('holds the old provider snapshot for an in-flight %s request', async path => {
    const started = deferred<void>();
    const release = deferred<void>();
    const oldKeys: string[] = [];
    const upstream = createServer(async (request, response) => {
      oldKeys.push(request.headers.authorization ?? '');
      request.resume();
      started.resolve();
      await release.promise;
      if (path === 'chat') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: {"choices":[{"delta":{"content":"old-provider"}}]}\n\ndata: [DONE]\n\n');
      } else response.end('{"choices":[{"message":{"content":"old-provider"},"finish_reason":"stop"}]}');
    });
    servers.push(upstream);
    const url = await listen(upstream);
    const base = await setup(undefined, { ...defaults, mode: 'openai-compatible', baseUrl: url, apiKey: 'old-key' });
    const pending = post(base, path, path === 'title' ? { question: 'q', answer: 'a' } : { messages: [{ role: 'user', content: 'q' }] });
    await started.promise;
    expect((await save(base, { ...draft, apiKey: 'new-key' })).status).toBe(200);
    release.resolve();
    expect(await (await pending).text()).toContain('old-provider');
    expect(oldKeys).toEqual(['Bearer old-key']);
    expect(await get(base)).toMatchObject({ mode: 'mock', hasApiKey: true });
  });
});

describe('persistent configuration and serialized commits', () => {
  it('defaults to cwd settings and permits an explicit isolated path only within cwd', () => {
    expect(readSettingsFile({})).toBe(resolve('.meshnote/llm-settings.json'));
    expect(readSettingsFile({ MESHNOTE_SETTINGS_FILE: 'test-results/.meshnote/llm-settings.json' }))
      .toBe(resolve('test-results/.meshnote/llm-settings.json'));
    expect(readSettingsFile({ MESHNOTE_SETTINGS_FILE: resolve('.meshnote/e2e/settings.json') }))
      .toBe(resolve('.meshnote/e2e/settings.json'));
    for (const path of ['../canonical-settings.json', resolve('../outside/settings.json'), '.']) {
      expect(() => readSettingsFile({ MESHNOTE_SETTINGS_FILE: path })).toThrow('必须位于当前工作目录内');
    }
  });

  it('writes the explicitly overridden file and never reads/writes the default configuration', async () => {
    const file = await filename();
    const cwd = resolve(file, '../..');
    const originalFile = readSettingsFile({}, cwd);
    const isolatedFile = readSettingsFile({ MESHNOTE_SETTINGS_FILE: '.meshnote/e2e/llm-settings.json' }, cwd);
    await persistLLMSettings(originalFile, { ...defaults, apiKey: 'original-key', model: 'original-model' });
    const original = await readFile(originalFile, 'utf8');
    const settings = await loadLLMSettings(isolatedFile, () => defaults);
    expect(settings.apiKey).toBe('');
    const base = await setup(isolatedFile, settings);
    expect((await save(base, { ...draft, apiKey: 'isolated-key' })).status).toBe(200);
    expect((await loadLLMSettings(isolatedFile, () => defaults)).apiKey).toBe('isolated-key');
    expect(await readFile(originalFile, 'utf8')).toBe(original);
  });

  it('only bootstraps from environment when absent; atomically writes private files and survives restart', async () => {
    const file = await filename();
    let fallbackCalls = 0;
    const fallback = () => { fallbackCalls++; return defaults; };
    expect(await loadLLMSettings(file, fallback)).toEqual(defaults);
    expect(fallbackCalls).toBe(1);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const base = await setup(file);
    const value = { ...draft, mode: 'openai-compatible', baseUrl: 'http://localhost:1234/v1/', model: ' model ', apiKey: ' persisted-key ' };
    expect((await save(base, value)).status).toBe(200);
    expect((await stat(resolve(file, '..'))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(resolve(file, '..'))).toEqual(['llm-settings.json']);
    const restored = await loadLLMSettings(file, () => { throw new Error('must not read env'); });
    expect(restored).toMatchObject({ mode: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'model', apiKey: 'persisted-key' });
    const restarted = await setup(file, restored);
    expect(await get(restarted)).toMatchObject({ mode: 'openai-compatible', hasApiKey: true, model: 'model' });
    await save(restarted, { ...draft, clearApiKey: true });
    expect(await loadLLMSettings(file, fallback)).toEqual(defaults);
    expect(fallbackCalls).toBe(1);
  });

  it('serializes saves before body completion and resolves omitted keys against the latest successful save', async () => {
    const file = await filename();
    const manager = new LLMSettingsManager(defaults, file);
    const delayed = deferred<unknown>();
    const first = manager.save(delayed.promise);
    const second = manager.save(Promise.resolve({ ...draft, model: 'second', mode: 'openai-compatible' }));
    expect(manager.snapshot().settings.apiKey).toBe('');
    delayed.resolve({ ...draft, apiKey: 'first-key' });
    await Promise.all([first, second]);
    expect(manager.snapshot().settings).toMatchObject({ model: 'second', apiKey: 'first-key' });
    expect(await loadLLMSettings(file, () => defaults)).toMatchObject({ model: 'second', apiKey: 'first-key' });
    expect(Object.isFrozen(manager.snapshot().settings)).toBe(true);
    const clear = manager.save(Promise.resolve({ ...draft, clearApiKey: true }));
    const invalid = manager.save(Promise.resolve({ ...draft, mode: 'openai-compatible' }));
    await clear;
    await expect(invalid).rejects.toThrow('需要 API 密钥');
    expect(manager.snapshot().settings.apiKey).toBe('');
    await manager.save(Promise.resolve({ ...draft, apiKey: 'recovered' }));
    expect((await loadLLMSettings(file, () => defaults)).apiKey).toBe('recovered');
  });

  it('preserves committed state after disk failure and continues processing saves', async () => {
    const file = await filename();
    await mkdir(file, { recursive: true }); // A directory cannot be replaced by a settings file.
    const base = await setup(file, { ...defaults, apiKey: 'existing-key' });
    const response = await save(base, { ...draft, model: 'not-saved', clearApiKey: true });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '模型配置保存失败，当前配置未改变' });
    expect(await get(base)).toEqual({ ...draft, hasApiKey: true });
    expect((await readdir(resolve(file, '..')))).toEqual(['llm-settings.json']);
    await rm(file, { recursive: true });
    expect((await save(base, { ...draft, model: 'recovered' })).status).toBe(200);
    expect((await loadLLMSettings(file, () => defaults)).apiKey).toBe('existing-key');
  });

  it('rejects corrupt files and symlink paths rather than silently using environment or exposing raw errors', async () => {
    const file = await filename();
    await mkdir(resolve(file, '..'));
    for (const raw of ['secret invalid json', '{"apiKey":"secret"}', JSON.stringify({ ...defaults, mode: 'openai-compatible' })]) {
      await writeFile(file, raw);
      await expect(loadLLMSettings(file, () => defaults)).rejects.toThrow('模型配置文件无效或不可读取');
    }
    await rm(file);
    const target = resolve(file, '../target.json');
    await writeFile(target, JSON.stringify(defaults));
    await symlink(target, file);
    await expect(loadLLMSettings(file, () => defaults)).rejects.toThrow('无法读取模型配置文件');
    await rm(resolve(file, '..'), { recursive: true });
    const realDirectory = resolve(file, '../../real');
    await mkdir(realDirectory);
    await symlink(realDirectory, resolve(file, '..'));
    await expect(loadLLMSettings(file, () => defaults)).rejects.toThrow('无法读取模型配置文件');
    await expect(persistLLMSettings(file, defaults)).rejects.toThrow();
    expect(await readdir(realDirectory)).toEqual([]);
  });

  it('does not commit a queued aborted request and recovers after rejected reads', async () => {
    const manager = new LLMSettingsManager(defaults);
    const delayed = deferred<unknown>();
    const first = manager.save(delayed.promise);
    const controller = new AbortController();
    const aborted = manager.save(Promise.resolve({ ...draft, apiKey: 'do-not-save' }), controller.signal);
    const unreadable = manager.save(Promise.reject(new Error('read failed')));
    const rejected = expect(unreadable).rejects.toThrow('read failed');
    const abortedExpectation = expect(aborted).rejects.toThrow();
    controller.abort();
    delayed.resolve(draft);
    await first;
    await abortedExpectation;
    await rejected;
    expect(manager.snapshot().settings.apiKey).toBe('');
    await manager.save(Promise.resolve({ ...draft, model: 'after-failure' }));
    expect(manager.snapshot().settings.model).toBe('after-failure');
  });

  it('validates and normalizes settings without mutating the caller or current snapshot', () => {
    const value = { ...draft, baseUrl: ' https://api.example.com/v1/// ', model: ' model ', apiKey: ' key ' };
    expect(resolveDraft(value, defaults)).toEqual({ ...defaults, baseUrl: 'https://api.example.com/v1', model: 'model', apiKey: 'key' });
    expect(defaults.apiKey).toBe('');
    expect(value.apiKey).toBe(' key ');
  });
});
