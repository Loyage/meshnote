export type Timestamp = string;
export interface Mesh {
  id: string; title: string; description?: string; rootNodeId?: string;
  createdAt: Timestamp; updatedAt: Timestamp;
}
export type NodeStatus = 'pending' | 'streaming' | 'completed' | 'error';
export interface KnowledgeNode {
  id: string; meshId: string; title: string; userMessage: string; assistantMessage: string;
  summary?: string; status: NodeStatus; error?: string;
  createdAt: Timestamp; updatedAt: Timestamp;
}
export interface ExplorationEdge {
  id: string; meshId: string; sourceNodeId: string; targetNodeId: string;
  type: 'branch' | 'reference' | 'related'; createdAt: Timestamp;
}
export interface MeshDocument {
  id: string; meshId: string; name: string; type: string; createdAt: Timestamp;
}
export interface DocumentChunk {
  id: string; documentId: string; content: string; page?: number;
}
export interface NodeReference { nodeId: string; documentChunkId: string }
export interface NodePosition { nodeId: string; x: number; y: number }
export interface Workspace {
  meshes: Mesh[]; nodes: KnowledgeNode[]; edges: ExplorationEdge[];
  documents: MeshDocument[]; chunks: DocumentChunk[]; references: NodeReference[];
  positions: NodePosition[];
}
export interface LLMMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface LLMProvider {
  chat(messages: LLMMessage[], signal?: AbortSignal): AsyncIterable<string>;
  generateTitle(question: string, answer: string, signal?: AbortSignal): Promise<string>;
  summarize(messages: LLMMessage[], signal?: AbortSignal): Promise<string>;
}
export interface SearchResult {
  meshId: string; meshTitle: string; nodeId: string; nodeTitle: string; snippet: string;
}
export interface ApplicationSnapshot {
  workspace: Workspace;
  generatingNodeId: string | null;
  /** Persistence/runtime failure, distinct from a node's generation error. */
  error: string | null;
}
export interface ApplicationService {
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: () => void): () => void;
  createMesh(title: string): Promise<Mesh>;
  renameMesh(meshId: string, title: string): Promise<void>;
  deleteMesh(meshId: string): Promise<void>;
  /** Resolves after generation/title; pending node is published before provider invocation. */
  ask(meshId: string, sourceNodeId: string | null, question: string): Promise<void>;
  cancelGeneration(): void;
  savePositions(positions: NodePosition[]): Promise<void>;
  search(query: string): SearchResult[];
  /** Same path policy as ContextBuilder; throws on ambiguous/corrupt paths. */
  getAncestorPath(nodeId: string): KnowledgeNode[];
  clearError(): void;
}
export interface GraphLayout {
  layout(nodes: KnowledgeNode[], edges: ExplorationEdge[], positions: NodePosition[], reset?: boolean): Promise<NodePosition[]>;
}
