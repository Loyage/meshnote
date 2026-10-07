import { expect, test, type Page } from "@playwright/test";
import type { Workspace } from "../src/domain/contracts";

async function stored(page: Page): Promise<Workspace> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("meshnote", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Workspace>((resolve, reject) => {
        const request = db
          .transaction("state")
          .objectStore("state")
          .get("workspace");
        request.onsuccess = () => resolve(request.result.workspace);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}
async function searchAndOpen(page: Page, query: string, title: string) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: "搜索历史节点" }).fill(query);
  await expect(page.getByRole("textbox", { name: "搜索历史节点" })).toHaveValue(
    query,
  );
  await page
    .getByRole("button")
    .filter({ has: page.locator("strong", { hasText: title }) })
    .click();
  await expect(page.getByTestId("node-title")).toHaveText(title);
}

test("demo graph, historical branches, streaming, stable layout, search and reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Mock · 演示模式")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await expect(page.locator(".react-flow__edge")).toHaveCount(7);
  await expect.poll(async () => (await stored(page)).positions.length).toBe(8);
  const before = await stored(page);
  await expect
    .poll(async () => {
      const last = await page
        .locator('[data-id="demo-qk-separate"]')
        .boundingBox();
      const canvas = await page.getByTestId("graph-canvas").boundingBox();
      return last!.x + last!.width < canvas!.x + canvas!.width - 20;
    })
    .toBe(true);
  await page.screenshot({ path: "test-results/demo-workspace.png" });
  await page.locator('[data-id="demo-attention"]').click();
  await expect(page.getByTestId("node-title")).toHaveText("什么是 Attention？");
  await expect(page.locator(".ancestor-edge")).toHaveCount(1);
  await page
    .getByLabel("从此节点继续提问", { exact: true })
    .fill("为什么 Attention 要缩放？");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByTestId("node-status")).toHaveText("正在生成");
  await expect(page.getByTestId("assistant-message")).not.toBeEmpty();
  await expect(page.getByTestId("node-status")).toHaveText("已完成");
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  let data = await stored(page);
  expect(data.nodes).toHaveLength(9);
  const branch = data.nodes.find(
    (node) => !before.nodes.some((old) => old.id === node.id),
  )!;
  expect(
    data.edges.find((edge) => edge.targetNodeId === branch.id)?.sourceNodeId,
  ).toBe("demo-attention");
  for (const old of before.positions)
    expect(data.positions.find((p) => p.nodeId === old.nodeId)).toEqual(old);
  await searchAndOpen(page, "什么是 Attention", "什么是 Attention？");
  await page
    .getByLabel("从此节点继续提问", { exact: true })
    .fill("请解释 value 独立分支");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByTestId("user-message")).toHaveText(
    "请解释 value 独立分支",
  );
  await expect(page.getByTestId("node-status")).toHaveText("已完成");
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  data = await stored(page);
  expect(
    data.edges.filter((edge) => edge.sourceNodeId === "demo-attention"),
  ).toHaveLength(5);
  await page.reload();
  await expect(page.getByText("Mock · 演示模式")).toBeVisible();
  await searchAndOpen(page, "value 独立分支", data.nodes.at(-1)!.title);
  const selected = page.locator(".react-flow__node.selected");
  await expect(selected).toHaveCount(1);
  await expect(selected).toBeInViewport();
  await expect(page.getByTestId("assistant-message")).not.toBeEmpty();
  expect((await stored(page)).nodes).toHaveLength(10);
  expect(errors).toEqual([]);
});

test("Mesh CRUD, root creation, cross-mesh search, cancellation and persistence", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "创建 Mesh", exact: true }).click();
  await page.getByRole("textbox", { name: "Mesh 名称" }).fill("Neural ODE");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("node-title")).toHaveText("开始新的知识探索");
  await page
    .getByLabel("提出第一个问题", { exact: true })
    .fill("为什么连续时间动力系统需要积分？");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByTestId("node-status")).toHaveText("正在生成");
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByTestId("node-status")).toHaveText("已中断");
  await expect(page.getByRole("alert")).toContainText("取消");
  const data = await stored(page);
  const created = data.meshes.find((mesh) => mesh.title === "Neural ODE")!;
  expect(created.rootNodeId).toBeTruthy();
  expect(data.edges.filter((edge) => edge.meshId === created.id)).toHaveLength(
    0,
  );
  await page.getByRole("button", { name: "重命名 Neural ODE" }).click();
  await page.getByRole("textbox", { name: "Mesh 名称" }).fill("连续动力学");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await searchAndOpen(page, "位置编码", "为什么需要位置编码？");
  await expect(page.locator(".react-flow__node.selected")).toHaveAttribute(
    "data-id",
    "demo-position",
  );
  await expect(page.locator(".react-flow__node.selected")).toBeInViewport();
  await page.getByRole("button", { name: "清空搜索" }).click();
  await page.getByRole("button", { name: "◇ 连续动力学 1" }).click();
  await page.getByRole("button", { name: "删除 连续动力学" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await page.getByRole("button", { name: "删除 Transformer" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(
    page.getByRole("heading", { name: "让问题连接成知识" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "让问题连接成知识" }),
  ).toBeVisible();
  expect((await stored(page)).nodes).toEqual([]);
});
