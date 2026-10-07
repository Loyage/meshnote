import type { DocumentChunk, ExplorationEdge, KnowledgeNode, Mesh, MeshDocument, NodeReference, Workspace } from '../domain/contracts';

export interface MeshRepository {
  listMeshes(): Promise<Mesh[]>;
  getMesh(id: string): Promise<Mesh | undefined>;
}
export interface NodeRepository {
  listNodes(meshId: string): Promise<KnowledgeNode[]>;
  getNode(id: string): Promise<KnowledgeNode | undefined>;
}
export interface EdgeRepository {
  listEdges(meshId: string): Promise<ExplorationEdge[]>;
}
export interface DocumentRepository {
  listDocuments(meshId: string): Promise<MeshDocument[]>;
  listChunks(documentId: string): Promise<DocumentChunk[]>;
  listReferences(nodeId: string): Promise<NodeReference[]>;
}
/** Query facets plus an atomic unit of work, replaceable by a SQLite adapter.
 * A saved empty workspace remains initialized: the demo must not reappear.
 */
export interface WorkspaceRepository extends MeshRepository, NodeRepository, EdgeRepository, DocumentRepository {
  initialize(seed: Workspace): Promise<Workspace>;
  load(): Promise<Workspace>;
  save(workspace: Workspace): Promise<void>;
}

export function emptyWorkspace(): Workspace {
  return { meshes: [], nodes: [], edges: [], documents: [], chunks: [], references: [], positions: [] };
}

/** Returned records are isolated copies; callers cannot modify persisted state. */
export abstract class SnapshotRepository implements WorkspaceRepository {
  abstract initialize(seed: Workspace): Promise<Workspace>;
  abstract load(): Promise<Workspace>;
  abstract save(workspace: Workspace): Promise<void>;
  async listMeshes() { return (await this.load()).meshes; }
  async getMesh(id: string) { return (await this.load()).meshes.find(mesh => mesh.id === id); }
  async listNodes(meshId: string) { return (await this.load()).nodes.filter(node => node.meshId === meshId); }
  async getNode(id: string) { return (await this.load()).nodes.find(node => node.id === id); }
  async listEdges(meshId: string) { return (await this.load()).edges.filter(edge => edge.meshId === meshId); }
  async listDocuments(meshId: string) { return (await this.load()).documents.filter(document => document.meshId === meshId); }
  async listChunks(documentId: string) { return (await this.load()).chunks.filter(chunk => chunk.documentId === documentId); }
  async listReferences(nodeId: string) { return (await this.load()).references.filter(reference => reference.nodeId === nodeId); }
}
