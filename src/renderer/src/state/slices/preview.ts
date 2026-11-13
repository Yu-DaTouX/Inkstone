import type { FilePreview } from '../../../../shared/ipc'
import { fileResourceKey } from '../../../../shared/file-resource'
import { uiText } from '../../i18n/ui-text'
import type { Store } from '../store'
import { pushNotice, type SliceContext } from './shared'

export interface FilePreviewState {
  path: string
  cwd?: string
  line?: number
  lineEnd?: number
  loading: boolean
  data: FilePreview | null
  key?: string
  stale?: boolean
}

export type PreviewSlice = Pick<Store, 'filePreview' | 'previewFile'>

export function createPreviewSlice({ set, get }: SliceContext): PreviewSlice {
  return {
  filePreview: null,
  previewFile: async (path, line, cwd, lineEnd) => {
    set({ filePreview: { path, cwd, line, lineEnd, loading: true, data: null } })
    let data: Awaited<ReturnType<typeof window.yan.readPreview>>
    try { data = await window.yan.readPreview(path, line, cwd, lineEnd) }
    catch (error) {
      const cur = get().filePreview
      if (cur?.path === path && cur.cwd === cwd && cur.line === line && cur.lineEnd === lineEnd) {
        const failed = { ...cur, loading: false, data: null }
        set({ filePreview: failed, notices: pushNotice(get().notices, 'error', uiText('state.error.previewFailed', { error: String(error) })) })
      }
      return
    }
    const cur = get().filePreview
    if (!cur || cur.path !== path || cur.cwd !== cwd || cur.line !== line || cur.lineEnd !== lineEnd) return
    const settings = get().settings
    const workspaceRoot = cwd || get().session?.cwd || settings?.cwd || ''
    const projectId =
      settings?.projects.find(
        (project) => project.cwd.toLowerCase() === String(workspaceRoot).toLowerCase()
      )?.id ?? null
    const canonical = data?.abs || path
    const key = canonical
      ? fileResourceKey({ projectId: projectId ?? null, workspaceRoot, canonicalPath: canonical })
      : undefined
    const next: FilePreviewState = {
      path,
      cwd,
      line,
      lineEnd,
      loading: false,
      data,
      ...(key ? { key } : {})
    }
    set({ filePreview: next })
  },
  }
}
