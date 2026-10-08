/**
 * 持续关注的 IPC 适配（`yan:follow:*`）。
 *
 * 没有「立即执行」这种 IPC：宿主不会自己去查。`due` 只说谁到点了，
 * `report` 接模型看完之后回报的结果。
 */
import type { IpcRegistrar } from './registrar'
import { runSummaryText } from '../../shared/follow'
import type { FollowStore } from '../follow-store'

export interface FollowIpcDeps {
  follows: FollowStore
}

export function registerFollowIpc(ipc: IpcRegistrar, deps: FollowIpcDeps): void {
  const { handle } = ipc
  const { follows } = deps
  /*
   * 持续关注（实施-25 P16）。
   *
   * 没有「立即执行」这种 IPC：宿主不会自己去查（那是后台花钱且用户看不见）。
   * `due` 只说谁到点了，`report` 接模型看完之后回报的结果。
   * 「应用没开就不跟进」这句话由 `FOLLOW_APP_ONLY_NOTE` 固定，
   * 界面与模型看到的是同一句。
   */
  /*
   * 只读入口先等首次加载：`list` / `views` / `due` / `runs` 是同步方法，
   * 不等的话「重启后还没发生任何写操作」时它们读到的是一份空文档 ——
   * 磁盘上的关注还在，界面上却什么都没有。
   */
  handle('yan:follow:list', async (spaceId?: string | null) => {
    await follows.load()
    return follows.list(spaceId)
  })
  handle('yan:follow:views', async (spaceId?: string | null) => {
    await follows.load()
    return follows.views(spaceId).map((view) => ({
      ...view,
      ...(view.lastRun ? { lastRunText: runSummaryText(view.lastRun) } : {})
    }))
  })
  handle('yan:follow:due', async () => {
    await follows.load()
    return follows.due()
  })
  handle('yan:follow:runs', async (input: { watchId: string; limit?: number }) => {
    await follows.load()
    return follows.runs(String(input?.watchId ?? ''), input?.limit)
  })
  handle('yan:follow:save', async (input: Parameters<typeof follows.save>[0]) => {
    const res = await follows.save(input ?? {})
    return res.ok ? { ok: true as const, watch: res.value } : { ok: false as const, code: res.code, error: res.error }
  })
  handle(
    'yan:follow:update',
    async (input: {
      id: string
      title?: unknown
      kind?: unknown
      cadence?: unknown
      intervalMinutes?: unknown
      resultPlace?: unknown
      notifyOn?: unknown
      enabled?: unknown
    }) => {
      const res = await follows.update(String(input?.id ?? ''), {
        title: input?.title,
        kind: input?.kind,
        cadence: input?.cadence,
        intervalMinutes: input?.intervalMinutes,
        resultPlace: input?.resultPlace,
        notifyOn: input?.notifyOn,
        enabled: input?.enabled
      })
      return res.ok ? { ok: true as const, watch: res.value } : { ok: false as const, code: res.code, error: res.error }
    }
  )
  handle('yan:follow:remove', async (id: string) => follows.remove(id))
  handle('yan:follow:report', async (input: Parameters<typeof follows.report>[0]) => {
    const res = await follows.report(input ?? {})
    return res.ok ? { ok: true as const, run: res.value.run, watch: res.value.watch } : { ok: false as const, code: res.code, error: res.error }
  })
}
