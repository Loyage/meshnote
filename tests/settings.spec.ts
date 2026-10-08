import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';

const initial = { mode: 'mock', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', timeoutMs: 120000, clearApiKey: true };

test('settings preferences persist, reset layout and return to the selected graph', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('[data-id="demo-attention"]').click();
  await page.getByRole('button', { name: '软件设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '软件设置' })).toBeFocused();
  await page.getByLabel('主题', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('展开工作空间侧栏').check();
  await page.getByRole('slider').fill('60');
  await page.getByRole('button', { name: '返回工作台' }).click();
  await expect(page.getByTestId('node-title')).toHaveText('什么是 Attention？');
  await expect(page.locator('#workspace-sidebar')).toBeVisible();
  await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow', '60');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#workspace-sidebar')).toBeVisible();
  await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow', '60');
  await page.getByRole('button', { name: '软件设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存模型配置' })).toBeEnabled();
  await page.screenshot({ path: 'test-results/settings-dark.png', fullPage: true });
  await page.getByRole('button', { name: '恢复默认布局' }).click();
  await page.getByLabel('主题', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: '返回工作台' }).click();
  await expect(page.locator('#workspace-sidebar')).toBeHidden();
  await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow', '50');
  expect(errors).toEqual([]);
});

test('draft validation, discard warning, sanitized failures and Mock test', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '软件设置', exact: true }).click();
  await page.getByLabel('模型模式').selectOption('openai-compatible');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('alert')).toContainText('需要 API Key');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '返回工作台' }).click();
  await expect(page.getByRole('heading', { name: '软件设置' })).toBeVisible();
  await page.getByLabel('API Key', { exact: true }).fill('browser-draft-secret');
  await page.route('**/api/settings/llm/test', route => route.fulfill({ status: 502, body: 'browser-draft-secret upstream failure' }));
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('alert')).toContainText('连接测试失败');
  await expect(page.getByRole('alert')).not.toContainText('browser-draft-secret');
  await page.unroute('**/api/settings/llm/test');
  await page.getByLabel('模型模式').selectOption('mock');
  await page.getByLabel('API Key', { exact: true }).fill('');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('status')).toContainText('未访问外部模型');
  await page.getByRole('button', { name: '保存模型配置' }).click();
  await expect(page.getByRole('status')).toContainText('模型配置已保存');
});

test('model saving is blocked during generation without interrupting the answer', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/config', route => route.fulfill({ json: { mode: 'openai-compatible', model: 'inflight-test' } }));
  await page.route('**/api/title', route => route.fulfill({ json: { text: '生成中设置测试' } }));
  await page.route('**/api/chat', async route => {
    await pending;
    await route.fulfill({ contentType: 'application/x-ndjson', body: '{"type":"delta","text":"继续完成回答"}\n{"type":"done"}\n' });
  });
  try {
    await page.goto('/');
    await page.getByLabel('从此节点继续提问', { exact: true }).fill('生成期间打开设置');
    await page.getByRole('button', { name: '发送问题' }).click();
    // Before the first delta, generation is active but the node is still pending.
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
    await page.getByRole('button', { name: '软件设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '测试连接' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '保存模型配置' })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('当前正在生成回答');
    release();
    await expect(page.getByRole('button', { name: '保存模型配置' })).toBeEnabled();
    await page.getByRole('button', { name: '返回工作台' }).click();
    await expect(page.getByTestId('node-status')).toHaveText('已完成');
    await expect(page.getByTestId('assistant-message')).toContainText('继续完成回答');
  } finally { release(); }
});

test('real settings save, controlled API test, runtime switch, key preservation and deletion', async ({ page, request }) => {
  const calls: { authorization?: string; body: { model: string; stream: boolean } }[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push({ authorization: req.headers.authorization, body });
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '受控模型回答' }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '受控标题' }, finish_reason: body.max_tokens === 1 ? 'length' : 'stop' }] }));
    }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('test upstream unavailable');
  try {
    await page.goto('/');
    await expect(page.getByText('Mock · 演示模式', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '软件设置', exact: true }).click();
    await page.getByLabel('模型模式').selectOption('openai-compatible');
    await page.getByLabel('Base URL').fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel('模型名称').fill('controlled-model');
    await page.getByLabel('API Key', { exact: true }).fill('e2e-server-secret');
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.getByRole('status')).toContainText('连接测试成功');
    expect((await (await request.get('/api/config')).json()).mode).toBe('mock');
    await page.getByRole('button', { name: '保存模型配置' }).click();
    await expect(page.getByRole('status')).toContainText('模型配置已保存');
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    const metadata = await (await request.get('/api/settings/llm')).json();
    expect(metadata).toMatchObject({ mode: 'openai-compatible', model: 'controlled-model', hasApiKey: true });
    expect(JSON.stringify(metadata)).not.toContain('e2e-server-secret');
    const browserStorage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(browserStorage).not.toContain('e2e-server-secret');
    await page.getByRole('button', { name: '返回工作台' }).click();
    await expect(page.locator('.provider-badge')).toHaveText('controlled-model');
    await page.getByLabel('从此节点继续提问', { exact: true }).fill('验证保存后即时切换');
    await page.getByRole('button', { name: '发送问题' }).click();
    await expect(page.getByTestId('node-status')).toHaveText('已完成');
    await expect(page.getByTestId('assistant-message')).toContainText('受控模型回答');
    await page.reload();
    await expect(page.locator('.provider-badge')).toHaveText('controlled-model');
    await page.getByRole('button', { name: '软件设置', exact: true }).click();
    await page.getByLabel('模型名称').fill('controlled-model-2');
    await page.getByRole('button', { name: '保存模型配置' }).click();
    await expect(page.getByRole('status')).toContainText('模型配置已保存');
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.getByRole('status')).toContainText('连接测试成功');
    expect(calls.at(-1)).toMatchObject({ authorization: 'Bearer e2e-server-secret', body: { model: 'controlled-model-2' } });
    await page.getByLabel('保存时删除已有密钥').check();
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.getByRole('alert')).toContainText('需要 API Key');
    await page.getByLabel('模型模式').selectOption('mock');
    await page.getByRole('button', { name: '保存模型配置' }).click();
    await expect(page.getByRole('status')).toContainText('模型配置已保存');
    expect((await (await request.get('/api/settings/llm')).json()).hasApiKey).toBe(false);
    await page.getByRole('button', { name: '返回工作台' }).click();
    await expect(page.locator('.provider-badge')).toHaveText('Mock · 演示模式');
  } finally {
    const restored = await request.put('/api/settings/llm', { data: initial });
    expect(restored.ok()).toBe(true);
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
