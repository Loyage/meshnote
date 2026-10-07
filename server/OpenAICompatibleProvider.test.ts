import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import { close, collectText, listen } from './testHelpers';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(close)); });
const messages = [{ role: 'user' as const, content: '为什么？' }];
async function setup(handler: RequestListener, timeoutMs = 1000) {
  const server = createServer(handler);
  servers.push(server);
  const baseUrl = await listen(server);
  return new OpenAICompatibleProvider({ baseUrl, apiKey: 'server-secret', model: 'test-model', timeoutMs });
}

describe('OpenAI-compatible upstream protocol', () => {
  it('uses configured credentials/model and decodes fragmented UTF-8 and CRLF SSE', async () => {
    let requestBody = '';
    const provider = await setup((request, response) => {
      expect(request.url).toBe('/chat/completions');
      expect(request.headers.authorization).toBe('Bearer server-secret');
      request.on('data', data => { requestBody += data; });
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const bytes = Buffer.from(': heartbeat\r\ndata: {"choices": [\r\ndata: {"delta": {"content": "中文你好"}}]}\r\n\r\ndata: {"choices": [], "usage": {}}\n\ndata: [DONE]');
        for (const byte of bytes) response.write(Buffer.from([byte]));
        response.end();
      });
    });
    expect(await collectText(provider.chat(messages))).toBe('中文你好');
    expect(JSON.parse(requestBody)).toMatchObject({ model: 'test-model', messages, stream: true });
  });
  it('rejects truncated streams rather than treating EOF as completed', async () => {
    const provider = await setup((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    });
    await expect(collectText(provider.chat(messages))).rejects.toThrow('未收到 [DONE]');
  });
  it.each([
    'event: error\ndata: {"error":"secret"}\n\n',
    'data: {"error":"secret"}\n\n',
    'data: not-json\n\n',
    'data: {"choices":[{"finish_reason":"length","delta":{}}]}\n\n',
    'data: {"choices":[{"delta":{"content":42}}]}\n\n',
  ])('rejects invalid/error SSE without echoing its payload', async input => {
    const provider = await setup((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(input);
    });
    await expect(collectText(provider.chat(messages))).rejects.toThrow();
    await expect(collectText(provider.chat(messages))).rejects.not.toThrow('secret');
  });
  it('rejects upstream HTTP errors and redirects without leaking keys/body', async () => {
    const provider = await setup((_request, response) => {
      response.writeHead(401); response.end('server-secret echoed here');
    });
    await expect(collectText(provider.chat(messages))).rejects.toThrow('HTTP 401');
    await expect(collectText(provider.chat(messages))).rejects.not.toThrow('server-secret');
    const redirect = await setup((_request, response) => { response.writeHead(302, { Location: 'http://127.0.0.1:1/steal' }); response.end(); });
    await expect(collectText(redirect.chat(messages))).rejects.toThrow();
  });
  it('generates titles with a separate non-stream prompt and summarizes', async () => {
    const bodies: { stream: boolean; messages: { content: string }[] }[] = [];
    const provider = await setup((request, response) => {
      let body = '';
      request.on('data', data => { body += data; });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '“注意力为何缩放。”\n多余解释' }, finish_reason: 'stop' }] }));
      });
    });
    expect(await provider.generateTitle('question', 'answer')).toBe('注意力为何缩放');
    expect(bodies[0].stream).toBe(false);
    expect(bodies[0].messages[0].content).toContain('5～15');
    expect(bodies[0].messages[1].content).toContain('answer');
    await provider.summarize(messages);
    expect(bodies[1].messages[0].content).toContain('总结');
  });
  it('rejects incomplete non-stream responses so business title fallback can run', async () => {
    const provider = await setup((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }));
    });
    await expect(provider.generateTitle('q', 'a')).rejects.toThrow('不完整');
  });
  it('aborts stalled upstream reads on timeout', async () => {
    const provider = await setup((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); }, 40);
    await expect(collectText(provider.chat(messages))).rejects.toThrow();
  });
  it('cancels upstream HTTP connection when the caller aborts', async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const provider = await setup((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
      response.on('close', resolveClosed); resolveStarted();
    });
    const controller = new AbortController();
    const pending = collectText(provider.chat(messages, controller.signal));
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await closed;
  });
});
