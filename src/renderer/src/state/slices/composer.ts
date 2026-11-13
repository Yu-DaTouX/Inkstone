import type { Attachment } from '../../../../shared/ipc'
import { uiText } from '../../i18n/ui-text'
import { composerDraftForView, composerDraftKey, composerSubmitIdentity, recoveryRuntimeFor, sameComposerView } from '../composer-recovery'
import { sessionRuntimeKey, updateSessionRuntimeAt } from '../session-runtime'
import type { Store } from '../store'
import { draftSeedRuntime, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, writeDraftAttachments } from './queue-recovery'
import { pushNotice, type SliceContext } from './shared'

export type ComposerSlice = Pick<Store, 'composerInsert' | 'editorInject' | 'composerFocus' | 'queueRestore' | 'attachments' | 'setSessionDraft' | 'hydrateComposerDraft' | 'injectComposerText' | 'addAttachments' | 'addFileRefs' | 'addFileRefPaths' | 'removeAttachment' | 'dropSentAttachments' | 'clearAttachments' | 'pickImages' | 'pickFiles' | 'insertIntoComposer' | 'clearComposerInsert' | 'consumeEditorInject' | 'requestComposerFocus' | 'consumeQueueRestore'>

export function createComposerSlice({ set, get }: SliceContext): ComposerSlice {
  return {
  composerInsert: null,
  editorInject: null,
  composerFocus: { tick: 0, at: 0 },
  queueRestore: null,
  attachments: [],
  setSessionDraft: (value, key) => {
    const current = get()
    key = key ?? composerDraftKey(current)
    if (!key) return
    const entry = current.sessionRuntimes[key]
    if (entry?.draftInitialized && entry.draft === value) return
    set({
      sessionRuntimes: updateSessionRuntimeAt(current.sessionRuntimes, key, { draft: value }, draftSeedRuntime(current, key))
    })
  },
  hydrateComposerDraft: (key) => {
    const snapshot = composerDraftForView(get(), key)
    set({ attachments: snapshot.attachments })
  },
  injectComposerText: (text) => set({ editorInject: { text, mode: 'append' } }),
  addAttachments: (a, identity = composerSubmitIdentity(get())) => {
    if (!a.length || !identity.draftKey) return
    const current = get()
    const sameView = sameComposerView(current, identity)
    const runtime = recoveryRuntimeFor(current, identity)
    const draftKey = runtime ? sessionRuntimeKey(runtime) : identity.draftKey
    const existing = sameView ? current.attachments : current.sessionRuntimes[draftKey]?.draftAttachments ?? []
    const seen = new Set(existing.map((e) => `${e.name}|${e.size}|${e.path ?? ''}`))
    const fresh: Attachment[] = []
    for (const x of a) {
      const k = `${x.name}|${x.size}|${x.path ?? ''}`
      if (seen.has(k)) continue
      seen.add(k)
      fresh.push(x)
    }
    if (fresh.length === 0) return

    let next = [...existing, ...fresh].slice(0, MAX_ATTACHMENTS)

    const imgBytes = next.filter((x) => x.kind !== 'file').reduce((n, x) => n + x.size, 0)
    if (imgBytes > MAX_IMAGE_BYTES) {
      const kept: Attachment[] = []
      let acc = 0
      for (const x of next) {
        if (x.kind === 'file') {
          kept.push(x)
          continue
        }
        if (acc + x.size > MAX_IMAGE_BYTES) continue
        acc += x.size
        kept.push(x)
      }
      next = kept
      set({ notices: pushNotice(get().notices, 'error', uiText('state.attach.imagesTooLarge')) })
    }

    const after: Partial<Store> = sameView ? { attachments: next } : {}
    if (draftKey) after.sessionRuntimes = writeDraftAttachments(get(), draftKey, next)
    set(after)

    const sessionId = runtime?.sessionId || identity.sessionId
    if (sessionId && !sessionId.startsWith('pending:')) {
      for (const x of fresh.filter((item) => next.includes(item))) {
        if (x.kind === 'file' || !x.data) continue
        void window.yan.sources
          .addImage({ sessionId, name: x.name, mimeType: x.mimeType, base64: x.data })
          .catch(() =>
            set({ notices: pushNotice(get().notices, 'error', uiText('state.attach.imageSaveFailed')) })
          )
      }
    }
  },
  addFileRefs: async (files, identity = composerSubmitIdentity(get())) => {
    if (!files.length) return
    const paths: string[] = []
    for (const f of files) {
      try {
        const p = window.yan.pathForFile(f)
        if (p) paths.push(p)
      } catch {
      }
    }
    if (!paths.length) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.attach.noFilePath')) })
      return
    }

    await get().addFileRefPaths(paths, identity)
  },
  addFileRefPaths: async (paths, identity = composerSubmitIdentity(get())) => {
    const unique = [...new Set(paths.filter(Boolean))]
    if (!unique.length) return

    let infos: Awaited<ReturnType<typeof window.yan.describeFiles>>
    try {
      infos = await window.yan.describeFiles(unique)
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.cannotReference')) })
      return
    }

    const refs: Attachment[] = []
    const errors: string[] = []
    for (const info of infos) {
      if (!info.ok) {
        errors.push(uiText('state.attach.refEntry', { name: info.name, error: info.error ?? uiText('state.error.cannotReference') }))
        continue
      }
      refs.push({
        id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: info.name,
        mimeType: info.mimeType,
        size: info.size,
        data: '',
        preview: '',
        kind: 'file',
        path: info.path,
        isDirectory: info.isDirectory
      })
    }
    if (refs.length) get().addAttachments(refs, identity)
    if (errors.length) set({ notices: pushNotice(get().notices, 'error', errors.join(uiText('state.attach.refErrorsJoin'))) })
  },
  removeAttachment: (id) => {
    const current = get()
    const next = current.attachments.filter((a) => a.id !== id)
    const draftKey = composerDraftKey(current)
    set({
      attachments: next,
      ...(draftKey ? { sessionRuntimes: writeDraftAttachments(current, draftKey, next) } : {})
    })
  },
  dropSentAttachments: (sentIds, draftKeys) => {
    if (!sentIds.length) return
    const sent = new Set(sentIds)
    const current = get()
    let state: Store = current
    for (const key of new Set([...draftKeys, composerDraftKey(current)])) {
      const cached = key ? state.sessionRuntimes[key]?.draftAttachments ?? [] : []
      if (!cached.some((item) => sent.has(item.id))) continue
      state = { ...state, sessionRuntimes: writeDraftAttachments(state, key, cached.filter((item) => !sent.has(item.id))) }
    }
    const attachments = current.attachments.filter((item) => !sent.has(item.id))
    set({
      ...(attachments.length !== current.attachments.length ? { attachments } : {}),
      ...(state.sessionRuntimes !== current.sessionRuntimes ? { sessionRuntimes: state.sessionRuntimes } : {})
    })
  },
  clearAttachments: () => {
    const current = get()
    const draftKey = composerDraftKey(current)
    set({
      attachments: [],
      ...(draftKey ? { sessionRuntimes: writeDraftAttachments(current, draftKey, []) } : {})
    })
  },
  pickImages: async () => {
    const identity = composerSubmitIdentity(get())
    try {
      get().addAttachments(await window.yan.pickImages(), identity)
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.pickFailed')) })
    }
  },
  pickFiles: async () => {
    const identity = composerSubmitIdentity(get())
    try {
      const paths = await window.yan.pickFilePaths()
      if (paths.length) await get().addFileRefPaths(paths, identity)
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.pickFailed')) })
    }
  },
  insertIntoComposer: (text) => set({ composerInsert: text }),
  clearComposerInsert: () => set({ composerInsert: null }),
  consumeEditorInject: () => set({ editorInject: null }),
  requestComposerFocus: (target) => set({ composerFocus: { tick: get().composerFocus.tick + 1, at: Date.now(), sessionId: target.sessionId, path: target.path } }),
  consumeQueueRestore: () => set({ queueRestore: null }),
  }
}
