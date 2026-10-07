import type { Workspace } from '../domain/contracts';
import { emptyWorkspace, SnapshotRepository } from './contracts';

export class MemoryWorkspaceRepository extends SnapshotRepository {
  private workspace: Workspace | undefined;
  constructor(initial?: Workspace) {
    super();
    this.workspace = initial && structuredClone(initial);
  }
  async initialize(seed: Workspace): Promise<Workspace> {
    if (!this.workspace) this.workspace = structuredClone(seed);
    return this.load();
  }
  async load(): Promise<Workspace> { return structuredClone(this.workspace ?? emptyWorkspace()); }
  async save(workspace: Workspace): Promise<void> { this.workspace = structuredClone(workspace); }
}
