import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Node,
  type NodeProps,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  ApplicationService,
  KnowledgeNode,
  Mesh,
  NodePosition,
  Workspace,
} from "../../domain/contracts";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  StableGraphLayout,
} from "../../services/layout/StableGraphLayout";
import { useNavigation } from "../../stores/useNavigation";

type CardNode = Node<
  {
    title: string;
    status: KnowledgeNode["status"];
    branches: number;
    onPath: boolean;
    root: boolean;
  },
  "knowledge"
>;
const statusLabels = {
  pending: "等待回答",
  streaming: "正在生成",
  completed: "已完成",
  error: "已中断",
};
const KnowledgeCard = memo(({ data, selected }: NodeProps<CardNode>) => (
  <div
    className={`knowledge-card ${selected ? "selected" : ""} ${data.onPath ? "on-path" : ""}`}
  >
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <div className="card-title" title={data.title}>
      {data.title}
    </div>
    <div className="card-meta">
      <span className={`status-dot ${data.status}`} />
      <span>
        {data.status === "completed"
          ? data.root
            ? "起点"
            : "知识节点"
          : statusLabels[data.status]}
      </span>
      <span className="branch-count">{data.branches} 分支</span>
    </div>
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </div>
));
const nodeTypes = { knowledge: KnowledgeCard };
const layout = new StableGraphLayout();

function Canvas({
  mesh,
  workspace,
  service,
  path,
}: {
  mesh: Mesh;
  workspace: Workspace;
  service: ApplicationService;
  path: KnowledgeNode[];
}) {
  const { nodeId, focusVersion, selectNode, focus } = useNavigation();
  const flow = useReactFlow<CardNode>();
  const initialized = useNodesInitialized();
  const [positions, setPositions] = useState<NodePosition[]>([]);
  const [layoutError, setLayoutError] = useState("");
  const [resetVersion, setResetVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const appliedReset = useRef(0);
  const camera = useRef<{ initialized: boolean; focusVersion: number }>({
    initialized: false,
    focusVersion,
  });
  const nodes = workspace.nodes.filter((node) => node.meshId === mesh.id);
  const edges = workspace.edges.filter((edge) => edge.meshId === mesh.id);
  const topology = JSON.stringify([
    nodes.map((node) => node.id),
    edges.map((edge) => [edge.id, edge.sourceNodeId, edge.targetNodeId]),
  ]);
  const latest = useRef({ nodes, edges, workspace });
  latest.current = { nodes, edges, workspace };
  useEffect(() => {
    const version = ++sequence.current;
    let alive = true;
    setBusy(true);
    setLayoutError("");
    const current = latest.current;
    const reset = resetVersion !== appliedReset.current;
    void layout
      .layout(current.nodes, current.edges, current.workspace.positions, reset)
      .then(async (result) => {
        if (!alive || sequence.current !== version) return;
        setPositions(result);
        appliedReset.current = resetVersion;
        if (reset) camera.current.initialized = false;
        const existing = new Map(
          current.workspace.positions.map((p) => [p.nodeId, p]),
        );
        if (
          result.some(
            (p) =>
              existing.get(p.nodeId)?.x !== p.x ||
              existing.get(p.nodeId)?.y !== p.y,
          )
        )
          await service.savePositions(result);
      })
      .catch((error) => {
        if (alive)
          setLayoutError(
            String(error instanceof Error ? error.message : error),
          );
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [topology, mesh.id, resetVersion, service]);

  const positionMap = useMemo(
    () => new Map(positions.map((p) => [p.nodeId, p])),
    [positions],
  );
  const pathIds = new Set(path.map((node) => node.id));
  const pathEdges = new Set(
    path.slice(1).map((node, i) => `${path[i].id}:${node.id}`),
  );
  const graphNodes: CardNode[] = nodes
    .filter((node) => positionMap.has(node.id))
    .map((node) => ({
      id: node.id,
      type: "knowledge",
      position: positionMap.get(node.id)!,
      selected: node.id === nodeId,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
      handles: [
        {
          type: "target",
          position: Position.Top,
          x: NODE_WIDTH / 2 - 2.5,
          y: -2.5,
          width: 5,
          height: 5,
        },
        {
          type: "source",
          position: Position.Bottom,
          x: NODE_WIDTH / 2 - 2.5,
          y: NODE_HEIGHT - 2.5,
          width: 5,
          height: 5,
        },
      ],
      ariaLabel: node.title,
      data: {
        title: node.title,
        status: node.status,
        root: mesh.rootNodeId === node.id,
        branches: edges.filter(
          (edge) => edge.type === "branch" && edge.sourceNodeId === node.id,
        ).length,
        onPath: pathIds.has(node.id),
      },
    }));
  const graphEdges = edges.map((edge) => {
    const active =
      edge.type === "branch" &&
      pathEdges.has(`${edge.sourceNodeId}:${edge.targetNodeId}`);
    return {
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      type: "smoothstep",
      className: active ? "ancestor-edge" : "",
      style: {
        stroke: active ? "var(--graph-edge-active)" : "var(--graph-edge)",
        strokeWidth: active ? 2 : 1.3,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: active ? "var(--graph-edge-active)" : "var(--graph-edge)",
        width: 15,
        height: 15,
      },
    };
  });
  useEffect(() => {
    if (!initialized || !flow.viewportInitialized || busy || !positions.length)
      return;
    const target = nodeId ? positionMap.get(nodeId) : undefined;
    if (!camera.current.initialized) {
      camera.current.initialized = true;
      camera.current.focusVersion = focusVersion;
      if (target && nodeId !== mesh.rootNodeId)
        void flow.setCenter(
          target.x + NODE_WIDTH / 2,
          target.y + NODE_HEIGHT / 2,
          { zoom: 1, duration: 240 },
        );
      else void flow.fitView({ padding: 0.1, maxZoom: 1, duration: 240 });
    } else if (camera.current.focusVersion !== focusVersion && target) {
      camera.current.focusVersion = focusVersion;
      void flow.setCenter(
        target.x + NODE_WIDTH / 2,
        target.y + NODE_HEIGHT / 2,
        { zoom: Math.max(0.85, flow.getZoom()), duration: 240 },
      );
    }
  }, [
    initialized,
    busy,
    positions,
    nodeId,
    focusVersion,
    positionMap,
    flow,
    mesh.rootNodeId,
  ]);
  const onNodesChange = (changes: NodeChange<CardNode>[]) => {
    // React Flow emits selection changes for keyboard activation, not onNodeClick.
    const selection = changes.find(change => change.type === "select" && change.selected);
    if (selection?.type === "select" && selection.id !== nodeId) selectNode(selection.id);
    // Keyboard moves use dragging=false; persist settled coordinates, not every drag frame.
    const settledMoves = changes.flatMap(change =>
      change.type === "position" && change.position && change.dragging !== true
        ? [{ nodeId: change.id, ...change.position }] : []);
    if (settledMoves.length) void service.savePositions(settledMoves).catch(error =>
      setLayoutError(error instanceof Error ? error.message : "无法保存节点位置"));
    const moved = changes.filter(
      (change) => change.type === "position" && change.position,
    );
    if (!moved.length) return;
    setPositions((previous) =>
      previous.map((p) => {
        const change = moved.find(
          (change) => change.type === "position" && change.id === p.nodeId,
        );
        return change?.type === "position" && change.position
          ? { nodeId: p.nodeId, ...change.position }
          : p;
      }),
    );
  };
  return (
    <section className="graph-region" aria-label="知识探索图">
      <div className="graph-toolbar">
        <div>
          <strong>{mesh.title}</strong>
          <span className="subtle">
            {nodes.length} 节点 · {edges.length} 连接
          </span>
        </div>
        <div className="toolbar-actions">
          <button
            onClick={() => void flow.fitView({ padding: 0.1, duration: 240 })}
            disabled={!nodes.length}
          >
            适应画布
          </button>
          <button onClick={focus} disabled={!nodeId}>
            定位当前
          </button>
          <button
            onClick={() => setResetVersion((v) => v + 1)}
            disabled={busy || !nodes.length}
          >
            重新布局
          </button>
        </div>
      </div>
      <div className="graph-surface" data-testid="graph-canvas">
        <ReactFlow<CardNode>
          nodes={graphNodes}
          edges={graphEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => selectNode(node.id)}
          onNodeDragStop={(_, node) => {
            void service
              .savePositions([{ nodeId: node.id, ...node.position }])
              .catch((error) => setLayoutError(error.message));
          }}
          nodesConnectable={false}
          nodesDraggable={!busy}
          edgesReconnectable={false}
          deleteKeyCode={null}
          minZoom={0.15}
          maxZoom={1.8}
          onlyRenderVisibleElements
          onNodeDoubleClick={(_, node) => selectNode(node.id)}
        >
          <Background gap={22} size={1} color="var(--graph-dots)" />
          <Controls showInteractive={false} />
          <MiniMap
            style={{ width: 130, height: 86 }}
            pannable
            zoomable
            nodeColor={(node) =>
              node.selected ? "var(--minimap-node-selected)" : "var(--minimap-node)"
            }
            maskColor="var(--minimap-mask)"
          />
        </ReactFlow>
        {!nodes.length && (
          <div className="canvas-empty">
            <span className="empty-symbol">⌘</span>
            <h2>从一个问题开始</h2>
            <p>在右侧提出第一个问题，建立探索的起点。</p>
          </div>
        )}
        {busy && (
          <span className="layout-status" role="status">
            正在布局…
          </span>
        )}
        {layoutError && (
          <div className="graph-error" role="alert">
            {layoutError}
          </div>
        )}
        <div className="canvas-hint">
          拖动画布平移 · 滚轮缩放 · 点击节点继续探索
        </div>
      </div>
    </section>
  );
}
export function GraphCanvas(props: {
  mesh: Mesh;
  workspace: Workspace;
  service: ApplicationService;
  path: KnowledgeNode[];
}) {
  return (
    <ReactFlowProvider key={props.mesh.id}>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
