import { dialog, type BrowserWindow } from 'electron'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentController } from '../agent'
import type { SessionHost } from '../session-host'
import type { IpcRegistrar } from './registrar'
import type { NativeSessionHostRequest, NativeSessionHostResult } from '../../shared/native-session-host'
import { validateNativeSessionRequest } from '../native-session-guard'
import { exportSessionJsonl, importSessionJsonl, shareViaGist } from '../native-session-io'
import { selectSessionWithHost } from './session-ipc'

interface NativeSessionPorts {
  win(): BrowserWindow | null
  runtime(agent: AgentController, request: NativeSessionHostRequest): Promise<NativeSessionHostResult>
  confirm(agent: AgentController, prompt: { title: string; message: string; acceptLabel: string }): Promise<boolean>
}

function argumentPath(raw: string | undefined, cwd: string): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const unquoted = value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) ? value.slice(1, -1) : value
  return isAbsolute(unquoted) ? unquoted : resolve(cwd, unquoted)
}

export function registerNativeSessionIpc(ipc: IpcRegistrar, host: SessionHost, ports: NativeSessionPorts): void {
  const operations = new WeakSet<AgentController>()
  ipc.handle('yan:nativeSession', async (input: unknown): Promise<NativeSessionHostResult> => {
    const agent = host.ac()
    const check = validateNativeSessionRequest(input, agent?.getState() ?? null, !!agent && (agent.hasRunningBash() || agent.pendingUiRequests().length > 0))
    if (!check.ok || !agent) return check.ok ? { ok: false, error: 'pi 未运行' } : check
    if (operations.has(agent)) return { ok: false, error: '此会话的另一项原生操作尚未结束' }
    const request = check.request
    const identity = agent.getState()?.sessionId
    const cwd = agent.workingDirectory
    const sourceFile = agent.getState()?.sessionFile
    const fresh = (): NativeSessionHostResult | null => {
      if (host.ac() !== agent || agent.getState()?.sessionId !== identity) return { ok: false, error: '会话已切换，操作已取消' }
      const valid = validateNativeSessionRequest(request, agent.getState(), agent.hasRunningBash() || agent.pendingUiRequests().length > 0)
      return valid.ok ? null : valid
    }
    operations.add(agent)
    try {
      if (request.action === 'tree') return await agent.sessionTree()
      if (request.action === 'entries') return await agent.sessionEntries(request.since)
      if (request.action === 'new-session') return await agent.newSession(request.parentSession ?? argumentPath(request.args, cwd))
      if (request.action === 'import') {
        let path = argumentPath(request.args, cwd)
        if (!path) {
          const parent = ports.win()
          const options = { title: '导入 pi 会话', filters: [{ name: 'pi 会话', extensions: ['jsonl'] }], properties: ['openFile'] as Array<'openFile'> }
          const chosen = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
          if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, cancelled: true }
          path = chosen.filePaths[0]
        }
        const stale = fresh()
        if (stale) return stale
        const imported = importSessionJsonl({ sourcePath: path, cwd, ...(sourceFile ? { sessionDir: dirname(sourceFile) } : {}), freshSessionId: true })
        if (!imported.ok) return imported
        const switched = await selectSessionWithHost(host, { sessionFile: imported.destinationPath, cwd, scope: 'global' })
        if (!switched.ok) return { ok: false, error: switched.error ?? '会话已导入，但未能切换；原会话保持不变' }
        return { ok: true, path: imported.destinationPath }
      }
      if (request.action === 'export-jsonl') {
        if (!sourceFile) return { ok: false, error: '当前会话尚未保存' }
        let path = argumentPath(request.args, cwd)
        if (!path) {
          const parent = ports.win()
          const options = { title: '导出当前 pi 分支', defaultPath: basename(sourceFile), filters: [{ name: 'pi 会话', extensions: ['jsonl'] }] }
          const chosen = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
          if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true }
          path = chosen.filePath
        } else if (existsSync(path)) {
          const accepted = await ports.confirm(agent, { title: '覆盖导出文件？', message: `将覆盖 ${path}。原始会话文件不会修改。`, acceptLabel: '覆盖' })
          if (!accepted) return { ok: false, cancelled: true }
        }
        const stale = fresh()
        if (stale) return stale
        const snapshot = await agent.sessionEntries()
        if (!snapshot.ok) return snapshot
        const result = exportSessionJsonl({ sourcePath: sourceFile, outputPath: path, overwrite: true, leafId: snapshot.leafId })
        return result.ok ? { ok: true, path: result.outputPath } : result
      }
      if (request.action === 'share') {
        if (!sourceFile) return { ok: false, error: '当前会话尚未保存' }
        const accepted = await ports.confirm(agent, {
          title: '上传当前会话到 GitHub gist？',
          message: '导出的 HTML 包含整个会话（包括已放弃的分支），可能含提示词、代码、工具输出、系统提示、工具定义和凭证。将使用你已登录的 GitHub CLI 创建非公开 gist；任何持有链接的人都可能查看。此操作会上传数据到 GitHub，不能用本地撤销收回副本。请确认已检查会话内容。',
          acceptLabel: '确认上传'
        })
        if (!accepted) return { ok: false, cancelled: true }
        const stale = fresh()
        if (stale) return stale
        const dir = await mkdtemp(join(tmpdir(), 'inkstone-share-'))
        try {
          const exported = await agent.exportHtml(join(dir, 'session.html'))
          if (!exported.ok || !exported.path) return { ok: false, error: exported.error ?? '无法准备分享文件' }
          const changed = fresh()
          if (changed) return changed
          const result = await shareViaGist({ htmlPath: exported.path, beforeUpload: () => fresh() === null })
          return result.ok ? { ok: true, url: result.viewerUrl } : result
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      if (request.action === 'set-trust') {
        const accepted = await ports.confirm(agent, {
          title: request.trusted ? '信任当前项目？' : '取消当前项目信任？',
          message: `${cwd}\n${request.trusted ? '信任后，pi 可以加载该项目及已信任根下的项目级扩展、技能、模板和设置。它们可能执行代码。只信任你了解的项目。' : '保存不信任决定后，将重新创建当前空闲 pi 运行实例，使项目级资源退出；会话文件保留。'}`,
          acceptLabel: request.trusted ? '信任并应用' : '取消信任并应用'
        })
        if (!accepted) return { ok: false, cancelled: true }
        const stale = fresh()
        if (stale) return stale
      }
      return await ports.runtime(agent, request)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      operations.delete(agent)
    }
  })
}
