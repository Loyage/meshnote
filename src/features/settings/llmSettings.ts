export interface LLMSettings {
  mode: 'mock' | 'openai-compatible';
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  timeoutMs: number;
}
export type LLMDraft = Omit<LLMSettings, 'hasApiKey'> & { apiKey?: string; clearApiKey?: boolean };

function isSettings(value: unknown): value is LLMSettings {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<LLMSettings>;
  return (v.mode === 'mock' || v.mode === 'openai-compatible') &&
    typeof v.baseUrl === 'string' && typeof v.model === 'string' &&
    typeof v.hasApiKey === 'boolean' && typeof v.timeoutMs === 'number' &&
    Number.isInteger(v.timeoutMs) && v.timeoutMs >= 1000 && v.timeoutMs <= 600000;
}
async function request(method: string, path: string, draft?: LLMDraft): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/settings/llm${path}`, {
      method, cache: 'no-store', credentials: 'same-origin',
      ...(draft ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) } : {}),
      signal: AbortSignal.timeout(path === '/test' ? (draft?.timeoutMs ?? 120000) + 5000 : 10000),
    });
  } catch {
    throw new Error('无法连接本机设置服务，或请求超时。请检查服务后重试。');
  }
  if (!response.ok) {
    // Never display arbitrary response bodies, which might contain a credential.
    await response.body?.cancel();
    if (response.status === 400) throw new Error('配置无效，请检查地址、模型、密钥与超时时间。');
    if (response.status === 403) throw new Error('设置请求被拒绝，请使用本机同源页面。');
    throw new Error(path === '/test' ? '连接测试失败，请检查地址、密钥、模型和网络。' : '设置读取或保存失败，请检查本机服务与文件权限。');
  }
  try { return await response.json(); } catch { throw new Error('设置服务响应格式无效。'); }
}
export async function loadLLMSettings(): Promise<LLMSettings> {
  const value = await request('GET', '');
  if (!isSettings(value)) throw new Error('设置服务响应格式无效。');
  return value;
}
export async function saveLLMSettings(draft: LLMDraft): Promise<LLMSettings> {
  const value = await request('PUT', '', draft);
  if (!isSettings(value)) throw new Error('设置服务响应格式无效。');
  return value;
}
export async function testLLMSettings(draft: LLMDraft): Promise<void> {
  const value = await request('POST', '/test', draft);
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true) {
    throw new Error('连接测试失败，服务未返回成功结果。');
  }
}

export function validateDraft(draft: LLMDraft, hasApiKey: boolean): string | null {
  try {
    const url = new URL(draft.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    if (/\/chat\/completions\/?$/.test(url.pathname)) return 'Base URL 不应包含 /chat/completions。';
  } catch { return '请输入有效的 HTTP(S) Base URL，不含凭据、查询或片段。'; }
  if (!draft.model.trim() || draft.model.length > 200 || /[\r\n]/.test(draft.model)) return '模型名称不能为空，最长 200 个字符。';
  if (!Number.isInteger(draft.timeoutMs) || draft.timeoutMs < 1000 || draft.timeoutMs > 600000) return '超时时间应为 1–600 秒，最多三位小数。';
  if (draft.apiKey && (/[\r\n]/.test(draft.apiKey) || draft.apiKey.length > 8192)) return 'API Key 格式或长度无效。';
  if (draft.mode === 'openai-compatible' && !draft.apiKey && (!hasApiKey || draft.clearApiKey)) return '真实模型模式需要 API Key；请填写密钥或切换 Mock 模式。';
  return null;
}
