import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { createDemoWorkspace } from '../data/demo';
import { emptyWorkspace } from './contracts';
import { IndexedDBWorkspaceRepository } from './IndexedDBWorkspaceRepository';
import { MemoryWorkspaceRepository } from './MemoryWorkspaceRepository';

const databases: { name: string; repository: IndexedDBWorkspaceRepository }[] = [];
afterEach(async () => {
  for (const { repository } of databases) await repository.close();
  for (const name of new Set(databases.map(database => database.name))) await deleteDB(name);
  databases.length = 0;
});
function indexedRepository(name = `test-${crypto.randomUUID()}`) {
  const repository = new IndexedDBWorkspaceRepository(name);
  databases.push({ name, repository });
  return repository;
}

describe.each([
  ['Memory', () => new MemoryWorkspaceRepository()],
  ['IndexedDB', () => indexedRepository()],
] as const)('%s repository', (_name, makeRepository) => {
  it('seeds once, keeps empty workspaces initialized, and isolates returned records', async () => {
    const repository = makeRepository();
    const first = await repository.initialize(createDemoWorkspace());
    expect(first.nodes).toHaveLength(8);
    first.nodes[0].title = 'external mutation';
    expect((await repository.load()).nodes[0].title).not.toBe('external mutation');
    await repository.save(emptyWorkspace());
    expect((await repository.initialize(createDemoWorkspace())).meshes).toEqual([]);
  });
  it('persists all entities and supports scoped query facets', async () => {
    const repository = makeRepository();
    const workspace = createDemoWorkspace();
    workspace.positions.push({ nodeId: workspace.nodes[0].id, x: 12, y: 34 });
    workspace.documents.push({ id: 'doc', meshId: workspace.meshes[0].id, name: 'paper.pdf', type: 'application/pdf', createdAt: 'now' });
    workspace.chunks.push({ id: 'chunk', documentId: 'doc', content: 'passage', page: 12 });
    workspace.references.push({ nodeId: workspace.nodes[0].id, documentChunkId: 'chunk' });
    await repository.save(workspace);
    expect(await repository.load()).toEqual(workspace);
    expect(await repository.listMeshes()).toHaveLength(1);
    expect((await repository.getMesh(workspace.meshes[0].id))?.title).toBe('Transformer');
    expect(await repository.listNodes(workspace.meshes[0].id)).toHaveLength(8);
    expect(await repository.getNode(workspace.nodes[0].id)).toEqual(workspace.nodes[0]);
    expect(await repository.listEdges(workspace.meshes[0].id)).toHaveLength(7);
    expect(await repository.listDocuments(workspace.meshes[0].id)).toEqual(workspace.documents);
    expect(await repository.listChunks('doc')).toEqual(workspace.chunks);
    expect(await repository.listReferences(workspace.nodes[0].id)).toEqual(workspace.references);
  });
});

describe('IndexedDB persistence', () => {
  it('survives close/reopen and performs concurrent initialization atomically', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const first = indexedRepository(name);
    const second = indexedRepository(name);
    const seedA = createDemoWorkspace();
    const seedB = createDemoWorkspace();
    seedB.meshes[0].title = 'Alternative';
    const [a, b] = await Promise.all([first.initialize(seedA), second.initialize(seedB)]);
    expect(a).toEqual(b);
    await first.save({ ...a, positions: [{ nodeId: a.nodes[0].id, x: 99, y: -40 }] });
    await first.close();
    const reopened = indexedRepository(name);
    expect((await reopened.load()).positions[0].x).toBe(99);
  });
  it('a failed structured clone leaves the complete previous transaction intact', async () => {
    const repository = indexedRepository();
    const original = await repository.initialize(createDemoWorkspace());
    const invalid = structuredClone(original);
    Object.assign(invalid.nodes[0], { uncloneable: () => undefined });
    await expect(repository.save(invalid)).rejects.toThrow();
    expect(await repository.load()).toEqual(original);
  });
});
