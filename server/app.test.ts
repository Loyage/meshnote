import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LLMProvider } from '../src/domain/contracts';
import { MemoryWorkspaceRepository } from '../src/repositories/MemoryWorkspaceRepository';
import { MeshApplicationService } from '../src/services/application/MeshApplicationService';
import { MockLLMProvider } from '../src/services/llm/MockLLMProvider';
import { ProxyLLMProvider } from '../src/services/llm/ProxyLLMProvider';
import { createMeshNoteServer } from './app';
import { readConfig } from './config';
import { close, collectText, listen } from './testHelpers';

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const messages = [{ role: 'user' as const, content: 'Q/K/V 是什么？' }];
async function setup(options: { key?: string; provider?: LLMProvider; directory?: string } = {}) {
  const config = readConfig({ MESHNOTE_LLM_API_KEY: options.key ?? '' });
  const server = createMeshNoteServer(config, { provider: options.provider ?? new MockLLMProvider(0), distDirectory: options.directory });
  servers.push(server);
  return listen(server);
}
function post(base: string, path: string, value: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
}

describe('local proxy boundaries', () => {
  it('reports Mock without a key and never exposes credentials/config URLs', async () => {
    const mock = await setup();
    expect(await (await fetch(`${mock}/api/config`)).json()).toEqual({ mode: 'mock', model: null });
    const real = await setup({ key: 'do-not-expose-me' });
    const response = await fetch(`${real}/api/config`);
    expect(await response.json()).toEqual({ mode: 'openai-compatible', model: 'gpt-4o-mini' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('rejects remote Host, foreign/null origins, and cross-site requests', async () => {
    const base = await setup();
    for (const headers of [{ Host: 'evil.example:8787' }, { Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      // Node fetch may normalize forbidden browser headers; use raw HTTP to exercise Host.
      const status = await new Promise<number | undefined>((resolveStatus, reject) => {
        const request = httpRequest(`${base}/api/config`, { headers }, response => {
          response.resume(); resolveStatus(response.statusCode);
        });
        request.on('error', reject); request.end();
      });
      expect(status, JSON.stringify(headers)).toBe(403);
    }
    expect((await fetch(`${base}/api/config`, { headers: { Origin: 'http://127.0.0.1:5173' } })).status).toBe(200);
  });
  it('validates content type, body shape, length, messages and route methods', async () => {
    const base = await setup();
    expect((await fetch(`${base}/api/chat`)).status).toBe(405);
    expect((await fetch(`${base}/api/unknown`)).status).toBe(404);
    expect((await post(base, 'chat', { messages }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(base, 'chat', [])).status).toBe(400);
    expect((await post(base, 'chat', { messages: [{ role: 'tool', content: 'x' }] })).status).toBe(400);
    expect((await post(base, 'chat', { messages: [] })).status).toBe(400);
    expect((await post(base, 'title', { question: '', answer: 'x' })).status).toBe(400);
    expect((await post(base, 'chat', { messages: [{ role: 'user', content: 'x'.repeat(200_001) }] })).status).toBe(400);
    expect((await post(base, 'chat', { messages, padding: 'x'.repeat(1_048_576) })).status).toBe(413);
    expect((await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status).toBe(400);
  });
  it('round-trips browser ProxyLLMProvider streaming, titles and summaries', async () => {
    const base = await setup();
    const provider = new ProxyLLMProvider(`${base}/api`);
    expect(await collectText(provider.chat(messages))).toContain('Mock 演示');
    expect(await provider.generateTitle('为什么除以 sqrt(d)', '')).toBe('Attention 为什么缩放');
    expect(await provider.summarize(messages)).toContain('Mock 摘要');
  });
  it('round-trips a real HTTP SSE upstream through the local proxy to the browser adapter', async () => {
    let shouldTruncate = false;
    const upstream = createServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer server-only-key');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"端到端文本"}}]}\r\n\r\n');
      response.end(shouldTruncate ? '' : 'data: [DONE]\r\n\r\n');
    });
    servers.push(upstream);
    const upstreamBase = await listen(upstream);
    const server = createMeshNoteServer(readConfig({
      MESHNOTE_LLM_BASE_URL: upstreamBase, MESHNOTE_LLM_API_KEY: 'server-only-key',
    }));
    servers.push(server);
    const base = await listen(server);
    const browser = new ProxyLLMProvider(`${base}/api`);
    expect(await collectText(browser.chat(messages))).toBe('端到端文本');
    shouldTruncate = true;
    await expect(collectText(browser.chat(messages))).rejects.toThrow('模型请求失败');
  });
  it('integrates with the parent application lifecycle, including title fallback and stream errors', async () => {
    let failStream = false;
    const provider: LLMProvider = {
      async *chat() { yield '保留的回答'; if (failStream) throw new Error('secret'); },
      async generateTitle() { throw new Error('title failure'); },
      async summarize() { return 'summary'; },
    };
    const base = await setup({ provider });
    const repository = new MemoryWorkspaceRepository();
    const application = await MeshApplicationService.create(repository, new ProxyLLMProvider(`${base}/api`));
    const mesh = await application.createMesh('协议集成');
    const states: string[] = [];
    application.subscribe(() => {
      const node = application.getSnapshot().workspace.nodes.find(item => item.meshId === mesh.id);
      if (node) states.push(node.status);
    });
    await application.ask(mesh.id, null, '第一个问题');
    const root = application.getSnapshot().workspace.nodes.find(node => node.meshId === mesh.id)!;
    expect(states).toEqual(expect.arrayContaining(['pending', 'streaming', 'completed']));
    expect(root).toMatchObject({ title: '第一个问题', status: 'completed', assistantMessage: '保留的回答' });
    failStream = true;
    await application.ask(mesh.id, root.id, '继续追问');
    const branch = application.getSnapshot().workspace.nodes.find(node => node.meshId === mesh.id && node.id !== root.id)!;
    expect(branch).toMatchObject({ status: 'error', assistantMessage: '保留的回答' });
    expect(branch.error).not.toContain('secret');
    expect((await repository.load()).nodes.find(node => node.id === branch.id)?.status).toBe('error');
    expect(application.getSnapshot().workspace.edges).toContainEqual(expect.objectContaining({ sourceNodeId: root.id, targetNodeId: branch.id }));
  });
  it('ignores client URL/model/key fields and strips unknown message fields', async () => {
    let received: unknown;
    const provider: LLMProvider = {
      async *chat(value) { received = value; yield 'ok'; },
      async generateTitle() { return 'title'; }, async summarize() { return 'summary'; },
    };
    const base = await setup({ provider });
    const response = await post(base, 'chat', {
      messages: [{ role: 'user', content: 'q', apiKey: 'malicious' }],
      baseUrl: 'http://evil.example', model: 'evil', apiKey: 'evil',
    });
    expect(await response.text()).toContain('"done"');
    expect(received).toEqual([{ role: 'user', content: 'q' }]);
  });
  it('cleans errors and never sends done after failed partial output', async () => {
    const provider: LLMProvider = {
      async *chat() { yield 'partial'; throw new Error('secret-upstream-body'); },
      async generateTitle() { throw new Error('secret-upstream-body'); },
      async summarize() { throw new Error('secret-upstream-body'); },
    };
    const base = await setup({ provider });
    const response = await post(base, 'chat', { messages });
    const text = await response.text();
    expect(text).toContain('partial');
    expect(text).toContain('"error"');
    expect(text).not.toContain('"done"');
    expect(text).not.toContain('secret-upstream-body');
    const title = await post(base, 'title', { question: 'q', answer: 'a' });
    expect(title.status).toBe(502);
    expect(await title.text()).not.toContain('secret-upstream-body');
    await expect(collectText(new ProxyLLMProvider(`${base}/api`).chat(messages))).rejects.toThrow('模型请求失败');
  });
  it('cancels provider generation when the browser closes its stream', async () => {
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>(resolve => { resolveCancelled = resolve; });
    const provider: LLMProvider = {
      async *chat(_messages, signal) {
        yield 'first';
        await new Promise<void>(resolve => {
          if (signal?.aborted) { resolveCancelled(); resolve(); return; }
          signal?.addEventListener('abort', () => { resolveCancelled(); resolve(); }, { once: true });
        });
        signal?.throwIfAborted();
      },
      async generateTitle() { return 'x'; }, async summarize() { return 'x'; },
    };
    const base = await setup({ provider });
    for await (const text of new ProxyLLMProvider(`${base}/api`).chat(messages)) { expect(text).toBe('first'); break; }
    await cancelled;
  });
  it('serves built assets and SPA routes without exposing traversal or symlink targets', async () => {
    const directory = await mkdtemp(resolve('.llm-test-'));
    directories.push(directory);
    const dist = resolve(directory, 'dist');
    await mkdir(dist);
    await writeFile(resolve(dist, 'index.html'), '<main>MeshNote</main>');
    await writeFile(resolve(dist, 'app.js'), 'export const ok = true;');
    await writeFile(resolve(directory, 'secret.txt'), 'secret');
    await symlink(resolve(directory, 'secret.txt'), resolve(dist, 'link.txt'));
    const base = await setup({ directory: dist });
    expect(await (await fetch(`${base}/`)).text()).toContain('MeshNote');
    expect(await (await fetch(`${base}/mesh/demo`, { headers: { Accept: 'text/html' } })).text()).toContain('MeshNote');
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/missing.js`, { headers: { Accept: 'text/html' } })).status).toBe(404);
    expect((await fetch(`${base}/link.txt`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e%2fsecret.txt`)).status).toBe(403);
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
  });
});

describe('environment configuration', () => {
  it('provides working Mock defaults and trims URLs', () => {
    expect(readConfig({})).toMatchObject({ port: 8787, apiKey: '', baseUrl: 'https://api.openai.com/v1' });
    expect(readConfig({ MESHNOTE_LLM_BASE_URL: 'http://localhost:1234/v1/' }).baseUrl).toBe('http://localhost:1234/v1');
  });
  it.each([
    { MESHNOTE_PORT: '0' }, { MESHNOTE_PORT: 'oops' }, { MESHNOTE_LLM_TIMEOUT_MS: '0' },
    { MESHNOTE_LLM_BASE_URL: 'file:///secret' }, { MESHNOTE_LLM_BASE_URL: 'https://user:password@example.com' },
    { MESHNOTE_LLM_BASE_URL: 'https://example.com/?key=secret' }, { MESHNOTE_LLM_API_KEY: 'key\nheader' },
  ])('rejects invalid configuration', env => { expect(() => readConfig(env)).toThrow(); });
});
