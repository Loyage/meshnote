import { describe, expect, it, vi } from 'vitest';
import type { ApplicationService, ApplicationSnapshot, LLMMessage, LLMProvider, Workspace } from '../../domain/contracts';
import { createDemoWorkspace, DEMO_MESH_ID } from '../../data/demo';
import { MemoryWorkspaceRepository } from '../../repositories/MemoryWorkspaceRepository';
import { emptyWorkspace } from '../../repositories/contracts';
import { MeshApplicationService } from './MeshApplicationService';

function provider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    async *chat() { yield '第一段。'; yield '第二段。'; },
    async generateTitle() { return '简短标题'; },
    async summarize() { return '摘要'; },
    ...overrides,
  };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function until(service: ApplicationService, predicate: (snapshot: ApplicationSnapshot) => boolean): Promise<void> {
  if (predicate(service.getSnapshot())) return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = service.subscribe(() => {
      if (predicate(service.getSnapshot())) { unsubscribe(); resolve(); }
    });
  });
}
function generated(service: ApplicationService) {
  return service.getSnapshot().workspace.nodes.find(node => !node.id.startsWith('demo-'))!;
}

class CountingRepository extends MemoryWorkspaceRepository {
  saves = 0;
  fail = false;
  override async save(workspace: Workspace): Promise<void> {
    this.saves++;
    if (this.fail) throw new Error('quota exceeded');
    await super.save(workspace);
  }
}

describe('ApplicationService generation', () => {
  it('atomically persists pending before invoking LLM, streams and then titles a complete answer', async () => {
    const repository = new CountingRepository(emptyWorkspace());
    let observedMessages: LLMMessage[] = [];
    let service!: MeshApplicationService;
    const llm = provider({ async *chat(messages) {
      observedMessages = messages;
      const saved = await repository.load();
      expect(saved.nodes[0].status).toBe('pending');
      expect(saved.meshes[0].rootNodeId).toBe(saved.nodes[0].id);
      expect(service.getSnapshot().generatingNodeId).toBe(saved.nodes[0].id);
      yield '完整'; yield '回答';
    }, async generateTitle() {
      expect((await repository.load()).nodes[0].status).toBe('completed');
      return '  “短标题。”  ';
    } });
    service = await MeshApplicationService.create(repository, llm);
    const mesh = await service.createMesh('测试 Mesh');
    const initial = service.getSnapshot();
    const states: string[] = [];
    const unsubscribe = service.subscribe(() => {
      const node = service.getSnapshot().workspace.nodes[0];
      if (node) states.push(`${node.status}:${node.assistantMessage}`);
    });
    await service.ask(mesh.id, null, '  第一个问题  ');
    unsubscribe();
    expect(states).toContain('pending:');
    expect(states).toContain('streaming:完整');
    expect(states).toContain('streaming:完整回答');
    expect(states).toContain('completed:完整回答');
    expect(states.indexOf('pending:')).toBeLessThan(states.indexOf('streaming:完整'));
    expect(observedMessages).toEqual([{ role: 'user', content: '第一个问题' }]);
    expect(service.getSnapshot().workspace.nodes[0].title).toBe('短标题');
    expect(service.getSnapshot().generatingNodeId).toBeNull();
    expect(initial.workspace.nodes).toHaveLength(0);
    expect(Object.isFrozen(service.getSnapshot().workspace.nodes[0])).toBe(true);
    expect(await repository.load()).toEqual(service.getSnapshot().workspace);
  });

  it('branches from the selected history, excludes siblings, and rejects duplicate roots', async () => {
    const chat = vi.fn(async function* (messages: LLMMessage[]) { expect(messages.at(-1)?.content).toBe('新分支'); yield '新答案'; });
    const repository = new MemoryWorkspaceRepository();
    const service = await MeshApplicationService.create(repository, provider({ chat }));
    await service.ask(DEMO_MESH_ID, 'demo-qkv', '新分支');
    const node = generated(service);
    const workspace = service.getSnapshot().workspace;
    expect(workspace.edges.find(edge => edge.targetNodeId === node.id)?.sourceNodeId).toBe('demo-qkv');
    expect(service.getAncestorPath(node.id).map(item => item.id)).toEqual(['demo-transformer-root', 'demo-attention', 'demo-qkv', node.id]);
    const passed = chat.mock.calls[0][0];
    expect(passed).toHaveLength(7);
    expect(passed.some(message => message.content === workspace.nodes.find(item => item.id === 'demo-scaling')!.assistantMessage)).toBe(false);
    await expect(service.ask(DEMO_MESH_ID, null, '第二个根')).rejects.toThrow(/已有根节点/);
    await expect(service.ask(DEMO_MESH_ID, 'missing', '问题')).rejects.toThrow(/来源/);
    await expect(service.ask(DEMO_MESH_ID, 'demo-qkv', ' ')).rejects.toThrow(/问题/);
    expect(service.getSnapshot().generatingNodeId).toBeNull();
  });

  it('enforces the single generation lock and blocks deletion of the active Mesh', async () => {
    const gate = deferred();
    const service = await MeshApplicationService.create(new MemoryWorkspaceRepository(), provider({
      async *chat() { yield '片段'; await gate.promise; yield '结束'; },
    }));
    const job = service.ask(DEMO_MESH_ID, 'demo-qkv', '问题');
    await until(service, snapshot => snapshot.workspace.nodes.some(node => node.status === 'streaming'));
    await expect(service.ask(DEMO_MESH_ID, 'demo-attention', '另一个问题')).rejects.toThrow(/正在生成/);
    await expect(service.deleteMesh(DEMO_MESH_ID)).rejects.toThrow(/先停止/);
    gate.resolve();
    await job;
    expect(generated(service).status).toBe('completed');
  });

  it('rejects corrupt ancestor routes and cross-Mesh branch sources before creating a node', async () => {
    const workspace = createDemoWorkspace();
    workspace.edges.push({ ...workspace.edges[0], id: 'ambiguous', targetNodeId: 'demo-qkv' });
    const service = await MeshApplicationService.create(new MemoryWorkspaceRepository(workspace), provider());
    await expect(service.ask(DEMO_MESH_ID, 'demo-qkv', '错误路径')).rejects.toThrow(/多个/);
    expect(service.getSnapshot().workspace.nodes).toHaveLength(8);
    const other = await service.createMesh('另一个主题');
    await expect(service.ask(other.id, 'demo-attention', '跨 Mesh')).rejects.toThrow(/当前 Mesh/);
    expect(service.getSnapshot().generatingNodeId).toBeNull();
  });

  it('can cancel before pending-node persistence finishes without starting the provider', async () => {
    const gate = deferred();
    class SlowRepository extends MemoryWorkspaceRepository {
      override async save(workspace: Workspace) { await gate.promise; await super.save(workspace); }
    }
    const repository = new SlowRepository();
    const chat = vi.fn(async function* () { yield '不应该运行'; });
    const service = await MeshApplicationService.create(repository, provider({ chat }));
    const job = service.ask(DEMO_MESH_ID, 'demo-qkv', '立即停止');
    service.cancelGeneration();
    gate.resolve();
    await job;
    expect(chat).not.toHaveBeenCalled();
    expect(generated(service).status).toBe('error');
    expect(generated(service).error).toContain('取消');
  });

  it('preserves partial output on upstream failure and permits the next request', async () => {
    let fail = true;
    const repository = new MemoryWorkspaceRepository();
    const service = await MeshApplicationService.create(repository, provider({
      async *chat() { yield '保留这部分'; if (fail) throw new Error('服务暂不可用'); yield '成功'; },
    }));
    await service.ask(DEMO_MESH_ID, 'demo-qkv', '会失败');
    expect(generated(service)).toMatchObject({ status: 'error', assistantMessage: '保留这部分', error: '服务暂不可用' });
    expect((await repository.load()).nodes.at(-1)?.status).toBe('error');
    fail = false;
    await service.ask(DEMO_MESH_ID, 'demo-qkv', '重试');
    expect(service.getSnapshot().workspace.nodes.at(-1)?.status).toBe('completed');
  });

  it('cancels a stalled provider immediately and saves partial output', async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const repository = new MemoryWorkspaceRepository();
    const service = await MeshApplicationService.create(repository, provider({
      async *chat(_messages, receivedSignal) { signal = receivedSignal; yield '部分'; await gate.promise; yield '不应显示'; },
    }));
    const job = service.ask(DEMO_MESH_ID, 'demo-qkv', '取消测试');
    await until(service, snapshot => snapshot.workspace.nodes.some(node => node.status === 'streaming'));
    service.cancelGeneration();
    await job;
    expect(signal?.aborted).toBe(true);
    expect(generated(service)).toMatchObject({ status: 'error', assistantMessage: '部分' });
    expect(generated(service).error).toContain('取消');
    expect(service.getSnapshot().generatingNodeId).toBeNull();
    gate.resolve();
    expect((await repository.load()).nodes.at(-1)?.assistantMessage).toBe('部分');
  });

  it('cancels while waiting for a title, not only during answer streaming', async () => {
    const titleStarted = deferred();
    const title = deferred<string>();
    const service = await MeshApplicationService.create(new MemoryWorkspaceRepository(), provider({
      generateTitle() { titleStarted.resolve(); return title.promise; },
    }));
    const job = service.ask(DEMO_MESH_ID, 'demo-qkv', '标题取消');
    await titleStarted.promise;
    service.cancelGeneration();
    await job;
    expect(generated(service).assistantMessage).toBe('第一段。第二段。');
    expect(generated(service).error).toContain('取消');
    title.resolve('迟到的标题');
    expect(generated(service).title).toBe('标题取消');
  });

  it.each(['failure', 'empty'] as const)('keeps fallback title on %s without failing a completed answer', async mode => {
    const service = await MeshApplicationService.create(new MemoryWorkspaceRepository(), provider({
      async generateTitle() { if (mode === 'failure') throw new Error('title failed'); return ''; },
    }));
    const question = '为什么这个特别长的问题需要一个足够短的图节点标题来显示？';
    await service.ask(DEMO_MESH_ID, 'demo-qkv', question);
    const node = generated(service);
    expect(node.status).toBe('completed');
    expect(Array.from(node.title).length).toBeLessThanOrEqual(24);
    expect(node.title.endsWith('…')).toBe(true);
    expect(node.error).toBeUndefined();
  });

  it('does not falsely complete an empty model response', async () => {
    const service = await MeshApplicationService.create(new MemoryWorkspaceRepository(), provider({ async *chat() {} }));
    await service.ask(DEMO_MESH_ID, 'demo-qkv', '空响应');
    expect(generated(service).status).toBe('error');
    expect(generated(service).error).toContain('没有返回');
  });

  it('batches persistence instead of writing a transaction per stream fragment', async () => {
    const repository = new CountingRepository();
    const service = await MeshApplicationService.create(repository, provider({
      async *chat() { for (let i = 0; i < 100; i++) yield '字'; },
    }), { flushIntervalMs: Infinity });
    await service.ask(DEMO_MESH_ID, 'demo-qkv', '批量保存');
    expect(generated(service).assistantMessage).toHaveLength(100);
    expect(repository.saves).toBeLessThanOrEqual(4);
    expect((await repository.load()).nodes.at(-1)?.assistantMessage).toHaveLength(100);
  });
});

describe('ApplicationService persistence and CRUD', () => {
  it('serializes layout, stream and Mesh mutations without lost updates', async () => {
    const gate = deferred();
    const repository = new MemoryWorkspaceRepository();
    const service = await MeshApplicationService.create(repository, provider({
      async *chat() { yield '先'; await gate.promise; yield '后'; },
    }));
    const job = service.ask(DEMO_MESH_ID, 'demo-qkv', '并发');
    await until(service, snapshot => snapshot.workspace.nodes.some(node => node.status === 'streaming'));
    const node = generated(service);
    await Promise.all([
      service.renameMesh(DEMO_MESH_ID, '重新命名'),
      service.savePositions([{ nodeId: node.id, x: 321, y: 654 }]),
      service.createMesh('额外 Mesh'),
    ]);
    gate.resolve();
    await job;
    const saved = await repository.load();
    expect(saved.meshes.find(mesh => mesh.id === DEMO_MESH_ID)?.title).toBe('重新命名');
    expect(saved.meshes).toHaveLength(2);
    expect(saved.positions).toContainEqual({ nodeId: node.id, x: 321, y: 654 });
    expect(saved.nodes.find(item => item.id === node.id)?.assistantMessage).toBe('先后');
  });

  it('cascades deletion across all document, node, edge and layout entities and never reseeds an empty workspace', async () => {
    const workspace = createDemoWorkspace();
    const root = workspace.nodes[0].id;
    workspace.documents.push({ id: 'doc', meshId: DEMO_MESH_ID, name: 'Paper', type: 'pdf', createdAt: 'now' });
    workspace.chunks.push({ id: 'chunk', documentId: 'doc', content: 'text' });
    workspace.references.push({ nodeId: root, documentChunkId: 'chunk' });
    workspace.positions.push({ nodeId: root, x: 0, y: 0 });
    const repository = new MemoryWorkspaceRepository(workspace);
    const service = await MeshApplicationService.create(repository, provider());
    await service.renameMesh(DEMO_MESH_ID, 'New title');
    expect((await repository.getMesh(DEMO_MESH_ID))?.title).toBe('New title');
    await service.deleteMesh(DEMO_MESH_ID);
    expect(await repository.load()).toEqual(emptyWorkspace());
    const reloaded = await MeshApplicationService.create(repository, provider());
    expect(reloaded.getSnapshot().workspace).toEqual(emptyWorkspace());
    await expect(service.renameMesh('missing', 'name')).rejects.toThrow(/找不到/);
    await expect(service.createMesh(' ')).rejects.toThrow(/不能为空/);
    await expect(service.createMesh('a'.repeat(101))).rejects.toThrow(/100/);
  });

  it('recovers pending and streaming nodes with saved partial content after a refresh', async () => {
    const workspace = createDemoWorkspace();
    workspace.nodes[0].status = 'pending';
    workspace.nodes[0].assistantMessage = '';
    workspace.nodes[1].status = 'streaming';
    workspace.nodes[1].assistantMessage = '此前片段';
    const repository = new MemoryWorkspaceRepository(workspace);
    const service = await MeshApplicationService.create(repository, provider());
    expect(service.getSnapshot().workspace.nodes[0].status).toBe('error');
    expect(service.getSnapshot().workspace.nodes[1]).toMatchObject({ status: 'error', assistantMessage: '此前片段' });
    expect(service.getSnapshot().workspace.nodes[1].error).toContain('中断');
    expect(await repository.load()).toEqual(service.getSnapshot().workspace);
  });

  it('does not invoke LLM or leave a root/edge behind if pending persistence fails', async () => {
    const repository = new CountingRepository(emptyWorkspace());
    const chat = vi.fn(async function* () { yield 'bad'; });
    const service = await MeshApplicationService.create(repository, provider({ chat }));
    const mesh = await service.createMesh('No quota');
    repository.fail = true;
    await expect(service.ask(mesh.id, null, '问题')).rejects.toThrow(/保存失败/);
    expect(chat).not.toHaveBeenCalled();
    expect(service.getSnapshot().workspace.nodes).toEqual([]);
    expect(service.getSnapshot().workspace.meshes[0].rootNodeId).toBeUndefined();
    expect(service.getSnapshot().generatingNodeId).toBeNull();
    expect(service.getSnapshot().error).toContain('quota');
    repository.fail = false;
    service.clearError();
    expect(service.getSnapshot().error).toBeNull();
    await service.renameMesh(mesh.id, 'Recovered');
    expect((await repository.load()).meshes[0].title).toBe('Recovered');
  });

  it('preserves unsaved streamed text in memory and reports storage errors explicitly', async () => {
    const repository = new CountingRepository();
    const service = await MeshApplicationService.create(repository, provider({ async *chat() {
      repository.fail = true;
      yield '不能丢失的文本';
    } }));
    await expect(service.ask(DEMO_MESH_ID, 'demo-qkv', '保存失败')).rejects.toThrow(/保存失败/);
    expect(generated(service)).toMatchObject({ assistantMessage: '不能丢失的文本', status: 'error' });
    expect(service.getSnapshot().error).toContain('请勿关闭页面');
    expect(service.getSnapshot().generatingNodeId).toBeNull();
    repository.fail = false;
    await service.renameMesh(DEMO_MESH_ID, '保存重试');
    expect((await repository.load()).nodes.at(-1)?.assistantMessage).toBe('不能丢失的文本');
  });

  it('does not publish or write unchanged layout positions', async () => {
    const repository = new CountingRepository();
    const service = await MeshApplicationService.create(repository, provider());
    const positions = [{ nodeId: 'demo-qkv', x: 100, y: 200 }];
    await service.savePositions(positions);
    const before = service.getSnapshot();
    const writes = repository.saves;
    await service.savePositions(positions);
    expect(service.getSnapshot()).toBe(before);
    expect(repository.saves).toBe(writes);
  });

  it('validates coordinates, ignores stale layout nodes and searches via the facade', async () => {
    const service = await MeshApplicationService.create(new MemoryWorkspaceRepository(), provider());
    await service.savePositions([{ nodeId: 'deleted-node', x: 1, y: 2 }]);
    expect(service.getSnapshot().workspace.positions).toEqual([]);
    await expect(service.savePositions([{ nodeId: 'demo-qkv', x: NaN, y: 2 }])).rejects.toThrow(/坐标/);
    expect(service.search('余弦相似度')[0].nodeId).toBe('demo-dot-product');
  });
});
