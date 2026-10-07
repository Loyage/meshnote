import { describe, expect, it } from 'vitest';
import { createDemoWorkspace } from '../../data/demo';
import { ContextBuilder } from './ContextBuilder';

describe('ContextBuilder', () => {
  it('builds only the ancestor route and preserves question/answer ordering', () => {
    const workspace = createDemoWorkspace();
    const builder = new ContextBuilder(() => workspace);
    expect(builder.getAncestorPath('demo-qk-separate').map(node => node.id)).toEqual([
      'demo-transformer-root', 'demo-attention', 'demo-qkv', 'demo-qk-separate',
    ]);
    const messages = builder.buildContext('demo-qkv', '  那 V 呢？  ');
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages.at(-1)?.content).toBe('那 V 呢？');
    expect(messages.some(message => message.content === workspace.nodes.find(node => node.id === 'demo-position')!.assistantMessage)).toBe(false);
    expect(builder.buildContext(null, '根问题')).toEqual([{ role: 'user', content: '根问题' }]);
  });
  it('ignores general non-branch graph relationships, even cycles', () => {
    const workspace = createDemoWorkspace();
    workspace.edges.push({ ...workspace.edges[0], id: 'reference', sourceNodeId: 'demo-qkv', targetNodeId: 'demo-attention', type: 'reference' });
    expect(new ContextBuilder(() => workspace).getAncestorPath('demo-qkv')).toHaveLength(3);
  });
  it.each([
    ['multiple parents', (workspace: ReturnType<typeof createDemoWorkspace>) => workspace.edges.push({ ...workspace.edges[0], id: 'second', targetNodeId: 'demo-qkv' }), /多个/],
    ['cycle', (workspace: ReturnType<typeof createDemoWorkspace>) => workspace.edges.push({ ...workspace.edges[0], id: 'cycle', sourceNodeId: 'demo-qkv', targetNodeId: 'demo-transformer-root' }), /循环/],
    ['missing source', (workspace: ReturnType<typeof createDemoWorkspace>) => { workspace.edges.find(edge => edge.targetNodeId === 'demo-qkv')!.sourceNodeId = 'missing'; }, /不存在/],
    ['cross mesh node', (workspace: ReturnType<typeof createDemoWorkspace>) => { workspace.nodes.find(node => node.id === 'demo-attention')!.meshId = 'foreign'; }, /跨越/],
    ['cross mesh edge', (workspace: ReturnType<typeof createDemoWorkspace>) => { workspace.edges.find(edge => edge.targetNodeId === 'demo-qkv')!.meshId = 'foreign'; }, /不一致/],
    ['disconnected root', (workspace: ReturnType<typeof createDemoWorkspace>) => { workspace.edges = workspace.edges.filter(edge => edge.targetNodeId !== 'demo-qkv'); }, /根节点/],
  ] as const)('rejects %s instead of inventing a route', (_name, change, expected) => {
    const workspace = createDemoWorkspace();
    change(workspace);
    expect(() => new ContextBuilder(() => workspace).getAncestorPath('demo-qkv')).toThrow(expected);
  });
  it('rejects missing node, mesh and blank questions', () => {
    const workspace = createDemoWorkspace();
    const builder = new ContextBuilder(() => workspace);
    expect(() => builder.getAncestorPath('missing')).toThrow(/找不到/);
    expect(() => builder.buildContext(null, ' ')).toThrow(/问题/);
    workspace.meshes = [];
    expect(() => builder.getAncestorPath('demo-qkv')).toThrow(/不存在/);
  });
});
