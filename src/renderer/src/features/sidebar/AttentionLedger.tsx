import type { JSX, ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { Button, cx, StatusDot, TermSpinner } from '../../ui'
import type { AttentionKind, AttentionTally } from './sidebar-model'
import { sidebarText } from './sidebar-text'

export function AttentionLedger({ tally, onJump }: { tally: AttentionTally; onJump: (kind: AttentionKind) => void }): JSX.Element | null {
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const items: { kind: AttentionKind; word: string; icon: ReactNode }[] = [
    { kind: 'running', word: own.attentionRunning, icon: <TermSpinner /> },
    { kind: 'awaiting', word: own.attentionAwaiting, icon: <StatusDot kind="awaiting" /> },
    { kind: 'unread', word: own.attentionUnread, icon: <StatusDot kind="ready" /> }
  ]
  const shown = items.filter((item) => tally[item.kind].length > 0)
  if (!shown.length) return null
  return (
    <span className="v3-side-pulse" role="group" aria-label={own.attention} data-testid="v3-side-pulse">
      {shown.map((item) => {
        const count = tally[item.kind].length
        const label = own.attentionJump.replace('{n}', String(count)).replace('{state}', item.word)
        return (
          <Button
            key={item.kind}
            size="xs"
            variant="ghost"
            className={cx('v3-side-pulse-item', item.kind === 'running' ? 'ui-signal-run' : item.kind === 'awaiting' ? 'ui-signal-ask' : undefined)}
            data-kind={item.kind}
            icon={item.icon}
            aria-label={label}
            tooltip={label}
            onPress={() => onJump(item.kind)}
            data-testid={`v3-pulse-${item.kind}`}
          >
            <span className="ui-num">{count}</span>
          </Button>
        )
      })}
    </span>
  )
}
