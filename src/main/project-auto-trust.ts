import { stat } from 'node:fs/promises'
import { allowTrust, trustStatus } from './project-trust'

export interface AutoTrustDeps {
  status(cwd: string): Promise<{ trusted: boolean; entry: string | null }>
  allow(cwd: string): Promise<{ ok: boolean }>
  isDirectory(cwd: string): Promise<boolean>
}

const defaultDeps: AutoTrustDeps = {
  status: trustStatus,
  allow: allowTrust,
  isDirectory: async (cwd) => (await stat(cwd).catch(() => null))?.isDirectory() === true
}

export async function trustProjectFolders<T extends { cwd: string }>(projects: readonly T[], deps: AutoTrustDeps = defaultDeps): Promise<T[]> {
  const trusted: T[] = []
  for (const project of projects) {
    try {
      const status = await deps.status(project.cwd)
      if (status.trusted || status.entry !== null) continue
      if (!(await deps.isDirectory(project.cwd))) continue
      if ((await deps.allow(project.cwd)).ok) trusted.push(project)
    } catch {
    }
  }
  return trusted
}
