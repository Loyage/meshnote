import { expect, test } from "@playwright/test";
import type { LLMMessage } from "../src/domain/contracts";

test("proxy path excludes siblings, title failure falls back, stream errors preserve content", async ({
  page,
}) => {
  const contexts: LLMMessage[][] = [];
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: { mode: "openai-compatible", model: "fixture-model" },
    }),
  );
  await page.route("**/api/title", (route) =>
    route.fulfill({ status: 502, json: { error: "标题服务暂时不可用" } }),
  );
  await page.route("**/api/chat", async (route) => {
    contexts.push(route.request().postDataJSON().messages);
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"type":"delta","text":"这是协议测试回答。"}\n{"type":"done"}\n',
    });
  });
  await page.goto("/");
  await expect(page.getByText("fixture-model", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "搜索历史节点" })
    .fill("Q/K/V 分别是什么");
  await page.locator(".search-result").click();
  await expect(page.getByTestId("node-title")).toHaveText("Q/K/V 分别是什么？");
  await page
    .getByLabel("从此节点继续提问", { exact: true })
    .fill("标题失败保留问题");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByTestId("user-message")).toHaveText("标题失败保留问题");
  await expect(page.getByTestId("node-status")).toHaveText("已完成");
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(page.getByTestId("node-title")).toHaveText("标题失败保留问题");
  expect(contexts[0]).toHaveLength(7);
  expect(
    contexts[0]
      .filter((message) => message.role === "user")
      .map((message) => message.content),
  ).toEqual([
    "Transformer 是什么？它如何理解序列？",
    "什么是 Attention？为什么它能帮助模型理解上下文？",
    "为什么 Attention 使用 Q/K/V？三者分别代表什么？",
    "标题失败保留问题",
  ]);
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"type":"delta","text":"部分回答仍应保留"}\n',
    }),
  );
  await page.getByLabel("从此节点继续提问", { exact: true }).fill("测试流中断");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByTestId("user-message")).toHaveText("测试流中断");
  await expect(page.getByTestId("node-status")).toHaveText("已中断");
  await expect(page.getByTestId("assistant-message")).toHaveText(
    "部分回答仍应保留",
  );
  await expect(page.getByRole("alert")).toBeVisible();
});

test("drag and camera navigation persist without changing existing layout", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  const card = page.locator('[data-id="demo-attention"]');
  await expect(card).toBeInViewport();
  // Use a node click to finish camera positioning before dragging.
  await card.click();
  await expect(page.getByTestId("node-title")).toHaveText("什么是 Attention？");
  await page.getByRole("button", { name: "定位当前" }).click();
  await expect
    .poll(async () => {
      const node = await card.boundingBox();
      const canvas = await page.getByTestId("graph-canvas").boundingBox();
      return Math.abs(
        node!.x + node!.width / 2 - canvas!.x - canvas!.width / 2,
      );
    })
    .toBeLessThan(3);
  const original = await card.evaluate(
    (element) => (element as HTMLElement).style.transform,
  );
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 25);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 70, box!.y + 90, {
    steps: 15,
  });
  await page.mouse.up();
  await expect
    .poll(() =>
      card.evaluate((element) => (element as HTMLElement).style.transform),
    )
    .not.toBe(original);
  const moved = await card.evaluate(
    (element) => (element as HTMLElement).style.transform,
  );
  await page.reload();
  await expect
    .poll(() =>
      card.evaluate((element) => (element as HTMLElement).style.transform),
    )
    .toBe(moved);
  await page.getByRole("button", { name: "重新布局" }).click();
  await expect(page.getByRole("button", { name: "重新布局" })).toBeEnabled();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
});
