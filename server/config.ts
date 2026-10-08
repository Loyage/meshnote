import { resolve, sep } from 'node:path';

export interface ServerConfig {
  port: number;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** Explicit test/deployment override, confined to the process working directory. */
export function readSettingsFile(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const root = resolve(cwd);
  const filename = resolve(root, env.MESHNOTE_SETTINGS_FILE || '.meshnote/llm-settings.json');
  if (!filename.startsWith(root + sep)) throw new Error('MESHNOTE_SETTINGS_FILE 必须位于当前工作目录内');
  return filename;
}

export function readPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.MESHNOTE_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MESHNOTE_PORT 必须是有效端口');
  return port;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = readPort(env);
  const timeoutMs = Number(env.MESHNOTE_LLM_TIMEOUT_MS ?? '120000');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error('MESHNOTE_LLM_TIMEOUT_MS 必须为 1000–600000');
  }
  const baseUrl = (env.MESHNOTE_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('MESHNOTE_LLM_BASE_URL 不是有效 URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('MESHNOTE_LLM_BASE_URL 仅支持无内嵌凭据、查询和片段的 HTTP(S) URL');
  }
  const model = (env.MESHNOTE_LLM_MODEL || 'gpt-4o-mini').trim();
  if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('MESHNOTE_LLM_MODEL 无效');
  const apiKey = (env.MESHNOTE_LLM_API_KEY || '').trim();
  if (/[\r\n]/.test(apiKey)) throw new Error('MESHNOTE_LLM_API_KEY 无效');
  return { port, baseUrl, apiKey, model, timeoutMs };
}
