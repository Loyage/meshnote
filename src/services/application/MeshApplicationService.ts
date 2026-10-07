import type {
  ApplicationService, ApplicationSnapshot, KnowledgeNode, LLMMessage, LLMProvider,
  Mesh, NodePosition, Workspace,
} from '../../domain/contracts';
import { createDemoWorkspace } from '../../data/demo';
import type { WorkspaceRepository } from '../../repositories/contracts';
import { ContextBuilder } from '../context/ContextBuilder';
import { searchWorkspace } from '../search/KeywordSearch';

const INTERRUPTED = '页面关闭或刷新导致生成中断，已保留之前保存的回答。';
const CANCELLED = '已取消生成，已保留部分回答。';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误。';
}
export function fallbackTitle(question: string): string {
  const text = question.replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  return characters.length > 24 ? `${characters.slice(0, 23).join('')}…` : text;
}
function normalizeTitle(title: string, fallback: string): string {
  const cleaned = title.trim().split('\n')[0].replace(/^["“「]+|["”」。.]+$/g, '').trim();
  return cleaned ? fallbackTitle(cleaned) : fallback;
}
class StorageError extends Error {
  constructor(cause: unknown) {
    super(`本地保存失败，请勿关闭页面：${errorMessage(cause)}`, { cause });
    this.name = 'StorageError';
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller may have eagerly started an async operation before noticing abort.
    void promise.catch(() => undefined);
    return Promise.reject(new Error(CANCELLED));
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error(CANCELLED)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export interface ApplicationOptions {
  now?: () => string;
  id?: () => string;
  flushIntervalMs?: number;
}

/** All mutations and durable writes share one queue. A layout save cannot
 * overwrite a newer stream chunk or a concurrent Mesh command. The core uses
 * no browser globals; runtime adapters provide persistence and model access.
 */
export class MeshApplicationService implements ApplicationService {
  private snapshot: ApplicationSnapshot;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private activeNodeId: string | null = null;
  private activeMeshId: string | null = null;
  private controller: AbortController | null = null;
  private busy = false;
  private readonly context: ContextBuilder;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly flushIntervalMs: number;

  private constructor(
    private readonly repository: WorkspaceRepository,
    private readonly provider: LLMProvider,
    workspace: Workspace,
    options: ApplicationOptions,
  ) {
    this.snapshot = deepFreeze({ workspace, generatingNodeId: null, error: null });
    this.context = new ContextBuilder(() => this.snapshot.workspace);
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => crypto.randomUUID());
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
  }

  static async create(repository: WorkspaceRepository, provider: LLMProvider, options: ApplicationOptions = {}): Promise<MeshApplicationService> {
    const now = options.now?.() ?? new Date().toISOString();
    const workspace = await repository.initialize(createDemoWorkspace(now));
    let recovered = false;
    for (const node of workspace.nodes) {
      if (node.status === 'pending' || node.status === 'streaming') {
        node.status = 'error';
        node.error = INTERRUPTED;
        node.updatedAt = now;
        recovered = true;
      }
    }
    if (recovered) await repository.save(workspace);
    return new MeshApplicationService(repository, provider, workspace, options);
  }

  getSnapshot = (): ApplicationSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(workspace = this.snapshot.workspace, error = this.snapshot.error): void {
    this.snapshot = deepFreeze({ workspace, generatingNodeId: this.activeNodeId, error });
    // A subscriber cannot break persistence or leave the generation lock held.
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.error('MeshNote subscriber failed', error); }
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async persist(workspace: Workspace): Promise<void> {
    try { await this.repository.save(workspace); }
    catch (cause) {
      const error = new StorageError(cause);
      this.publish(this.snapshot.workspace, error.message);
      throw error;
    }
  }
  private mutate<T>(change: (workspace: Workspace) => T, durable = true): Promise<T> {
    return this.enqueue(async () => {
      const workspace = structuredClone(this.snapshot.workspace);
      const result = change(workspace);
      if (durable) await this.persist(workspace);
      this.publish(workspace);
      return result;
    });
  }
  private flush(): Promise<void> {
    return this.enqueue(() => this.persist(this.snapshot.workspace));
  }
  private requireMesh(workspace: Workspace, meshId: string): Mesh {
    const mesh = workspace.meshes.find(mesh => mesh.id === meshId);
    if (!mesh) throw new Error('找不到此 Mesh。');
    return mesh;
  }
  private cleanMeshTitle(title: string): string {
    const clean = title.trim();
    if (!clean) throw new Error('Mesh 名称不能为空。');
    if (Array.from(clean).length > 100) throw new Error('Mesh 名称最多为 100 个字。');
    return clean;
  }

  async createMesh(title: string): Promise<Mesh> {
    const clean = this.cleanMeshTitle(title);
    return this.mutate(workspace => {
      const now = this.now();
      const mesh: Mesh = { id: this.id(), title: clean, createdAt: now, updatedAt: now };
      workspace.meshes.push(mesh);
      return mesh;
    });
  }
  async renameMesh(meshId: string, title: string): Promise<void> {
    const clean = this.cleanMeshTitle(title);
    await this.mutate(workspace => {
      const mesh = this.requireMesh(workspace, meshId);
      mesh.title = clean;
      mesh.updatedAt = this.now();
    });
  }
  async deleteMesh(meshId: string): Promise<void> {
    await this.mutate(workspace => {
      this.requireMesh(workspace, meshId);
      if (this.busy && this.activeMeshId === meshId) throw new Error('请先停止当前 Mesh 的生成，再删除。');
      const nodeIds = new Set(workspace.nodes.filter(node => node.meshId === meshId).map(node => node.id));
      const documentIds = new Set(workspace.documents.filter(document => document.meshId === meshId).map(document => document.id));
      const chunkIds = new Set(workspace.chunks.filter(chunk => documentIds.has(chunk.documentId)).map(chunk => chunk.id));
      workspace.meshes = workspace.meshes.filter(mesh => mesh.id !== meshId);
      workspace.nodes = workspace.nodes.filter(node => node.meshId !== meshId);
      workspace.edges = workspace.edges.filter(edge => edge.meshId !== meshId && !nodeIds.has(edge.sourceNodeId) && !nodeIds.has(edge.targetNodeId));
      workspace.documents = workspace.documents.filter(document => document.meshId !== meshId);
      workspace.chunks = workspace.chunks.filter(chunk => !documentIds.has(chunk.documentId));
      workspace.references = workspace.references.filter(reference => !nodeIds.has(reference.nodeId) && !chunkIds.has(reference.documentChunkId));
      workspace.positions = workspace.positions.filter(position => !nodeIds.has(position.nodeId));
    });
  }

  async ask(meshId: string, sourceNodeId: string | null, question: string): Promise<void> {
    const clean = question.trim();
    if (!clean) throw new Error('请输入问题。');
    if (this.busy) throw new Error('已有回答正在生成，请等待完成或先停止。');
    this.busy = true;
    this.activeMeshId = meshId;
    const controller = new AbortController();
    this.controller = controller;
    const nodeId = this.id();
    let created = false;
    let iterator: AsyncIterator<string> | undefined;
    try {
      const messages = await this.mutate<LLMMessage[]>(workspace => {
        const mesh = this.requireMesh(workspace, meshId);
        if (sourceNodeId) {
          const source = workspace.nodes.find(node => node.id === sourceNodeId);
          if (!source || source.meshId !== meshId) throw new Error('分支来源节点必须属于当前 Mesh。');
        } else if (mesh.rootNodeId || workspace.nodes.some(node => node.meshId === meshId)) {
          throw new Error('此 Mesh 已有根节点，请选择一个节点继续探索。');
        }
        const messages = this.context.buildContext(sourceNodeId, clean);
        const now = this.now();
        const node: KnowledgeNode = {
          id: nodeId, meshId, title: fallbackTitle(clean), userMessage: clean,
          assistantMessage: '', status: 'pending', createdAt: now, updatedAt: now,
        };
        workspace.nodes.push(node);
        if (sourceNodeId) {
          workspace.edges.push({ id: this.id(), meshId, sourceNodeId, targetNodeId: nodeId, type: 'branch', createdAt: now });
        } else { mesh.rootNodeId = nodeId; }
        mesh.updatedAt = now;
        this.activeNodeId = nodeId;
        return messages;
      });
      created = true;
      if (controller.signal.aborted) throw new Error(CANCELLED);
      iterator = this.provider.chat(messages, controller.signal)[Symbol.asyncIterator]();
      let lastFlushed = 0;
      let unsavedCharacters = 0;
      while (true) {
        const chunk = await abortable(Promise.resolve(iterator.next()), controller.signal);
        if (controller.signal.aborted) throw new Error(CANCELLED);
        if (chunk.done) break;
        if (!chunk.value) continue;
        await this.mutate(workspace => {
          const node = workspace.nodes.find(node => node.id === nodeId)!;
          node.status = 'streaming';
          node.assistantMessage += chunk.value;
          node.updatedAt = this.now();
        }, false);
        unsavedCharacters += chunk.value.length;
        if (Date.now() - lastFlushed >= this.flushIntervalMs || unsavedCharacters >= 2048) {
          await this.flush();
          lastFlushed = Date.now();
          unsavedCharacters = 0;
        }
      }
      if (controller.signal.aborted) throw new Error(CANCELLED);
      const answered = this.snapshot.workspace.nodes.find(node => node.id === nodeId)!;
      if (!answered.assistantMessage.trim()) throw new Error('模型没有返回回答，请稍后重新提问。');
      await this.mutate(workspace => {
        const node = workspace.nodes.find(node => node.id === nodeId)!;
        node.status = 'completed';
        node.updatedAt = this.now();
      });
      // Title failures never discard a completed answer.
      let title = answered.title;
      try {
        title = normalizeTitle(await abortable(this.provider.generateTitle(clean, answered.assistantMessage, controller.signal), controller.signal), answered.title);
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
      if (controller.signal.aborted) throw new Error(CANCELLED);
      if (title !== answered.title) await this.mutate(workspace => {
        const node = workspace.nodes.find(node => node.id === nodeId)!;
        node.title = title;
        node.updatedAt = this.now();
      });
    } catch (error) {
      if (!created) throw error;
      // Publish failure in memory even when the storage itself is unavailable.
      await this.mutate(workspace => {
        const node = workspace.nodes.find(node => node.id === nodeId)!;
        node.status = 'error';
        node.error = controller.signal.aborted ? CANCELLED : errorMessage(error);
        node.updatedAt = this.now();
      }, false);
      await this.flush();
      if (error instanceof StorageError) throw error;
    } finally {
      if (iterator?.return) {
        // An uncooperative provider must not prevent cancellation from settling.
        try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* already failed */ }
      }
      this.busy = false;
      this.activeNodeId = null;
      this.activeMeshId = null;
      this.controller = null;
      this.publish();
    }
  }

  cancelGeneration(): void { this.controller?.abort(); }
  async savePositions(positions: NodePosition[]): Promise<void> {
    if (!positions.length) return;
    await this.enqueue(async () => {
      const workspace = this.snapshot.workspace;
      const nodeIds = new Set(workspace.nodes.map(node => node.id));
      const current = new Map(workspace.positions.map(position => [position.nodeId, position]));
      let changed = false;
      for (const position of positions) {
        if (!nodeIds.has(position.nodeId)) continue; // a deleted mesh's layout may settle later
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('布局坐标必须为有限数值。');
        const previous = current.get(position.nodeId);
        if (previous?.x === position.x && previous.y === position.y) continue;
        current.set(position.nodeId, { ...position });
        changed = true;
      }
      if (!changed) return;
      const next = { ...workspace, positions: [...current.values()] };
      await this.persist(next);
      this.publish(next);
    });
  }
  search(query: string) { return searchWorkspace(this.snapshot.workspace, query); }
  getAncestorPath(nodeId: string) { return this.context.getAncestorPath(nodeId); }
  clearError(): void { this.publish(this.snapshot.workspace, null); }
}
