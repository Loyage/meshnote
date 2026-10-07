import type { KnowledgeNode, LLMMessage, Workspace } from '../../domain/contracts';

/** Context follows exploration edges, never the entire Mesh. Non-branch edges
 * do not change the conversation route. Future multi-parent routes must be
 * explicitly selected rather than silently flattened into a transcript.
 */
export class ContextBuilder {
  constructor(private readonly getWorkspace: () => Workspace) {}

  getAncestorPath(nodeId: string): KnowledgeNode[] {
    const workspace = this.getWorkspace();
    const nodes = new Map(workspace.nodes.map(node => [node.id, node]));
    const selected = nodes.get(nodeId);
    if (!selected) throw new Error('找不到当前知识节点。');
    const mesh = workspace.meshes.find(mesh => mesh.id === selected.meshId);
    if (!mesh) throw new Error('知识节点所属 Mesh 不存在。');
    const incoming = new Map<string, typeof workspace.edges>();
    for (const edge of workspace.edges) {
      if (edge.type !== 'branch') continue;
      const list = incoming.get(edge.targetNodeId) ?? [];
      list.push(edge);
      incoming.set(edge.targetNodeId, list);
    }
    const visited = new Set<string>();
    const reversePath: KnowledgeNode[] = [];
    let current: KnowledgeNode | undefined = selected;
    while (current) {
      if (visited.has(current.id)) throw new Error('探索路径存在循环，无法生成上下文。');
      if (current.meshId !== mesh.id) throw new Error('探索路径不能跨越 Mesh。');
      visited.add(current.id);
      reversePath.push(current);
      const parents = incoming.get(current.id) ?? [];
      if (parents.length > 1) throw new Error('存在多个分支来源，请先明确上下文路径。');
      const edge = parents[0];
      if (!edge) break;
      if (edge.meshId !== mesh.id) throw new Error('探索边所属 Mesh 与节点不一致。');
      current = nodes.get(edge.sourceNodeId);
      if (!current) throw new Error('探索路径引用了不存在的来源节点。');
    }
    const path = reversePath.reverse();
    if (!mesh.rootNodeId || path[0]?.id !== mesh.rootNodeId) {
      throw new Error('探索路径未连接到 Mesh 根节点。');
    }
    return path;
  }

  buildContext(nodeId: string | null, newQuestion: string): LLMMessage[] {
    const question = newQuestion.trim();
    if (!question) throw new Error('请输入问题。');
    const messages: LLMMessage[] = [];
    for (const node of nodeId ? this.getAncestorPath(nodeId) : []) {
      messages.push({ role: 'user', content: node.userMessage });
      // Failed/cancelled nodes may have no answer yet. Never invent one.
      if (node.assistantMessage) messages.push({ role: 'assistant', content: node.assistantMessage });
    }
    messages.push({ role: 'user', content: question });
    return messages;
  }
}
