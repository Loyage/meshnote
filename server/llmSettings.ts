import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../src/domain/contracts';
import { MockLLMProvider } from '../src/services/llm/MockLLMProvider';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import type { ServerConfig } from './config';

export interface LLMSettings {
  mode: 'mock' | 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

export class SettingsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function initialLLMSettings(config: ServerConfig): LLMSettings {
  return { mode: config.apiKey ? 'openai-compatible' : 'mock', baseUrl: config.baseUrl,
    model: config.model, apiKey: config.apiKey, timeoutMs: config.timeoutMs };
}

export function publicLLMSettings(settings: LLMSettings) {
  return { mode: settings.mode, baseUrl: settings.baseUrl, model: settings.model,
    hasApiKey: Boolean(settings.apiKey), timeoutMs: settings.timeoutMs };
}

/** Validate without reflecting values or unknown fields into an error. */
export function resolveDraft(value: unknown, current: LLMSettings): LLMSettings {
  const invalid = (message: string): never => { throw new SettingsError(400, message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('配置必须是 JSON 对象');
  const draft = value as Record<string, unknown>;
  if (Object.keys(draft).some(key => !['mode', 'baseUrl', 'model', 'timeoutMs', 'apiKey', 'clearApiKey'].includes(key))) {
    return invalid('配置包含不支持的字段');
  }
  if (draft.mode !== 'mock' && draft.mode !== 'openai-compatible') return invalid('模型模式无效');
  if (typeof draft.baseUrl !== 'string' || draft.baseUrl.length > 2048) return invalid('base URL 无效');
  let url: URL;
  try { url = new URL(draft.baseUrl.trim()); } catch { return invalid('base URL 无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return invalid('base URL 仅支持无内嵌凭据、查询和片段的 HTTP(S) URL');
  }
  if (typeof draft.model !== 'string' || !draft.model.trim() || draft.model.length > 200 || /[\r\n\x00-\x1f\x7f]/.test(draft.model)) {
    return invalid('模型名称无效');
  }
  if (typeof draft.timeoutMs !== 'number' || !Number.isInteger(draft.timeoutMs) || draft.timeoutMs < 1000 || draft.timeoutMs > 600000) {
    return invalid('超时必须为 1000–600000 毫秒的整数');
  }
  if (draft.clearApiKey !== undefined && typeof draft.clearApiKey !== 'boolean') return invalid('clearApiKey 必须是布尔值');
  if (draft.apiKey !== undefined && (typeof draft.apiKey !== 'string' || !draft.apiKey.trim() ||
      draft.apiKey.length > 8192 || /[\x00-\x1f\x7f]/.test(draft.apiKey))) return invalid('API 密钥无效；删除密钥请使用 clearApiKey');
  if (draft.clearApiKey === true && draft.apiKey !== undefined) return invalid('不能同时设置和删除 API 密钥');
  const apiKey = draft.clearApiKey === true ? '' : typeof draft.apiKey === 'string' ? draft.apiKey.trim() : current.apiKey;
  if (draft.mode === 'openai-compatible' && !apiKey) return invalid('真实模型模式需要 API 密钥');
  return { mode: draft.mode, baseUrl: url.href.replace(/\/+$/, ''), model: draft.model.trim(), apiKey, timeoutMs: draft.timeoutMs };
}

export function settingsProvider(settings: LLMSettings): LLMProvider {
  return settings.mode === 'mock' ? new MockLLMProvider() : new OpenAICompatibleProvider(settings);
}

async function secureDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe settings directory');
  await chmod(directory, 0o700);
}

/** No fallback on corrupt/unreadable files: accidentally replacing a stored key is unsafe. */
export async function loadLLMSettings(filename: string, fallback: () => LLMSettings): Promise<LLMSettings> {
  let handle;
  try {
    const info = await lstat(dirname(filename));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe settings directory');
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw new Error('无法读取模型配置文件');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 32_768) throw new Error('Invalid settings file');
    await chmod(dirname(filename), 0o700);
    await handle.chmod(0o600);
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    // An empty key is valid in a persisted Mock configuration, not in an API draft.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings file');
    const stored = value as Record<string, unknown>;
    if (typeof stored.apiKey !== 'string') throw new Error('Invalid settings file');
    const { apiKey, ...draft } = stored;
    return resolveDraft({ ...draft, ...(apiKey ? { apiKey } : { clearApiKey: true }) }, {
      mode: 'mock', baseUrl: '', model: '', apiKey: '', timeoutMs: 120000,
    });
  } catch {
    throw new Error('模型配置文件无效或不可读取');
  } finally { await handle.close(); }
}

export async function persistLLMSettings(filename: string, settings: LLMSettings): Promise<void> {
  const directory = dirname(filename);
  await secureDirectory(directory);
  const temporary = join(directory, `.llm-settings-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(settings) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** Single-process serial saves: resolve omitted keys against the latest committed state. */
export class LLMSettingsManager {
  private state: { settings: Readonly<LLMSettings>; provider: LLMProvider };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(settings: LLMSettings, private readonly filename?: string, provider?: LLMProvider) {
    const snapshot = Object.freeze({ ...settings });
    this.state = { settings: snapshot, provider: provider ?? settingsProvider(snapshot) };
  }
  snapshot() { return this.state; }
  save(body: Promise<unknown>, signal?: AbortSignal): Promise<ReturnType<typeof publicLLMSettings>> {
    // Handle an early read rejection even while another save is still writing.
    const parsed = body.then(value => ({ value }), error => ({ error }));
    const operation = this.queue.then(async () => {
      const result = await parsed;
      if ('error' in result) throw result.error;
      signal?.throwIfAborted();
      const settings = Object.freeze(resolveDraft(result.value, this.state.settings));
      const provider = settingsProvider(settings);
      if (this.filename) {
        try { await persistLLMSettings(this.filename, settings); }
        catch { throw new SettingsError(500, '模型配置保存失败，当前配置未改变'); }
      }
      this.state = { settings, provider };
      return publicLLMSettings(settings);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
