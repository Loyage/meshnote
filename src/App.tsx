import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createApplication } from "./app/createApplication";
import type {
  ApplicationService,
  KnowledgeNode,
  Mesh,
} from "./domain/contracts";
import { createProvider } from "./services/llm/createProvider";
import { GraphCanvas } from "./features/graph/GraphCanvas";
import { NodePanel } from "./features/conversation/NodePanel";
import { useNavigation } from "./stores/useNavigation";

let startup:
  | Promise<{ service: ApplicationService; label: string }>
  | undefined;
function boot() {
  startup ??= createProvider().then(async ({ provider, label }) => ({
    service: await createApplication(provider),
    label,
  }));
  return startup;
}
function MeshDialog({
  action,
  mesh,
  service,
  close,
}: {
  action: "create" | "rename" | "delete";
  mesh?: Mesh;
  service: ApplicationService;
  close: () => void;
}) {
  const [title, setTitle] = useState(
    action === "rename" ? (mesh?.title ?? "") : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const openMesh = useNavigation((s) => s.openMesh);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (action === "create") {
        const created = await service.createMesh(title);
        openMesh(created.id);
      } else if (action === "rename" && mesh)
        await service.renameMesh(mesh.id, title);
      else if (action === "delete" && mesh) await service.deleteMesh(mesh.id);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="mesh-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      aria-labelledby="dialog-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="dialog-title">
          {action === "create"
            ? "创建 Mesh"
            : action === "rename"
              ? "重命名 Mesh"
              : "删除 Mesh？"}
        </h2>
        {action === "delete" ? (
          <p>
            将永久删除「{mesh?.title}
            」及其所有问题、回答与连接。此操作无法撤销。
          </p>
        ) : (
          <label>
            Mesh 名称
            <input
              aria-label="Mesh 名称"
              autoFocus
              maxLength={100}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：Neural ODE"
            />
          </label>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            className={action === "delete" ? "danger" : "primary"}
            disabled={busy || (action !== "delete" && !title.trim())}
          >
            {action === "delete" ? "确认删除" : "保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function Workbench({
  service,
  label,
}: {
  service: ApplicationService;
  label: string;
}) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const { workspace } = snapshot;
  const nav = useNavigation();
  const [dialog, setDialog] = useState<{
    action: "create" | "rename" | "delete";
    mesh?: Mesh;
  } | null>(null);
  const mesh =
    workspace.meshes.find((item) => item.id === nav.meshId) ??
    workspace.meshes[0];
  const node =
    workspace.nodes.find(
      (item) => item.meshId === mesh?.id && item.id === nav.nodeId,
    ) ?? workspace.nodes.find((item) => item.id === mesh?.rootNodeId);
  useEffect(() => {
    if (mesh && nav.meshId !== mesh.id) nav.openMesh(mesh.id, mesh.rootNodeId);
  }, [mesh?.id, nav.meshId]);
  let path: KnowledgeNode[] = [];
  let pathError = "";
  try {
    if (node) path = service.getAncestorPath(node.id);
  } catch (error) {
    pathError = error instanceof Error ? error.message : "探索路径无效";
  }
  const results = service.search(nav.query);
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <strong>MeshNote</strong>
          <span className="version">LOCAL WORKSPACE</span>
        </div>
        <div className="topbar-right">
          <span className="provider-badge">
            <span className="provider-dot" />
            {label}
          </span>
          <span className="privacy-note">知识留在本地</span>
        </div>
      </header>
      {snapshot.error && (
        <div className="global-error" role="alert">
          {snapshot.error}
          <button onClick={() => service.clearError()}>关闭提示</button>
        </div>
      )}
      <main className="workspace">
        <aside className="sidebar" aria-label="Mesh 导航">
          <div className="sidebar-title">
            <span>工作空间</span>
            <span>{workspace.meshes.length} MESHES</span>
          </div>
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="搜索历史节点"
              placeholder="搜索所有问题与回答…"
              value={nav.query}
              onChange={(event) => nav.setQuery(event.target.value)}
            />
            {nav.query && (
              <button aria-label="清空搜索" onClick={() => nav.setQuery("")}>
                ×
              </button>
            )}
          </label>
          {nav.query.trim() ? (
            <div className="search-results" aria-label="搜索结果">
              <div className="section-label">{results.length} 条匹配</div>
              {results.map((result) => (
                <button
                  className="search-result"
                  key={result.nodeId}
                  onClick={() => nav.openMesh(result.meshId, result.nodeId)}
                >
                  <small>{result.meshTitle}</small>
                  <strong>{result.nodeTitle}</strong>
                  <span>{result.snippet}</span>
                </button>
              ))}
              {!results.length && (
                <p className="sidebar-note">没有找到匹配节点。</p>
              )}
            </div>
          ) : (
            <div className="mesh-list">
              <div className="section-label">
                我的 Mesh
                <button
                  aria-label="创建 Mesh"
                  title="创建 Mesh"
                  onClick={() => setDialog({ action: "create" })}
                >
                  ＋
                </button>
              </div>
              {workspace.meshes.map((item) => (
                <div
                  className={`mesh-item ${mesh?.id === item.id ? "active" : ""}`}
                  key={item.id}
                >
                  <button
                    className="mesh-open"
                    onClick={() => nav.openMesh(item.id, item.rootNodeId)}
                  >
                    <span className="mesh-icon">◇</span>
                    <span>{item.title}</span>
                    <small>
                      {
                        workspace.nodes.filter(
                          (node) => node.meshId === item.id,
                        ).length
                      }
                    </small>
                  </button>
                  <div className="mesh-item-actions">
                    <button
                      aria-label={`重命名 ${item.title}`}
                      onClick={() =>
                        setDialog({ action: "rename", mesh: item })
                      }
                    >
                      重命名
                    </button>
                    <button
                      aria-label={`删除 ${item.title}`}
                      onClick={() =>
                        setDialog({ action: "delete", mesh: item })
                      }
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="sidebar-bottom">
            <div className="section-label">
              DOCUMENTS <span>即将支持</span>
            </div>
            <p>
              文档引用结构已预留。
              <br />
              PDF 阅读与检索不在本版范围。
            </p>
            <div className="local-note">◉ IndexedDB · 本机存储</div>
          </div>
        </aside>
        {mesh ? (
          <>
            <div className="graph-column">
              {pathError && (
                <div className="inline-error" role="alert">
                  {pathError}
                </div>
              )}
              <GraphCanvas
                mesh={mesh}
                workspace={workspace}
                service={service}
                path={path}
              />
            </div>
            <NodePanel
              key={mesh.id}
              mesh={mesh}
              node={node}
              path={path}
              snapshot={snapshot}
              service={service}
            />
          </>
        ) : (
          <div className="workspace-empty">
            <span className="empty-symbol">◇</span>
            <h1>让问题连接成知识</h1>
            <p>创建一个 Mesh，开始你的第一条探索路径。</p>
            <button
              className="primary"
              onClick={() => setDialog({ action: "create" })}
            >
              创建 Mesh
            </button>
          </div>
        )}
      </main>
      {dialog && (
        <MeshDialog
          {...dialog}
          service={service}
          close={() => setDialog(null)}
        />
      )}
    </div>
  );
}
export function App() {
  const [runtime, setRuntime] = useState<{
    service: ApplicationService;
    label: string;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void boot()
      .then((value) => {
        if (alive) setRuntime(value);
      })
      .catch((cause) => {
        if (alive)
          setError(cause instanceof Error ? cause.message : "初始化失败");
      });
    return () => {
      alive = false;
    };
  }, []);
  if (error)
    return (
      <div className="startup">
        <h1>MeshNote 无法启动</h1>
        <p role="alert">{error}</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </div>
    );
  if (!runtime)
    return (
      <div className="startup" role="status">
        <span className="brand-mark">M</span>
        <p>正在打开本地知识空间…</p>
      </div>
    );
  return <Workbench {...runtime} />;
}
