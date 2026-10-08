import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { LLMMessage, LLMProvider } from '../src/domain/contracts';
import { safeModelError } from '../src/services/llm/streams';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import { initialLLMSettings, LLMSettingsManager, publicLLMSettings, resolveDraft, SettingsError, type LLMSettings } from './llmSettings';
import type { ServerConfig } from './config';

const BODY_LIMIT = 1_048_576;
class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messagesFrom(body: Record<string, unknown>): LLMMessage[] {
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 1000) {
    throw new RequestError(400, 'messages 必须包含 1–1000 条消息');
  }
  return body.messages.map(message => {
    if (!isRecord(message) || !['system', 'user', 'assistant'].includes(String(message.role)) ||
        typeof message.content !== 'string' || message.content.length > 200_000) {
      throw new RequestError(400, '消息格式或长度无效');
    }
    return { role: message.role as LLMMessage['role'], content: message.content };
  });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new RequestError(415, '请求必须使用 application/json');
  }
  if (Number(request.headers['content-length']) > BODY_LIMIT) throw new RequestError(413, '请求内容过长');
  const raw = await new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('error', error);
      request.removeListener('aborted', aborted);
    };
    const error = () => { cleanup(); reject(new RequestError(400, '请求读取失败')); };
    const aborted = () => { cleanup(); reject(new RequestError(400, '请求已中断')); };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > BODY_LIMIT) {
        cleanup(); request.resume(); reject(new RequestError(413, '请求内容过长')); return;
      }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolveBody(Buffer.concat(chunks).toString('utf8')); };
    request.on('data', data).on('end', end).on('error', error).on('aborted', aborted);
  });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new RequestError(400, 'JSON 格式无效'); }
  if (!isRecord(body)) throw new RequestError(400, '请求必须是 JSON 对象');
  return body;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

async function serveStatic(request: IncomingMessage, response: ServerResponse, directory: string, pathname: string) {
  let root: string;
  try { root = await realpath(directory); } catch {
    throw new RequestError(503, '前端尚未构建，请先运行 bun run build，开发时请打开 http://127.0.0.1:5173');
  }
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw new RequestError(400, '路径无效'); }
  if (decoded.includes('\0') || decoded.includes('\\')) throw new RequestError(400, '路径无效');
  let filename = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!filename.startsWith(root + sep)) throw new RequestError(403, '路径不可访问');
  try {
    filename = await realpath(filename);
    if (!filename.startsWith(root + sep) || !(await stat(filename)).isFile()) throw new RequestError(404, '文件不存在');
  } catch (error) {
    if (error instanceof RequestError) throw error;
    // Only route-like HTML navigations receive SPA fallback; missing assets stay 404.
    if (extname(decoded) || !request.headers.accept?.includes('text/html')) throw new RequestError(404, '文件不存在');
    try { filename = await realpath(resolve(root, 'index.html')); } catch { throw new RequestError(404, '前端入口不存在'); }
    if (!filename.startsWith(root + sep)) throw new RequestError(403, '路径不可访问');
  }
  response.writeHead(200, {
    'Content-Type': MIME[extname(filename)] ?? 'application/octet-stream',
    'Cache-Control': extname(filename) === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (request.method === 'HEAD') { response.end(); return; }
  await pipeline(createReadStream(filename), response);
}

export function createMeshNoteServer(
  config: ServerConfig,
  options: { distDirectory?: string; provider?: LLMProvider; settings?: LLMSettings; settingsFile?: string } = {},
) {
  // Disk loading is explicitly performed by index.ts, never by ordinary server construction.
  const settingsManager = new LLMSettingsManager(options.settings ?? initialLLMSettings(config), options.settingsFile, options.provider);
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const controller = new AbortController();
    const aborted = () => controller.abort();
    request.once('aborted', aborted);
    response.once('close', aborted);
    const handle = async () => {
      const address = server.address();
      const ports = new Set([5173, config.port, typeof address === 'object' && address ? address.port : config.port]);
      const allowedHosts = new Set([...ports].flatMap(port => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]));
      if (!request.headers.host || !allowedHosts.has(request.headers.host.toLowerCase())) {
        throw new RequestError(403, '只允许本机 Host');
      }
      const origin = request.headers.origin;
      if (request.headers['sec-fetch-site'] === 'cross-site' ||
          (origin !== undefined && ![...allowedHosts].some(host => origin === `http://${host}`))) {
        throw new RequestError(403, '只允许本机同源请求');
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname === '/api/config' && request.method === 'GET') {
        const { settings } = settingsManager.snapshot();
        json(response, 200, { mode: settings.mode, model: settings.mode === 'mock' ? null : settings.model });
        return;
      }
      if (url.pathname === '/api/settings/llm' || url.pathname === '/api/settings/llm/test') {
        const testing = url.pathname.endsWith('/test');
        if (!testing && request.method === 'GET') {
          json(response, 200, publicLLMSettings(settingsManager.snapshot().settings)); return;
        }
        if (request.method !== (testing ? 'POST' : 'PUT')) throw new RequestError(405, '请求方法不支持');
        // Vite preserves the browser Host while proxying. Unlike other APIs, do not accept
        // a different localhost origin/port here. Headerless local CLI clients remain usable.
        const site = request.headers['sec-fetch-site'];
        if ((origin !== undefined && origin !== `http://${request.headers.host.toLowerCase()}`) ||
            (site !== undefined && (site !== 'same-origin' || origin === undefined))) {
          throw new RequestError(403, '配置操作只允许同源请求');
        }
        if (!testing) {
          json(response, 200, await settingsManager.save(readBody(request), controller.signal)); return;
        }
        const snapshot = settingsManager.snapshot().settings;
        const draft = resolveDraft(await readBody(request), snapshot);
        controller.signal.throwIfAborted();
        if (draft.mode === 'mock') {
          json(response, 200, { ok: true, message: 'Mock 演示模式，不访问外部模型' }); return;
        }
        await new OpenAICompatibleProvider(draft).testConnection(controller.signal);
        json(response, 200, { ok: true, message: '模型连接测试成功' }); return;
      }
      if (['/api/chat', '/api/title', '/api/summarize'].includes(url.pathname)) {
        if (request.method !== 'POST') throw new RequestError(405, '此接口只接受 POST');
        // Keep the provider snapshot for the whole request, even if settings are saved mid-flight.
        const { provider } = settingsManager.snapshot();
        const body = await readBody(request);
        controller.signal.throwIfAborted();
        if (url.pathname === '/api/title') {
          if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 50_000 ||
              typeof body.answer !== 'string' || body.answer.length > 200_000) {
            throw new RequestError(400, '标题输入格式或长度无效');
          }
          const text = await provider.generateTitle(body.question, body.answer, controller.signal);
          json(response, 200, { text }); return;
        }
        const messages = messagesFrom(body);
        if (url.pathname === '/api/summarize') {
          const text = await provider.summarize(messages, controller.signal);
          json(response, 200, { text }); return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        for await (const text of provider.chat(messages, controller.signal)) {
          controller.signal.throwIfAborted();
          if (!response.write(JSON.stringify({ type: 'delta', text }) + '\n')) {
            await once(response, 'drain', { signal: controller.signal });
          }
        }
        controller.signal.throwIfAborted();
        response.end(JSON.stringify({ type: 'done' }) + '\n');
        return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/api') throw new RequestError(404, '接口不存在');
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new RequestError(405, '请求方法不支持');
      await serveStatic(request, response, options.distDirectory ?? resolve(process.cwd(), 'dist'), url.pathname);
    };
    void handle().catch(error => {
      if (response.destroyed || response.writableEnded) return;
      request.resume();
      if (response.headersSent) {
        if (response.getHeader('Content-Type')?.toString().includes('application/x-ndjson')) {
          response.end(JSON.stringify({ type: 'error', message: safeModelError(error, controller.signal) }) + '\n');
        } else response.destroy();
      } else if (error instanceof RequestError || error instanceof SettingsError) {
        json(response, error.status, { error: error.message });
      } else {
        json(response, 502, { error: safeModelError(error, controller.signal) });
      }
    }).finally(() => { request.removeListener('aborted', aborted); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
