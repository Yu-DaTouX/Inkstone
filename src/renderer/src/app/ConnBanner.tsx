import { useState, type ReactElement } from 'react'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { Button, Notice } from '../ui'

export function ConnBanner(): ReactElement | null {
  const t = useT()
  const conn = useStore((s) => s.conn)
  const connDetail = useStore((s) => s.connDetail)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const [retrying, setRetrying] = useState(false)
  if (conn !== 'exited' && conn !== 'error') return null
  return (
    <Notice
      tone="fail"
      className="v3-conn-banner"
      title={t('conn.engineDown')}
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
      {connDetail || null}
    </Notice>
  )
}
