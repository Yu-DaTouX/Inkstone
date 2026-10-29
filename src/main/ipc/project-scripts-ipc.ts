import { readProjectPackageScripts } from '../project-scripts'
import type { IpcRegistrar } from './registrar'

export function registerProjectScriptsIpc(ipc: IpcRegistrar): void {
  ipc.rawHandle('yan:projectScripts:read', (_e, projectId: string) =>
    readProjectPackageScripts(String(projectId ?? ''))
  )
}
