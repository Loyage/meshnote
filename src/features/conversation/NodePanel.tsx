import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ApplicationService,
  ApplicationSnapshot,
  KnowledgeNode,
  Mesh,
} from "../../domain/contracts";
import { useNavigation } from "../../stores/useNavigation";

export function NodePanel({
  mesh,
  node,
  path,
  snapshot,
  service,
}: {
  mesh: Mesh;
  node?: KnowledgeNode;
  path: KnowledgeNode[];
  snapshot: ApplicationSnapshot;
  service: ApplicationService;
}) {
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const selectNode = useNavigation((s) => s.selectNode);
  useEffect(() => {
    setQuestion("");
    setError("");
  }, [mesh.id, node?.id]);
  const busy = submitting || !!snapshot.generatingNodeId;
  const send = async () => {
    if (!question.trim() || busy) return;
    setSubmitting(true);
    setError("");
    const draft = question;
    // Subscribe before asking: pending publication happens well before ask resolves.
    const before = new Set(snapshot.workspace.nodes.map((item) => item.id));
    let selected = false;
    const unsubscribe = service.subscribe(() => {
      if (selected) return;
      const state = service.getSnapshot();
      const created = state.workspace.nodes.find(
        (item) => item.meshId === mesh.id && !before.has(item.id),
      );
      if (created) {
        selected = true;
        if (useNavigation.getState().meshId === mesh.id) selectNode(created.id);
        setQuestion("");
      }
    });
    try {
      await service.ask(mesh.id, node?.id ?? null, draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败");
    } finally {
      unsubscribe();
      setSubmitting(false);
    }
  };
  return (
    <aside className="node-panel" aria-label="节点详情">
      <div className="panel-heading">
        <span className="eyebrow">EXPLORATION</span>
        <span
          className={`node-status ${node?.status ?? ""}`}
          data-testid="node-status"
        >
          {node
            ? {
                pending: "等待回答",
                streaming: "正在生成",
                completed: "已完成",
                error: "已中断",
              }[node.status]
            : "新起点"}
        </span>
      </div>
      <nav className="breadcrumb" aria-label="探索路径">
        {path.length ? (
          path.map((item, index) => (
            <span key={item.id}>
              {index > 0 && <span className="crumb-divider"> / </span>}
              <button
                title={item.title}
                onClick={() => selectNode(item.id)}
                aria-current={item.id === node?.id ? "step" : undefined}
              >
                {item.title}
              </button>
            </span>
          ))
        ) : (
          <span>Root → 第一个问题</span>
        )}
      </nav>
      <div className="node-content">
        <h1 data-testid="node-title">{node?.title ?? "开始新的知识探索"}</h1>
        {node ? (
          <>
            <section className="answer-section">
              <h2>
                你的问题 <span>USER</span>
              </h2>
              <p className="question-text" data-testid="user-message">
                {node.userMessage}
              </p>
            </section>
            <section className="answer-section">
              <h2>
                回答 <span>ASSISTANT</span>
              </h2>
              <div className="markdown" data-testid="assistant-message">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img: ({ alt }) => (
                      <span>[图片：{alt || "外部图片未自动加载"}]</span>
                    ),
                    a: ({ children, ...props }) => (
                      <a {...props} target="_blank" rel="noreferrer noopener">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {node.assistantMessage ||
                    (node.status === "pending" ? "正在准备上下文…" : "")}
                </ReactMarkdown>
              </div>
              {node.status === "streaming" && (
                <span className="stream-indicator">●</span>
              )}
            </section>
            {node.error && (
              <p role="alert" className="inline-error">
                {node.error}
              </p>
            )}
            <section className="reference-section">
              <h2>
                引用 <span>REFERENCES</span>
              </h2>
              <p>
                {snapshot.workspace.references.filter(
                  (ref) => ref.nodeId === node.id,
                ).length
                  ? "文档引用已关联；阅读器将在后续版本提供。"
                  : "此节点暂无文档引用"}
              </p>
            </section>
          </>
        ) : (
          <p className="empty-copy">
            一个节点，记录一次完整的理解。先提出问题，再沿着新的疑问生长分支。
          </p>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="question-input">
          {node ? "从此节点继续提问" : "提出第一个问题"}
        </label>
        <p className="context-note">
          {node
            ? `仅使用这条探索路径的 ${path.length} 个节点作为上下文`
            : "这个问题将成为 Mesh 的根节点"}
        </p>
        <textarea
          id="question-input"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={node ? "这里又引出了什么问题？" : "你想理解什么？"}
          rows={3}
          maxLength={10000}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="composer-actions">
          <span>⌘ / Ctrl + Enter</span>
          {snapshot.generatingNodeId ? (
            <button type="button" onClick={() => service.cancelGeneration()}>
              停止生成
            </button>
          ) : (
            <button
              className="primary"
              type="submit"
              disabled={
                busy || !question.trim() || (!node && !!mesh.rootNodeId)
              }
            >
              发送问题 ↗
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
