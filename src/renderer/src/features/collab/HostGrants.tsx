import { useState, type ReactElement } from 'react'
import type { PeerGrantView } from '../../../../shared/peer-protocol'
import type { Lang } from '../../i18n'
import { Badge, Button, Card, CardHead, CardTitle, EmptyState, Notice } from '../../ui'
import { fill, formatCollabTime, peerDisplayName, type CollabText } from './collab-text'
import { errorText, peerHostBridge, type RemoteStatusState } from './remote-status'

interface HostGrantsProps {
  text: CollabText
  lang: Lang
  remoteState: RemoteStatusState
  notify(tone: 'info' | 'fail', text: string): void
}

export function HostGrants({ text, lang, remoteState, notify }: HostGrantsProps): ReactElement {
  const [host] = useState(peerHostBridge)
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(() => new Set())
  const { remote, status, loaded, refresh } = remoteState
  const grants: readonly PeerGrantView[] = status?.grants ?? []

  if (!remote || !host) {
    return (
      <Notice tone="ask" compact role="note">
        {text.hostMissing}
      </Notice>
    )
  }

  if (loaded && grants.length === 0) return <EmptyState size="sm" align="start" title={text.hostEmpty} data-testid="v3-collab-host-empty" />

  const revoke = (grant: PeerGrantView): void => {
    const id = grant.connectionId
    const name = peerDisplayName(grant.deviceName)
    setRevoking((prev) => new Set(prev).add(id))
    void host
      .hostRevoke(id)
      .then(
        (ok) => notify(ok ? 'info' : 'fail', fill(ok ? text.hostRevoked : text.hostRevokeFailed, { computer: name })),
        (cause: unknown) => notify('fail', `${fill(text.hostRevokeFailed, { computer: name })}\n${errorText(cause)}`)
      )
      .finally(() => {
        setRevoking((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        void refresh()
      })
  }

  return (
    <ul className="collab-list">
      {grants.map((grant) => {
        const name = peerDisplayName(grant.deviceName)
        const projects = grant.projects.map((project) => project.name).join(' · ') || text.grantNone
        const ops = grant.operations.map((op) => text.ops[op] ?? op).join(' · ') || text.grantNone
        return (
          <Card as="li" key={grant.connectionId} className="collab-card" data-testid={`v3-collab-host-${grant.connectionId}`}>
            <CardHead className="collab-card__head">
              <CardTitle className="collab-card__title">{name}</CardTitle>
              <Badge tone={grant.activatedAt ? 'ok' : 'stall'}>{grant.activatedAt ? text.hostActive : text.hostPending}</Badge>
              <span className="collab-card__meta">{fill(text.hostSince, { time: formatCollabTime(grant.grantedAt, lang) })}</span>
            </CardHead>
            <p className="collab-hint">{fill(text.hostGrantLine, { projects, ops })}</p>
            <div className="collab-actions">
              <Button
                size="sm"
                variant="danger"
                isPending={revoking.has(grant.connectionId)}
                onPress={() => revoke(grant)}
                data-testid={`v3-collab-host-revoke-${grant.connectionId}`}
              >
                {text.hostRevoke}
              </Button>
            </div>
          </Card>
        )
      })}
    </ul>
  )
}
