import { join } from 'node:path'
import type { ProjectIdentity } from '../shared/project-memory'
import { YAN_DIR } from './paths'
import type { ProjectKnowledgeStoreOptions } from './project-memory-store'

export type MemoryScope = 'project' | 'personal'

export const PERSONAL_MEMORY_ID = 'personal'
export const PERSONAL_MEMORY_ROOT = join(YAN_DIR, 'personal-memory')
export const PERSONAL_IDENTITY: ProjectIdentity = { projectId: PERSONAL_MEMORY_ID, cwd: '' }
export const PERSONAL_STORE: ProjectKnowledgeStoreOptions = { root: PERSONAL_MEMORY_ROOT }

export function memoryStoreOf(
  scope: MemoryScope,
  project: ProjectIdentity | null
): { identity: ProjectIdentity; opts: ProjectKnowledgeStoreOptions } | null {
  if (scope === 'personal') return { identity: PERSONAL_IDENTITY, opts: PERSONAL_STORE }
  return project ? { identity: project, opts: {} } : null
}
