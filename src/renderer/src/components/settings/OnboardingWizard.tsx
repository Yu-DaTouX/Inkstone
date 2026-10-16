import { useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { Icon, type IconName } from '../../icons/Icon'
import { BrandMark } from '../shell/BrandMark'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { Button, IconButton, Segmented, SettingRow, StepSlider } from '../ui'
import { AuthTab } from './AuthTab'
import { BackgroundSetting, FontSettings, FontSizeSettings } from './AppearanceCustomize'
import { SoundTab, useThemeSetter } from './Settings'
import { AUTO_COMPACT_STEPS, autoCompactAt, DEFAULT_AUTO_COMPACT_TOKENS } from '../../../../shared/context-limits'

const STEPS = ['welcome', 'theme', 'sound', 'auth', 'context', 'done'] as const
type WizardStep = (typeof STEPS)[number]

const ENTRIES: { icon: IconName; key: MessageKey }[] = [
  { icon: 'message-dots', key: 'wiz.entryInput' },
  { icon: 'terminal', key: 'wiz.entryCommand' },
  { icon: 'settings', key: 'wiz.entrySettings' },
  { icon: 'dock', key: 'wiz.entryTools' },
  { icon: 'phone', key: 'wiz.entryPhone' }
]

export function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [index, setIndex] = useState(0)
  const step: WizardStep = STEPS[index]
  const isLast = index === STEPS.length - 1

  const card = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(card, true, isTop)

  useEffect(() => {
    body.current?.scrollTo({ top: 0 })
  }, [index])

  return (
    <div className="ob-scrim" role="dialog" aria-modal="true" aria-label={t('wiz.title')}>
      <div className="ob-card wiz" ref={card} data-testid="wizard">
        <div className="ob-head">
          <span className="ob-logo">
            <BrandMark size={22} decorative />
          </span>
          <div>
            <div className="ob-title">{t('wiz.title')}</div>
            <div className="ob-sub">{t('wiz.sub')}</div>
          </div>
          <span className="spacer" />
          <IconButton
            icon="close"
            iconSize={14}
            className="ob-x"
            label={t('wiz.skip')}
            data-testid="wiz-close"
            onClick={onClose}
          />
        </div>

        <div className="wiz-steps" role="tablist" aria-label={t('wiz.title')}>
          {STEPS.map((id, i) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={i === index}
              className={`wiz-step ${i === index ? 'on' : ''} ${i < index ? 'past' : ''}`}
              data-testid={`wiz-step-${id}`}
              onClick={() => setIndex(i)}
            >
              <span className="wiz-dot" aria-hidden>
                {i < index ? <Icon name="check" size={12} /> : i + 1}
              </span>
              <span className="wiz-step-name">{t(`wiz.step.${id}` as MessageKey)}</span>
            </button>
          ))}
        </div>

        <div className="ob-body" ref={body} data-testid={`wiz-panel-${step}`}>
          {step === 'welcome' ? <WelcomeStep /> : null}
          {step === 'theme' ? <ThemeStep /> : null}
          {step === 'sound' ? <SoundStep /> : null}
          {step === 'auth' ? <AuthStep /> : null}
          {step === 'context' ? <ContextStep /> : null}
          {step === 'done' ? <DoneStep /> : null}
        </div>

        <div className="ob-foot">
          <span className="ob-foot-note" data-testid="wiz-progress">
            {t('wiz.stepOf', { n: index + 1, total: STEPS.length })}
          </span>
          <span className="spacer" />
          {index > 0 ? (
            <Button data-testid="wiz-back" onClick={() => setIndex((i) => Math.max(0, i - 1))}>
              {t('wiz.back')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            data-testid={isLast ? 'wiz-done' : 'wiz-next'}
            onClick={() => (isLast ? onClose() : setIndex((i) => Math.min(STEPS.length - 1, i + 1)))}
          >
            {isLast ? t('wiz.start') : t('wiz.next')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function WelcomeStep() {
  const t = useT()
  const items: { icon: IconName; key: MessageKey }[] = [
    { icon: 'moon', key: 'wiz.welcomeAppearance' },
    { icon: 'bell', key: 'wiz.welcomeSound' },
    { icon: 'key', key: 'wiz.welcomeAuth' },
    { icon: 'compact', key: 'wiz.welcomeContext' }
  ]
  return (
    <div className="wiz-lead">
      <h2 className="wiz-lead-title">{t('wiz.welcomeTitle')}</h2>
      <p className="wiz-lead-desc">{t('wiz.welcomeDesc')}</p>
      <ul className="wiz-list">
        {items.map((item) => (
          <li key={item.key}>
            <Icon name={item.icon} size={12} />
            <span>{t(item.key)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ThemeStep() {
  const t = useT()
  const theme = useStore((s) => s.settings?.theme) ?? 'dark'
  const setTheme = useThemeSetter()
  return (
    <div className="ui-rows">
      <SettingRow name={t('set.theme')} ctlClassName="seg">
        <Segmented
          label={t('set.theme')}
          value={theme}
          onChange={(value) => setTheme(value as 'dark' | 'light')}
          options={[
            { value: 'dark', label: t('set.dark'), icon: 'moon', testId: 'wiz-theme-dark' },
            { value: 'light', label: t('set.light'), icon: 'sun', testId: 'wiz-theme-light' }
          ]}
        />
      </SettingRow>
      <BackgroundSetting />
      <FontSettings />
      <FontSizeSettings />
    </div>
  )
}

function SoundStep() {
  const t = useT()
  return (
    <div className="wiz-sound">
      <p className="wiz-lead-desc">{t('wiz.soundDesc')}</p>
      <SoundTab />
    </div>
  )
}

function AuthStep() {
  const t = useT()
  return (
    <div className="wiz-auth">
      <p className="wiz-lead-desc">{t('wiz.authDesc')}</p>
      <AuthTab />
    </div>
  )
}

function ContextStep() {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const contextWindow = useStore((s) => s.stats?.contextUsage?.contextWindow) ?? 0
  const compactionOn = useStore((s) => s.session?.autoCompactionEnabled)
  const value = settings?.autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
  const effective = autoCompactAt(value, contextWindow)
  const k = (n: number): string => `${Math.round(n / 1000)}k`

  return (
    <div className="ui-rows">
      <p className="wiz-lead-desc">{t('wiz.ctxDesc')}</p>
      <SettingRow
        col
        ctlClassName="ctx-compact-ctl"
        name={t('wiz.ctxLimit')}
        desc={
          <span data-testid="wiz-ctx-now">
            {effective < value
              ? t('wiz.ctxClamped', { n: k(value), w: k(contextWindow), e: k(effective) })
              : t('wiz.ctxNow', { n: k(value) })}
          </span>
        }
      >
        <StepSlider
          values={AUTO_COMPACT_STEPS.map(String)}
          value={String(value)}
          onChange={(v) => void patchSettings({ autoCompactTokens: Number(v) })}
          label={t('wiz.ctxLimit')}
          format={(v) => k(Number(v))}
          colorOf={(v) => (autoCompactAt(Number(v), contextWindow) < Number(v) ? 'var(--fg-mute)' : 'var(--accent)')}
          testId="wiz-ctx"
          stopTestId={(v) => `wiz-ctx-${v}`}
        />
      </SettingRow>
      {compactionOn === false ? (
        <div className="wiz-warn" data-testid="wiz-ctx-off" role="status">
          {t('wiz.ctxOff')}
        </div>
      ) : null}
    </div>
  )
}

function DoneStep() {
  const t = useT()
  return (
    <div className="wiz-lead">
      <h2 className="wiz-lead-title">{t('wiz.doneTitle')}</h2>
      <p className="wiz-lead-desc">{t('wiz.doneDesc')}</p>
      <ul className="wiz-list">
        {ENTRIES.map((entry) => (
          <li key={entry.key}>
            <Icon name={entry.icon} size={12} />
            <span>{t(entry.key)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
