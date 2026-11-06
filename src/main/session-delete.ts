import { resolve } from 'node:path'
import type { SessionHost } from './session-host'
import { deleteSession, restoreSession, sessionsToDelete } from './sessions'
import { planHistoryRead } from '../shared/session-chain'
import { closeTerminalsForOwner } from './terminal'

export async function deleteSessionChain(host: SessionHost, path: string): Promise<{ ok: boolean; undoToken?: string; error?: string }> {
  const tokens: string[] = []
  try {
    await host.sessionChains.load()
    const chain = host.sessionChains.chainOf(path)
    const targets = chain && chain.segments.length > 1 ? planHistoryRead(chain) : [path]
    const affected = new Set<string>(targets.map((target) => resolve(target)))
    for (const item of await sessionsToDelete(resolve(path)).catch(() => [])) affected.add(item.path)
    const current = host.ac()?.getState()?.sessionFile
    if (current && affected.has(resolve(current))) {
      return { ok: false, error: '不能删除当前正在使用的会话' }
    }
    for (const target of affected) await host.runners()?.stopBySessionFile(target)
    for (const target of targets) {
      tokens.push(await deleteSession(target, host.ac()?.getState()?.sessionFile))
    }
    for (const target of targets) closeTerminalsForOwner(target)
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
      error: `${e instanceof Error ? e.message : String(e)}${remaining.length ? '；部分会话恢复失败，仍可使用撤销令牌重试恢复' : ''}`,
      ...(remaining.length ? { undoToken: remaining.join('|') } : {})
    }
  }
}
