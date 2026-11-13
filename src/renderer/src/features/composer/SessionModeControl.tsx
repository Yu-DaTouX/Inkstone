import { useState, type ReactElement } from 'react'
import { Eye, ListChecks, SlidersHorizontal } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover } from '../../ui'
import { ComposerBanner } from '../../t3/components/chat/ComposerBanner'
import type { SessionMode, SessionModeChange } from '../../../../shared/session-mode'

type ModeChoice = SessionMode | 'off'

const MODE_ICONS = { off: SlidersHorizontal, ask: Eye, plan: ListChecks } as const

function useSessionModeAction(): { busy: boolean; run: (change: SessionModeChange) => Promise<void> } {
  const setSessionMode = useStore((s) => s.setSessionMode)
  const [busy, setBusy] = useState(false)
  const run = async (change: SessionModeChange): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await setSessionMode(change)
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

export function SessionModeMenu(): ReactElement | null {
  const t = useT()
  const available = useStore((s) => !s.peekedSessionId && !!s.session?.sessionId)
  const mode: ModeChoice = useStore((s) => (s.peekedSessionId ? undefined : s.session?.sessionMode)) ?? 'off'
  const { busy, run } = useSessionModeAction()
  if (!available) return null
  const Icon = MODE_ICONS[mode]
  const label = t('composer.mode.label')
  const names: Record<ModeChoice, string> = { off: t('composer.mode.default'), ask: t('composer.mode.ask'), plan: t('composer.mode.plan') }
  const descriptions: Record<ModeChoice, string> = { off: t('composer.mode.defaultDesc'), ask: t('composer.mode.askDesc'), plan: t('composer.mode.planDesc') }
  return (
    <MenuTrigger>
      <IconButton
        data-t3-btn
        variant="ghost"
        size="md"
        aria-label={`${label}: ${names[mode]}`}
        title={`${label}: ${names[mode]}`}
        isDisabled={busy}
        data-testid="session-mode-toggle"
        data-mode={mode}
      >
        <Icon size={16} aria-hidden="true" />
      </IconButton>
      <Popover placement="top start">
        <Menu
          aria-label={label}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[mode]}
          onAction={(key) => {
            const next = String(key) as ModeChoice
            if (next !== mode) void run(next)
          }}
          data-testid="session-mode-menu"
        >
          {(['off', 'ask', 'plan'] as const).map((choice) => {
            const ChoiceIcon = MODE_ICONS[choice]
            return (
              <MenuItem
                key={choice}
                id={choice}
                textValue={names[choice]}
                checked="selection"
                icon={<ChoiceIcon size={14} />}
                description={descriptions[choice]}
                data-testid={`session-mode-${choice}`}
              >
                {names[choice]}
              </MenuItem>
            )
          })}
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}

export function SessionModeBanner(): ReactElement | null {
  const t = useT()
  const mode = useStore((s) => (s.peekedSessionId ? undefined : s.session?.sessionMode))
  const running = useStore((s) => !!(s.session?.isAgentRunning || s.session?.isStreaming))
  const { busy, run } = useSessionModeAction()
  if (!mode) return null
  const Icon = MODE_ICONS[mode]
  return (
    <ComposerBanner.Root data-testid="session-mode-banner" data-mode={mode}>
      <ComposerBanner.Row layout="wrap-actions" role="status">
        <ComposerBanner.Icon>
          <Icon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>{t(mode === 'plan' ? 'composer.mode.planBanner' : 'composer.mode.askBanner')}</ComposerBanner.Content>
        <ComposerBanner.Actions>
          {mode === 'plan' ? (
            <Button
              size="xs"
              variant="primary"
              isDisabled={busy || running}
              title={running ? t('composer.mode.approveBusy') : t('composer.mode.approve')}
              onPress={() => void run('approve')}
              data-testid="session-mode-approve"
            >
              {t('composer.mode.approve')}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            isDisabled={busy}
            aria-label={t(mode === 'plan' ? 'composer.mode.exitPlan' : 'composer.mode.exitAsk')}
            title={t(mode === 'plan' ? 'composer.mode.exitPlan' : 'composer.mode.exitAsk')}
            onPress={() => void run('off')}
            data-testid="session-mode-exit"
          >
            {t('composer.mode.exit')}
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  )
}
