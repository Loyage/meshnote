import { expect, test } from '@playwright/test';

test('keyboard activation selects detail and arrow movement survives reload', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('[data-id="demo-attention"]');
  await expect(card).toBeVisible();
  await expect(page.getByRole('button', { name: '重新布局' })).toBeEnabled();
  await card.focus();
  await card.press('Enter');
  await expect(page.getByTestId('node-title')).toHaveText('什么是 Attention？');
  await expect(card).toHaveClass(/selected/);
  const before = await card.evaluate(element => (element as HTMLElement).style.transform);
  await card.press('ArrowRight');
  await expect.poll(() => card.evaluate(element => (element as HTMLElement).style.transform)).not.toBe(before);
  const moved = await card.evaluate(element => (element as HTMLElement).style.transform);
  // A service command creates a persistence-queue barrier before reload.
  await page.getByRole('button', { name: '重命名 Transformer' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(card).toBeVisible();
  await expect.poll(() => card.evaluate(element => (element as HTMLElement).style.transform)).toBe(moved);
});
