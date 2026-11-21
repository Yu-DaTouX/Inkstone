import type { AssistantArtifact, UIMessage } from '../../../../shared/ipc'
import { latestArtifactVersions } from '../artifacts/model'
import type { LiveHtmlTarget } from './live-html'

const EMPTY_ARTIFACTS: readonly AssistantArtifact[] = []

export function createPreviewManifestSelector(enabled: boolean) {
  let messages: readonly UIMessage[] | undefined
  let all: AssistantArtifact[] = []
  let latest = EMPTY_ARTIFACTS
  return (state: { messages: readonly UIMessage[] }): readonly AssistantArtifact[] => {
    if (!enabled) return EMPTY_ARTIFACTS
    if (state.messages === messages) return latest
    messages = state.messages
    const next: AssistantArtifact[] = []
    for (const message of messages) {
      if (message.artifacts) for (const artifact of message.artifacts) next.push(artifact)
    }
    if (next.length !== all.length || next.some((artifact, index) => artifact !== all[index])) {
      all = next
      const versions = latestArtifactVersions(next)
      if (versions.length !== latest.length || versions.some((artifact, index) => artifact !== latest[index])) latest = versions
    }
    return latest
  }
}

export function samePreviewPath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

export function livePreviewTarget(target: LiveHtmlTarget | null, sessionId: string | null | undefined, path: string | null): LiveHtmlTarget | null {
  return target && target.sessionId === sessionId && path && samePreviewPath(target.path, path) ? target : null
}
