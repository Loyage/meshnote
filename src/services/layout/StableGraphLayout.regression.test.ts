import { describe, expect, it } from 'vitest';
import { NODE_HEIGHT, NODE_WIDTH, StableGraphLayout } from './StableGraphLayout';
import type { ExplorationEdge, KnowledgeNode } from '../../domain/contracts';

const node = (id: string): KnowledgeNode => ({ id, meshId: 'mesh', title: id, userMessage: id, assistantMessage: '', status: 'completed', createdAt: '', updatedAt: '' });
const edge = (source: string, target: string): ExplorationEdge => ({ id: `${source}-${target}`, meshId: 'mesh', sourceNodeId: source, targetNodeId: target, type: 'branch', createdAt: '' });

describe('StableGraphLayout incremental regressions', () => {
  it('preserves coordinates while adding descendants before parents in the input order', async () => {
    const layout = new StableGraphLayout();
    const original = await layout.layout(['a', 'b'].map(node), [edge('a', 'b')], []);
    const result = await layout.layout(['a', 'd', 'c', 'b'].map(node), [edge('a', 'b'), edge('a', 'c'), edge('c', 'd')], original);
    for (const position of original) expect(result.find(p => p.nodeId === position.nodeId)).toEqual(position);
    expect(result.find(p => p.nodeId === 'd')!.y).toBeGreaterThan(result.find(p => p.nodeId === 'c')!.y);
    for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
      expect(Math.abs(result[i].x - result[j].x) >= NODE_WIDTH || Math.abs(result[i].y - result[j].y) >= NODE_HEIGHT).toBe(true);
    }
  });

  it('does not move nodes for title and answer updates and discards unrelated positions', async () => {
    const result = await new StableGraphLayout().layout([{ ...node('a'), title: '新的标题', assistantMessage: '流式回答' }], [], [{ nodeId: 'a', x: 8, y: 13 }, { nodeId: 'other', x: 3, y: 4 }]);
    expect(result).toEqual([{ nodeId: 'a', x: 8, y: 13 }]);
  });

  it('incrementally handles cycles, missing endpoints and invalid coordinates', async () => {
    const result = await new StableGraphLayout().layout(['a', 'b', 'c'].map(node), [edge('a', 'b'), edge('b', 'a'), edge('c', 'missing')], [{ nodeId: 'c', x: 0, y: 0 }, { nodeId: 'a', x: NaN, y: 5 }]);
    expect(result).toHaveLength(3);
    expect(result.every(position => Number.isFinite(position.x) && Number.isFinite(position.y))).toBe(true);
  });
});
