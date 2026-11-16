import { uiText } from '../../i18n/ui-text'

export { subagentReviewGate } from '../../../../shared/subagent-review-gate'

export interface SubagentPatch {
  patch: string
  truncated: boolean
}

interface SubagentPatchIo {
  describeFiles(paths: string[]): Promise<Array<{ ok: boolean; path?: string; error?: string }>>
  readFileText(path: string): Promise<{ ok: boolean; text?: string; truncated?: boolean; error?: string }>
}

export async function loadSubagentPatch(patchPath: string, io?: SubagentPatchIo): Promise<SubagentPatch> {
  const api = io ?? (typeof window !== 'undefined' ? (window.yan as SubagentPatchIo | undefined) : undefined)
  if (!api?.describeFiles || !api.readFileText) throw new Error(uiText('state.error.fileBridgeUnavailable'))
  const granted = await api.describeFiles([patchPath])
  const first = granted[0]
  if (!first?.ok) throw new Error(first?.error ?? uiText('state.error.patchUnreadable'))
  const res = await api.readFileText(first.path ?? patchPath)
  if (!res.ok || typeof res.text !== 'string') throw new Error(res.error ?? uiText('state.error.patchReadFailed'))
  return { patch: res.text, truncated: res.truncated === true }
}
