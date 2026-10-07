import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "../../data/demo";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  StableGraphLayout,
} from "./StableGraphLayout";
import type { NodePosition } from "../../domain/contracts";
function noOverlap(positions: NodePosition[]) {
  for (let i = 0; i < positions.length; i++)
    for (let j = i + 1; j < positions.length; j++) {
      expect(
        Math.abs(positions[i].x - positions[j].x) >= NODE_WIDTH ||
          Math.abs(positions[i].y - positions[j].y) >= NODE_HEIGHT,
      ).toBe(true);
    }
}
describe("StableGraphLayout", () => {
  it("lays out the demo left-to-right without overlap", async () => {
    const data = createDemoWorkspace();
    const result = await new StableGraphLayout().layout(
      data.nodes,
      data.edges,
      [],
    );
    expect(result).toHaveLength(8);
    noOverlap(result);
    for (const edge of data.edges)
      expect(
        result.find((p) => p.nodeId === edge.targetNodeId)!.x,
      ).toBeGreaterThan(result.find((p) => p.nodeId === edge.sourceNodeId)!.x);
  });
  it("preserves every old position when adding many siblings and descendants", async () => {
    const data = createDemoWorkspace();
    const layout = new StableGraphLayout();
    const old = await layout.layout(data.nodes, data.edges, []);
    for (let i = 0; i < 30; i++) {
      data.nodes.push({ ...data.nodes[0], id: `new-${i}` });
      data.edges.push({
        ...data.edges[0],
        id: `new-edge-${i}`,
        sourceNodeId: i % 2 ? `new-${i - 1}` : data.nodes[0].id,
        targetNodeId: `new-${i}`,
      });
    }
    const result = await layout.layout(data.nodes, data.edges, old);
    for (const position of old)
      expect(result.find((p) => p.nodeId === position.nodeId)).toEqual(
        position,
      );
    noOverlap(result);
  });
  it("ignores stale positions and dangling edges, supports cycles and explicit reset", async () => {
    const data = createDemoWorkspace();
    data.edges.push({
      ...data.edges[0],
      id: "cycle",
      sourceNodeId: data.nodes[3].id,
      targetNodeId: data.nodes[0].id,
    });
    data.edges.push({
      ...data.edges[0],
      id: "dangling",
      sourceNodeId: "missing",
    });
    const result = await new StableGraphLayout().layout(
      data.nodes,
      data.edges,
      [
        { nodeId: data.nodes[0].id, x: 99999, y: 99999 },
        { nodeId: "stale", x: 0, y: 0 },
      ],
      true,
    );
    expect(result).toHaveLength(8);
    expect(result.every((p) => Number.isFinite(p.x) && p.x < 99999)).toBe(true);
    noOverlap(result);
  });
  it("handles empty graphs", async () => {
    expect(await new StableGraphLayout().layout([], [], [])).toEqual([]);
  });
});
