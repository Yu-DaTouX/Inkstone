import type { IpcRegistrar } from './registrar'
import { changeProjectDirectory } from '../project-directory'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { allowTrust, revokeTrust, trustStatus } from '../project-trust'
import { providerQuotaWithFallback } from '../quota'

export function registerWorkspaceIpc(ipc: IpcRegistrar): void {
  const { rawHandle } = ipc
  rawHandle('yan:project:changeDirectory', (_event, request: unknown) => changeProjectDirectory(request))

  rawHandle('yan:trust:status', async (_e, cwd: unknown) => {
    const dir = typeof cwd === 'string' ? cwd.trim() : ''
    if (!dir) return { cwd: '', trusted: false, entry: null }
    return trustStatus(dir)
  })
  rawHandle('yan:trust:allow', async (_e, cwd: unknown) => {
    const dir = typeof cwd === 'string' ? cwd.trim() : ''
    if (!dir || !isAbsolute(dir)) return { ok: false, entry: '', error: '缺少有效的绝对目录' }
    try {
      const canonical = await realpath(dir)
      if (!(await stat(canonical)).isDirectory()) return { ok: false, entry: '', error: '不是目录' }
      return await allowTrust(canonical)
    } catch (error) { return { ok: false, entry: '', error: `目录不可访问：${error instanceof Error ? error.message : String(error)}` } }
  })

  rawHandle('yan:trust:revoke', async (_event, cwd: unknown) => {
    const dir = typeof cwd === 'string' ? cwd.trim() : ''
    if (!dir || !isAbsolute(dir)) return { ok: false, entry: '', error: '缺少有效的绝对目录' }
    return revokeTrust(dir)
  })

  rawHandle('yan:providerQuota', (_e, provider: unknown, budget: unknown) => providerQuotaWithFallback(String(provider ?? ''), Number(budget) || undefined))
}
