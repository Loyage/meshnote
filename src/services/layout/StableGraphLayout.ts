import type ELK from "elkjs/lib/elk.bundled.js";
import type {
  ExplorationEdge,
  GraphLayout,
  KnowledgeNode,
  NodePosition,
} from "../../domain/contracts";

export const NODE_WIDTH = 196;
export const NODE_HEIGHT = 76;
const GAP_X = 48;
const GAP_Y = 30;

/** ELK for initial/global arrangement; append-only placement preserves the mental map. */
export class StableGraphLayout implements GraphLayout {
  private elk?: Promise<InstanceType<typeof ELK>>;
  private getEngine() {
    return (this.elk ??= import("elkjs/lib/elk.bundled.js").then(
      (module) => new module.default(),
    ));
  }
  async layout(
    nodes: KnowledgeNode[],
    edges: ExplorationEdge[],
    positions: NodePosition[],
    reset = false,
  ): Promise<NodePosition[]> {
    if (!nodes.length) return [];
    const ids = new Set(nodes.map((node) => node.id));
    const validEdges = edges.filter(
      (edge) => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId),
    );
    const known = new Map(
      positions
        .filter(
          (p) =>
            ids.has(p.nodeId) && Number.isFinite(p.x) && Number.isFinite(p.y),
        )
        .map((p) => [p.nodeId, { ...p }]),
    );
    if (reset || !known.size) {
      const result = await (
        await this.getEngine()
      ).layout({
        id: "mesh",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.spacing.nodeNode": String(GAP_Y),
          "elk.layered.spacing.nodeNodeBetweenLayers": String(GAP_X),
          "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        },
        children: nodes.map((node) => ({
          id: node.id,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        })),
        edges: validEdges.map((edge) => ({
          id: edge.id,
          sources: [edge.sourceNodeId],
          targets: [edge.targetNodeId],
        })),
      });
      return (result.children ?? []).map((node) => ({
        nodeId: node.id,
        x: node.x ?? 0,
        y: node.y ?? 0,
      }));
    }
    const missing = nodes.filter((node) => !known.has(node.id));
    while (missing.length) {
      let index = missing.findIndex((node) =>
        validEdges.some(
          (edge) =>
            edge.targetNodeId === node.id && known.has(edge.sourceNodeId),
        ),
      );
      if (index < 0) index = 0;
      const [node] = missing.splice(index, 1);
      const incoming = validEdges.find(
        (edge) => edge.targetNodeId === node.id && known.has(edge.sourceNodeId),
      );
      const source = incoming ? known.get(incoming.sourceNodeId) : undefined;
      const x = source ? source.x + NODE_WIDTH + GAP_X : 12;
      const startY = source?.y ?? 12;
      let y = startY;
      // Search alternating lanes without moving any existing card.
      for (let lane = 0; ; lane++) {
        y =
          startY +
          Math.ceil(lane / 2) * (lane % 2 ? 1 : -1) * (NODE_HEIGHT + GAP_Y);
        const collision = [...known.values()].some(
          (p) =>
            Math.abs(p.x - x) < NODE_WIDTH + 20 &&
            Math.abs(p.y - y) < NODE_HEIGHT + GAP_Y,
        );
        if (!collision) break;
      }
      known.set(node.id, { nodeId: node.id, x, y });
    }
    return nodes.map((node) => known.get(node.id)!);
  }
}
