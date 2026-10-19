import type { FilePreview } from '../../../../shared/ipc'

export type PreviewProblemKind = 'missing' | 'directory' | 'unreadable' | 'invalid' | 'not_file' | 'failed'

export interface PreviewProblem {
  kind: PreviewProblemKind
  creatable: boolean
  message: string
}

export type PreviewNote = 'outside' | 'encoding' | 'too_large'

export type PreviewBodyKind = 'text' | 'image' | 'media' | 'binary'

export function previewProblem(result: FilePreview): PreviewProblem | null {
  if (result.ok && !(result.issue === 'unreadable' && result.text === undefined)) return null
  const message = result.error ?? ''
  switch (result.issue) {
    case 'missing':
      return { kind: 'missing', creatable: result.creatable === true, message }
    case 'directory':
      return { kind: 'directory', creatable: false, message }
    case 'unreadable':
      return { kind: 'unreadable', creatable: false, message }
    case 'invalid':
      return { kind: 'invalid', creatable: false, message }
    case 'not_file':
      return { kind: 'not_file', creatable: false, message }
    default:
      return { kind: 'failed', creatable: false, message }
  }
}

export function previewNotes(result: FilePreview): PreviewNote[] {
  const notes: PreviewNote[] = []
  if (result.outsideRoot) notes.push('outside')
  if (result.issue === 'encoding') notes.push('encoding')
  if (result.issue === 'too_large' || result.truncated) notes.push('too_large')
  return notes
}

export function previewBodyKind(result: FilePreview): PreviewBodyKind {
  if (result.kind === 'image') return 'image'
  if (result.kind === 'text' && typeof result.text === 'string' && result.issue !== 'binary') return 'text'
  if (result.media === 'video' || result.media === 'audio' || result.media === 'pdf') return 'media'
  return 'binary'
}
