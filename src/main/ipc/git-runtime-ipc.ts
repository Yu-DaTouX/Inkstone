import type { IpcRegistrar } from './registrar'
import type { MainPush } from '../../shared/ipc'
import { cancelGitInstall, gitRuntimeStatus, installManagedGit, removeManagedGit } from '../git-runtime'

export interface GitRuntimeIpcDeps {
  restartAgent(reason: string): Promise<void>
  push(msg: MainPush): void
  preferMirror(): Promise<boolean>
}

export function registerGitRuntimeIpc(ipc: IpcRegistrar, deps: GitRuntimeIpcDeps): void {
  const { handle } = ipc
  handle('yan:gitRuntimeStatus', async () => gitRuntimeStatus())
  handle('yan:gitRuntimeInstall', async () => {
    const result = await installManagedGit({
      preferMirror: await deps.preferMirror(),
      onProgress: (payload) => deps.push({ ch: 'git-install', payload })
    })
    if (result.ok) void deps.restartAgent('Git 已安装')
    return result
  })
  handle('yan:gitRuntimeCancel', async () => cancelGitInstall())
  handle('yan:gitRuntimeRemove', async () => {
    await removeManagedGit()
    void deps.restartAgent('Git 已移除')
  })
}
