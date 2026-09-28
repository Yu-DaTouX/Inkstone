/**
 * 资料库的 IPC 适配（`yan:library:*`）。
 *
 * 打开只收 `{ sourceId, version }`，没有「按路径找文件」的入口；
 * 引用判定只走 `refOutcome`，界面拿到的 outcome 就是唯一结论。
 */
import type { IpcRegistrar } from './registrar'
import { activeSources, refOutcome } from '../../shared/library'
import type { LibraryKind, LibraryOwner, SourceReference } from '../../shared/library'
import type { LibraryService } from '../library-service'
import type { SpaceStore } from '../space-store'

export interface LibraryIpcDeps {
  library: LibraryService
  /** 把资料挂到空间前核对空间存在 */
  spaces: SpaceStore
  /** 资料「加入对话」后，若该会话正在前台，立刻重装它的上下文 */
  refreshActiveSessionContext(sessionId: string): Promise<void>
}

export function registerLibraryIpc(ipc: IpcRegistrar, deps: LibraryIpcDeps): void {
  const { handle } = ipc
  const { library, spaces, refreshActiveSessionContext } = deps
  /*
   * ---- 资料库（实施-25 P03）----
   *
   * 与 sources（会话级旧模型）**并存**：旧 handler 与旧参数一个都没动，
   * 新增的是 librarySourceId 这一侧的引用（T03-7 的过渡）。
   *
   * 两条铁律体现在签名里：
   *   · 打开只收 `{ sourceId, version }` —— 没有「按路径找文件」的入口；
   *   · 判定只走 `refOutcome` —— 界面拿到的 outcome 就是唯一结论。
   */
  handle('yan:library:list', async (req?: { spaceId?: string | null }) => {
    await library.store.load()
    const doc = library.store.document()
    return {
      ok: true,
      sources: activeSources(doc, req?.spaceId),
      versions: doc.versions,
      refs: doc.refs.map((r) => ({ ...r, outcome: refOutcome(doc, r.ref) }))
    }
  })

  handle('yan:library:import', async (view: {
    kind: LibraryKind
    ref: string
    title: string
    spaceId?: string
    content?: string
    owner?: LibraryOwner
  }) => {
    if (!view || typeof view !== 'object') return { ok: false, error: '缺少导入参数' }
    return library.import({
      kind: view.kind,
      ref: view.ref,
      title: view.title,
      ...(view.spaceId ? { spaceId: view.spaceId } : {}),
      ...(view.content !== undefined ? { content: view.content } : {}),
      ...(view.owner ? { owner: view.owner } : {})
    })
  })

  handle('yan:library:open', async (ref: SourceReference, options?: { maxChars?: number }) => {
    if (!ref || typeof ref.sourceId !== 'string' || !ref.sourceId) {
      return { ok: false as const, outcome: 'missing' as const, error: '缺少引用' }
    }
    const version = Number(ref.version)
    if (!Number.isFinite(version) || version < 1) {
      return { ok: false as const, outcome: 'missing' as const, error: '引用的版本号非法' }
    }
    const res = await library.openRef({ sourceId: ref.sourceId, version }, options ?? {})
    return { ok: true as const, ...res }
  })

  handle('yan:library:remove', async (sourceId: string) => {
    const done = await library.store.removeSource(sourceId)
    return done ? { ok: true } : { ok: false, error: '资料不存在' }
  })

  handle('yan:library:restore', async (sourceId: string) => {
    const done = await library.store.restoreSource(sourceId)
    return done ? { ok: true } : { ok: false, error: '资料不存在或未被移除' }
  })

  handle('yan:library:rename', async (sourceId: string, title: string) => library.store.renameSource(sourceId, title))

  handle('yan:library:attach', async (sourceId: string, spaceId: string | null) => {
    if (spaceId !== null) {
      await spaces.load()
      if (!spaces.find(spaceId)) return { ok: false, error: '目标空间不存在' }
    }
    const done = await library.store.attachToSpace(sourceId, spaceId)
    return done ? { ok: true } : { ok: false, error: '资料不存在' }
  })

  handle('yan:library:verify', async (refs: SourceReference[]) => {
    const list = Array.isArray(refs) ? refs : []
    const res = await library.verifyAvailability(list)
    return { ok: true, ...res }
  })

  handle('yan:library:addRef', async (owner: LibraryOwner, ref: SourceReference) => {
    if (!owner || !ref) return { ok: false, error: '缺少引用方或引用' }
    const added = await library.store.addRef(owner, ref)
    /*
     * 「加入对话」后立刻重装上下文（T05-3）：否则用户会看到刚加的资料
     * 直到下一次切会话才进上下文 —— 那正是「界面显示加了、模型却看不到」。
     */
    if (owner.kind === 'session') await refreshActiveSessionContext(owner.id)
    return { ok: true, added }
  })

  handle('yan:library:promoteLegacy', async (req: {
    sessionId: string
    legacyId: string
    kind: LibraryKind
    title: string
    ref: string
    spaceId?: string
  }) => {
    if (!req || typeof req !== 'object') return { ok: false, error: '缺少参数' }
    return library.promoteLegacy(req)
  })
}
