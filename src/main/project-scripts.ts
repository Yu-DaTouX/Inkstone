import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PACKAGE_MANAGER_LOCK_FILES,
  packageManagerOf,
  packageScriptsFromManifest,
  type ProjectPackageScripts
} from '../shared/project-scripts'
import { getSettings } from './settings'

const LOCK_FILES = [...new Set(Object.values(PACKAGE_MANAGER_LOCK_FILES).flat())]

function lockFilesIn(cwd: string): string[] {
  return LOCK_FILES.filter((name) => existsSync(join(cwd, name)))
}

export async function readProjectPackageScripts(projectId: string): Promise<ProjectPackageScripts> {
  const settings = await getSettings()
  const project = settings.projects.find((item) => item.id === projectId)
  if (!project) return { ok: false, error: '找不到这个项目，可能已经被移除。' }
  const manager = packageManagerOf(lockFilesIn(project.cwd))
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(project.cwd, 'package.json'), 'utf8'))
  } catch {
    return { ok: true, manager, scripts: [] }
  }
  return { ok: true, manager, scripts: packageScriptsFromManifest(manifest, manager) }
}
