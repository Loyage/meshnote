import type { ApplicationService, LLMProvider } from '../domain/contracts';
import { IndexedDBWorkspaceRepository } from '../repositories/IndexedDBWorkspaceRepository';
import { MeshApplicationService } from '../services/application/MeshApplicationService';

/** Browser composition root; domain services themselves remain runtime-neutral. */
export async function createApplication(provider: LLMProvider): Promise<ApplicationService> {
  return MeshApplicationService.create(new IndexedDBWorkspaceRepository(), provider);
}
