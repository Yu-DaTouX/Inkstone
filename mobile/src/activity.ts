import { pick } from '../../src/shared/ui-lang'
import type { RemoteJob, RemoteNotice, RemoteQuotaWindow, RemoteWorkflow } from '../../src/shared/remote-protocol'

export interface ShownNotice extends RemoteNotice {
  at: number
}

export const NOTICE_SHOW_MS = 20_000
const NOTICE_KEEP = 10

export function addNotice(list: readonly ShownNotice[], notice: RemoteNotice, now: number): ShownNotice[] {
  const rest = list.filter((item) => item.id !== notice.id && now - item.at < NOTICE_SHOW_MS)
  return [...rest, { ...notice, at: now }].slice(-NOTICE_KEEP)
}

export function noticesFor(list: readonly ShownNotice[], sessionId: string | null, now: number, dismissed: ReadonlySet<string>): ShownNotice[] {
  return list.filter((item) => !dismissed.has(item.id) && now - item.at < NOTICE_SHOW_MS && (!item.sessionId || item.sessionId === sessionId)).slice(-2).reverse()
}

export function quotaPercent(window: Pick<RemoteQuotaWindow, 'used' | 'total'>): number | null {
  if (!(window.total > 0) || !Number.isFinite(window.used)) return null
  return Math.max(0, Math.min(100, Math.round((window.used / window.total) * 100)))
}

export function resetText(resetAt: number | undefined, now: number): string {
  if (!resetAt) return ''
  const minutes = Math.max(0, Math.round((resetAt - now) / 60_000))
  if (minutes < 1) return pick('即将重置', 'Resets soon')
  if (minutes < 60) return pick(`${minutes} 分钟后重置`, `Resets in ${minutes}m`)
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return pick(`${hours} 小时 ${minutes % 60} 分后重置`, `Resets in ${hours}h ${minutes % 60}m`)
  return pick(`${Math.round(hours / 24)} 天后重置`, `Resets in ${Math.round(hours / 24)}d`)
}

export function jobStateText(job: Pick<RemoteJob, 'state' | 'exitCode' | 'live'>): string {
  if (job.state === 'running') return pick('运行中', 'Running')
  if (job.state === 'stopping') return pick('正在停止', 'Stopping')
  if (job.state === 'timeout') return job.live ? pick('超时仍在跑', 'Timed out, still running') : pick('超时', 'Timed out')
  if (job.state === 'stopped') return pick('已停止', 'Stopped')
  if (job.state === 'matched') return pick('已等到目标输出', 'Matched expected output')
  if (typeof job.exitCode === 'number') return job.exitCode === 0 ? pick('完成', 'Done') : pick(`退出码 ${job.exitCode}`, `Exit ${job.exitCode}`)
  return pick('已结束', 'Ended')
}

export function workflowStatusText(run: Pick<RemoteWorkflow, 'status' | 'waitingQuota'>): string {
  if (run.status === 'running') return run.waitingQuota ? pick('等额度', 'Waiting for quota') : pick('运行中', 'Running')
  return {
    paused: pick('已暂停', 'Paused'),
    done: pick('完成', 'Done'),
    failed: pick('失败', 'Failed'),
    stopped: pick('已停止', 'Stopped'),
    interrupted: pick('已中断', 'Interrupted')
  }[run.status] ?? run.status
}

export function workflowProgressText(run: Pick<RemoteWorkflow, 'progress'>): string {
  const { total, done, failed, running } = run.progress
  if (!total) return ''
  return [pick(`${done}/${total} 完成`, `${done}/${total} done`), running ? pick(`${running} 进行中`, `${running} running`) : '', failed ? pick(`${failed} 失败`, `${failed} failed`) : ''].filter(Boolean).join(' · ')
}

export function workflowActions(run: Pick<RemoteWorkflow, 'canPause' | 'canResume' | 'canStop'>): Array<'pause' | 'resume' | 'stop'> {
  return [run.canPause ? 'pause' : null, run.canResume ? 'resume' : null, run.canStop ? 'stop' : null].filter((item): item is 'pause' | 'resume' | 'stop' => item !== null)
}

export function jobStoppable(job: Pick<RemoteJob, 'live' | 'state'>): boolean {
  return job.live && job.state !== 'stopping'
}

export type PatchLineKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx'

export const PATCH_LINES_MAX = 4000

export function patchLines(patch: string, max = PATCH_LINES_MAX): { lines: Array<{ kind: PatchLineKind; text: string }>; clipped: boolean } {
  const raw = patch.replace(/\r\n/g, '\n').split('\n')
  if (raw.length && raw[raw.length - 1] === '') raw.pop()
  const lines = raw.slice(0, max).map((text) => {
    const kind: PatchLineKind = text.startsWith('diff --git') || text.startsWith('+++ ') || text.startsWith('--- ') ? 'file'
      : text.startsWith('@@') ? 'hunk'
      : text.startsWith('+') ? 'add'
      : text.startsWith('-') ? 'del'
      : 'ctx'
    return { kind, text: text.length > 400 ? `${text.slice(0, 400)}…` : text }
  })
  return { lines, clipped: raw.length > max }
}
