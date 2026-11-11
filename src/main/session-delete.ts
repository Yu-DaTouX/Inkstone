import { pick } from '../shared/ui-lang'
import { resolve } from 'node:path'
import type { SessionHost } from './session-host'
import { deleteSession, restoreSession, sessionsToDelete } from './sessions'
import { planHistoryRead } from '../shared/session-chain'
import { closeTerminalsForOwner } from './terminal'
import { closeBrowserForSessions } from './session-browser-cleanup'

function pathKey(file: string): string {
  const resolved = resolve(file)
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
}

function friendlyDeleteError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? (error instanceof Error && error.cause ? (error.cause as { code?: string }).code : undefined)
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return pick('会话文件正在被其他程序占用，关闭后再试', 'The session file is in use by another program; close it and try again')
  }
  return error instanceof Error ? error.message : String(error)
}

export async function deleteSessionChain(host: SessionHost, path: string): Promise<{ ok: boolean; undoToken?: string; error?: string }> {
  const tokens: string[] = []
  try {
    await host.sessionChains.load()
    const chain = host.sessionChains.chainOf(path)
    const targets = chain && chain.segments.length > 1 ? planHistoryRead(chain) : [path]
    const affected = new Set<string>(targets.map((target) => resolve(target)))
    const sessionIds = new Set<string>()
    for (const target of new Set([resolve(path), ...targets.map((item) => resolve(item))])) {
      for (const item of await sessionsToDelete(target).catch(() => [])) {
        affected.add(item.path)
        if (item.sessionId) sessionIds.add(item.sessionId)
      }
    }
    const affectedKeys = new Set([...affected].map(pathKey))
    for (const status of host.runners()?.statuses?.() ?? []) {
      if (status.sessionId && status.sessionFile && affectedKeys.has(pathKey(status.sessionFile))) sessionIds.add(status.sessionId)
    }
    const current = host.ac()?.getState()?.sessionFile
    if (current && affected.has(resolve(current))) {
      return { ok: false, error: pick('不能删除当前正在使用的会话', 'Cannot delete the session in use') }
    }
    for (const target of affected) await host.runners()?.stopBySessionFile(target)
    for (const target of targets) {
      tokens.push(await deleteSession(target, host.ac()?.getState()?.sessionFile))
    }
    for (const target of targets) closeTerminalsForOwner(target)
    await closeBrowserForSessions(sessionIds)
    await host.sessionChains.forget(path).catch(() => false)
    host.pushRunners()
    return { ok: true, undoToken: tokens.join('|') }
  } catch (e) {
    const remaining: string[] = []
    for (const token of tokens.reverse()) {
      try {
        await restoreSession(token)
      } catch {
        remaining.push(token)
      }
    }
    host.pushRunners()
    return {
      ok: false,
      error: `${friendlyDeleteError(e)}${remaining.length ? pick('；部分会话恢复失败，仍可使用撤销令牌重试恢复', '; some sessions failed to restore; retry with the undo token') : ''}`,
      ...(remaining.length ? { undoToken: remaining.join('|') } : {})
    }
  }
}
