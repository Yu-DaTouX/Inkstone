import type { AssistantArtifact } from './ipc'

export interface ArtifactLibraryItem {
  sessionId: string | null
  sessionPath: string | null
  sessionTitle: string | null
  cwd: string | null
  messageId: string
  versions: number
  artifact: AssistantArtifact
}

export interface ArtifactLibraryResult {
  items: ArtifactLibraryItem[]
}

export interface SaveInlineArtifactInput {
  sessionId: string
  messageId: string
  filename: string
  content: string
  sourceKey: string
}

export type SaveInlineArtifactResult = { ok: true; artifact: AssistantArtifact } | { ok: false; error: string }

export const INLINE_ARTIFACT_MAX_BYTES = 1024 * 1024

const INLINE_EXTENSIONS = ['.html', '.svg', '.md']

export function inlineArtifactFilename(raw: string): string | null {
  const name = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120)
  return INLINE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)) && name.length > 5 ? name : null
}
