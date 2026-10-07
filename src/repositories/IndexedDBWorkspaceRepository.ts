import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Workspace } from '../domain/contracts';
import { emptyWorkspace, SnapshotRepository } from './contracts';

interface WorkspaceDatabase extends DBSchema {
  state: {
    key: string;
    value: { initialized: true; schemaVersion: 1; workspace: Workspace };
  };
}

/** A single structured record makes cross-entity writes atomic. Normalized tables
 * can replace this adapter without changing application commands or UI contracts.
 */
export class IndexedDBWorkspaceRepository extends SnapshotRepository {
  private readonly database: Promise<IDBPDatabase<WorkspaceDatabase>>;
  constructor(name = 'meshnote') {
    super();
    this.database = openDB<WorkspaceDatabase>(name, 1, {
      upgrade(database) { database.createObjectStore('state'); },
      blocking() { void databasePromise.then(database => database.close()); },
    });
    const databasePromise = this.database;
  }
  async initialize(seed: Workspace): Promise<Workspace> {
    const database = await this.database;
    const transaction = database.transaction('state', 'readwrite');
    const existing = await transaction.store.get('workspace');
    if (!existing) {
      await transaction.store.put({ initialized: true, schemaVersion: 1, workspace: structuredClone(seed) }, 'workspace');
    }
    await transaction.done;
    return structuredClone(existing?.workspace ?? seed);
  }
  async load(): Promise<Workspace> {
    const record = await (await this.database).get('state', 'workspace');
    return structuredClone(record?.workspace ?? emptyWorkspace());
  }
  async save(workspace: Workspace): Promise<void> {
    const database = await this.database;
    const saved = structuredClone(workspace);
    const transaction = database.transaction('state', 'readwrite');
    await Promise.all([
      transaction.store.put({ initialized: true, schemaVersion: 1, workspace: saved }, 'workspace'),
      transaction.done,
    ]);
  }
  async close(): Promise<void> { (await this.database).close(); }
}
