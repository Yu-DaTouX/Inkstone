import { useState, type ReactElement } from 'react'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { Button, Notice } from '../ui'
import { piExtensionSkipDetail, piExtensionSkipSummary } from '../../../shared/pi-extension-skip'
import { pick } from '../../../shared/ui-lang'

const dismissedSkips = new Set<string>()

function ExtensionSkipBanner(): ReactElement | null {
  const runnerId = useStore((s) => s.activeRunnerId)
  const skip = useStore((s) => s.runners.find((runner) => runner.id === s.activeRunnerId)?.extensionSkip)
  const [expanded, setExpanded] = useState(false)
  const [, setDismissals] = useState(0)
  if (!skip || !runnerId) return null
  const key = `${runnerId}\n${skip.mode}\n${skip.extensions.map((item) => item.path).join('\n')}`
  if (dismissedSkips.has(key)) return null
  return (
    <Notice
      tone="stall"
      compact
      className="v3-extension-skip"
      title={piExtensionSkipSummary(skip)}
      data-testid="v3-extension-skip"
      action={
        <div className="v3-extension-skip-actions">
          <Button size="sm" variant="ghost" aria-expanded={expanded} onPress={() => setExpanded((open) => !open)}>
            {expanded ? pick('收起', 'Hide details') : pick('详情', 'Details')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              dismissedSkips.add(key)
              setDismissals((count) => count + 1)
            }}
          >
            {pick('关闭', 'Dismiss')}
          </Button>
        </div>
      }
    >
      {expanded ? <div className="v3-extension-skip-detail">{piExtensionSkipDetail(skip)}</div> : null}
    </Notice>
  )
}

export function ConnBanner(): ReactElement | null {
  const t = useT()
  const conn = useStore((s) => s.conn)
  const connDetail = useStore((s) => s.connDetail)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const [retrying, setRetrying] = useState(false)
  if (conn !== 'exited' && conn !== 'error') return <ExtensionSkipBanner />
  return (
    <Notice
      tone="fail"
      compact
      className="v3-conn-banner"
      title={<span title={connDetail || undefined}>{t('conn.engineDown')}</span>}
      data-testid="v3-conn-banner"
      action={
        <Button
          size="sm"
          variant="secondary"
          isDisabled={retrying}
          onPress={() => {
            setRetrying(true)
            void window.yan.start().then(() => refreshSessions()).catch(() => undefined).finally(() => setRetrying(false))
          }}
        >
          {t('conn.retry')}
        </Button>
      }
    >
    </Notice>
  )
}
