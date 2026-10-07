import type { SearchResult, Workspace } from '../../domain/contracts';

/** Case-insensitive literal substring search, including Chinese without tokenizers.
 * Returns the actual matching field, not always the beginning of the answer.
 */
export function searchWorkspace(workspace: Workspace, query: string): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const meshes = new Map(workspace.meshes.map(mesh => [mesh.id, mesh]));
  const results: SearchResult[] = [];
  for (const node of workspace.nodes) {
    const mesh = meshes.get(node.meshId);
    if (!mesh) continue;
    for (const field of [node.title, node.userMessage, node.assistantMessage]) {
      const index = field.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      const start = Math.max(0, index - 36);
      const end = Math.min(field.length, index + needle.length + 70);
      results.push({
        meshId: mesh.id, meshTitle: mesh.title, nodeId: node.id, nodeTitle: node.title,
        snippet: `${start ? '…' : ''}${field.slice(start, end).replace(/\s+/g, ' ')}${end < field.length ? '…' : ''}`,
      });
      break;
    }
  }
  return results;
}
