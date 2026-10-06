/**
 * 受管 Git 的 IPC 适配：状态 / 一键安装 / 取消 / 移除。
 *
 * 安装只在用户点了按钮之后发生（下载文件必须由用户确认）；进度经 `git-install` 推给界面。
 * 装好后重启 pi：它的 PATH 在启动时定下来，不重启就看不到新装的 bash。
 */
import type { IpcRegistrar } from './registrar'
import type { MainPush } from '../../shared/ipc'
import { cancelGitInstall, gitRuntimeStatus, installManagedGit, removeManagedGit } from '../git-runtime'

export interface GitRuntimeIpcDeps {
  restartAgent(reason: string): Promise<void>
  push(msg: MainPush): void
  /** 界面是中文时优先走国内镜像 */
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
