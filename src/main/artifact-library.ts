import { stat } from 'node:fs/promises'
import type { SessionSummary } from '../shared/ipc'
import type { ArtifactLibraryItem } from '../shared/artifact-library'
import { ArtifactStore, legacySessionKey } from './artifacts'

async function usable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

export async function listArtifactLibrary(rootDir: string, sessions: SessionSummary[]): Promise<ArtifactLibraryItem[]> {
  const groups = await new ArtifactStore(rootDir).listAll()
  const byKey = new Map<string, SessionSummary>()
  for (const session of sessions) {
    byKey.set(`s-${session.id}`, session)
    byKey.set(legacySessionKey(session.path), session)
  }
  const items: ArtifactLibraryItem[] = []
  for (const group of groups) {
    const session = byKey.get(group.sessionKey) ?? null
    const latest = new Map<string, { messageId: string; artifact: ArtifactLibraryItem['artifact']; versions: Set<number> }>()
    for (const item of group.items) {
      const version = item.artifact.version ?? 1
      const prev = latest.get(item.artifact.sourceId)
      const versions = prev?.versions ?? new Set<number>()
      versions.add(version)
      if (!prev || version >= (prev.artifact.version ?? 1)) latest.set(item.artifact.sourceId, { messageId: item.messageId, artifact: item.artifact, versions })
    }
    for (const entry of latest.values()) {
      items.push({
        sessionId: session?.id ?? group.sessionId,
        sessionPath: session?.path ?? null,
        sessionTitle: session?.title ?? null,
        cwd: session?.cwd ?? null,
        messageId: entry.messageId,
        versions: entry.versions.size,
        artifact: entry.artifact
      })
    }
  }
  const available = await Promise.all(items.map((item) => usable(item.artifact.path)))
  return items
    .map((item, index) => (available[index] ? item : { ...item, artifact: { ...item.artifact, unavailable: true } }))
    .sort((a, b) => b.artifact.createdAt - a.artifact.createdAt)
}
