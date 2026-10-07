import { describe, expect, it } from 'vitest';
import { createDemoWorkspace } from '../../data/demo';
import { searchWorkspace } from './KeywordSearch';

describe('keyword search', () => {
  it('searches titles, questions and answers across Meshes with accurate snippets', () => {
    const workspace = createDemoWorkspace();
    workspace.meshes.push({ ...workspace.meshes[0], id: 'other', title: 'Other Mesh' });
    workspace.nodes.push({ ...workspace.nodes[0], id: 'other-node', meshId: 'other', title: 'Nothing', userMessage: 'A question', assistantMessage: `${'prefix '.repeat(60)}UNIQUE-keyword and more text` });
    expect(searchWorkspace(workspace, '  transformer ')).not.toHaveLength(0);
    expect(searchWorkspace(workspace, '为什么不使用相同的投影')[0].nodeId).toBe('demo-qk-separate');
    const [match] = searchWorkspace(workspace, 'unique-KEYWORD');
    expect(match.meshTitle).toBe('Other Mesh');
    expect(match.snippet).toContain('UNIQUE-keyword');
    expect(match.snippet.startsWith('…')).toBe(true);
    expect(match.snippet.length).toBeLessThan(130);
  });
  it('treats punctuation literally and has no blank-query matches', () => {
    const workspace = createDemoWorkspace();
    expect(searchWorkspace(workspace, ' ')).toEqual([]);
    expect(searchWorkspace(workspace, '.*')).toEqual([]);
    expect(searchWorkspace(workspace, 'softmax')).not.toHaveLength(0);
  });
});
