import { useCallback, useState, type ReactElement } from 'react'
import {
  Bell,
  Check,
  Gauge,
  KeyRound,
  MessageSquare,
  Palette,
  PanelLeft,
  Settings as SettingsIcon,
  Smartphone,
  Terminal
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import type { AppSettings } from '../../../../shared/ipc'
import { Button, Dialog, ListBoxItem, Modal, ModalOverlay, Radio, RadioGroup, Select, Spinner, Switch } from '../../ui'
import { Slider } from '../../ui/Slider'
import '../../ui/Slider.css'
import { AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS, autoCompactAt } from '../../../../shared/context-limits'
import {
  clampStepIndex,
  isFirstStep,
  isLastStep,
  nextStepIndex,
  prevStepIndex,
  stepAt,
  stepIndexOf,
  stepProgress,
  ONBOARDING_STEPS,
  type OnboardingStepDef,
  type OnboardingStepId
} from './onboarding-model'
import { onboardingText, type OnboardingText } from './onboarding-text'
import './onboarding.css'

export type OnboardingResult = 'done' | 'skip'

export interface OnboardingWizardProps {
  onClose: (result: OnboardingResult) => void
  initialStep?: OnboardingStepId
  onOpenSettings?: () => void
}

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`

function ListItem({ icon, label }: { icon: ReactElement; label: string }): ReactElement {
  return (
    <li className="v3-ob-item">
      <span className="v3-ob-item__icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </li>
  )
}

export function OnboardingWizard({ onClose, initialStep, onOpenSettings }: OnboardingWizardProps): ReactElement {
  const { lang } = useI18n()
  const text = onboardingText(lang)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const authReady = useStore((s) => s.authProviders.some((p) => p.status === 'ready'))

  const [index, setIndex] = useState(() => (initialStep ? stepIndexOf(initialStep) : 0))
  const [touched, setTouched] = useState<ReadonlySet<OnboardingStepId>>(() => new Set())
  const markTouched = useCallback((id: OnboardingStepId): void => {
    setTouched((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])
  const isDone = (id: OnboardingStepId): boolean => touched.has(id) || (id === 'auth' && authReady)
  const step = stepAt(index)
  const last = isLastStep(index)
  const progress = stepProgress(index)

  const openModelSettings = (): void => {
    if (onOpenSettings) onOpenSettings()
    else useStore.getState().openSettings('models')
    onClose('skip')
  }

  const renderPanel = (entry: OnboardingStepDef): ReactElement | null => {
    if (!settings && entry.id !== 'welcome' && entry.id !== 'auth' && entry.id !== 'done') {
      return (
        <p className="v3-ob-lead-desc" role="status">
          <Spinner /> {text.loading}
        </p>
      )
    }
    if (entry.kind === 'intro') return <WelcomeStep text={text} />
    if (entry.kind === 'outro') return <DoneStep text={text} />
    if (entry.id === 'auth') return <AuthStep text={text} onOpen={openModelSettings} />
    if (!settings) return null
    return (
      <SettingStep
        text={text}
        stepId={entry.id}
        settings={settings}
        patchSettings={patchSettings}
        onTouch={() => markTouched(entry.id)}
      />
    )
  }

  return (
    <ModalOverlay
      className="v3-ob-overlay"
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose('skip')
      }}
    >
      <Modal className="v3-ob-modal">
        <Dialog className="v3-ob-dialog" title={text.title} closeLabel={text.close}>
          <p className="v3-ob-subtitle">{text.subtitle}</p>

          <nav className="v3-ob-steps" aria-label={text.stepsLabel}>
            <ol className="v3-ob-steps__list">
              {ONBOARDING_STEPS.map((entry: OnboardingStepDef, i: number) => {
                const active = i === index
                const past = i < index
                const done = isDone(entry.id)
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="v3-ob-step"
                      data-active={active ? '1' : '0'}
                      data-past={past ? '1' : '0'}
                      data-done={done ? '1' : '0'}
                      aria-current={active ? 'step' : undefined}
                      data-testid={`v3-ob-step-${entry.id}`}
                      onClick={() => setIndex(clampStepIndex(i))}
                    >
                      <span className="v3-ob-step__dot" aria-hidden="true">
                        {done ? <Check size={12} /> : i + 1}
                      </span>
                      <span className="v3-ob-step__name">{text[stepLabelKey(entry.id)]}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </nav>

          <div className="v3-ob-body">
            {ONBOARDING_STEPS.map((entry, i) => (
              <div
                key={entry.id}
                className="v3-ob-stage"
                data-active={i === index ? '1' : '0'}
                aria-hidden={i === index ? undefined : true}
                data-testid={`v3-ob-panel-${entry.id}`}
              >
                {renderPanel(entry)}
              </div>
            ))}
          </div>

          <div className="v3-ob-foot">
            <span className="v3-ob-progress" data-testid="v3-ob-progress">
              {text.stepOf.replace('{n}', String(progress.n)).replace('{total}', String(progress.total))}
              {step.skippable ? <span className="v3-ob-optional"> · {text.optional}</span> : null}
            </span>
            <span className="v3-ob-spacer" />
            {!isFirstStep(index) ? (
              <Button data-testid="v3-ob-back" onPress={() => setIndex(prevStepIndex(index))}>
                {text.back}
              </Button>
            ) : null}
            <Button
              variant="primary"
              data-testid={last ? 'v3-ob-done' : 'v3-ob-next'}
              onPress={() => (last ? onClose('done') : setIndex(nextStepIndex(index)))}
            >
              {last ? text.start : text.next}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

function stepLabelKey(id: OnboardingStepId): keyof OnboardingText {
  switch (id) {
    case 'welcome':
      return 'stepWelcome'
    case 'theme':
      return 'stepTheme'
    case 'sound':
      return 'stepSound'
    case 'auth':
      return 'stepAuth'
    case 'context':
      return 'stepContext'
    case 'done':
      return 'stepDone'
  }
}

function WelcomeStep({ text }: { text: OnboardingText }): ReactElement {
  return (
    <div className="v3-ob-lead">
      <h2 className="v3-ob-lead-title">{text.welcomeTitle}</h2>
      <p className="v3-ob-lead-desc">{text.welcomeDesc}</p>
      <ul className="v3-ob-list">
        <ListItem icon={<Palette size={14} />} label={text.welcomeAppearance} />
        <ListItem icon={<Bell size={14} />} label={text.welcomeSound} />
        <ListItem icon={<KeyRound size={14} />} label={text.welcomeAuth} />
        <ListItem icon={<Gauge size={14} />} label={text.welcomeContext} />
      </ul>
    </div>
  )
}

function DoneStep({ text }: { text: OnboardingText }): ReactElement {
  return (
    <div className="v3-ob-lead">
      <h2 className="v3-ob-lead-title">{text.doneTitle}</h2>
      <p className="v3-ob-lead-desc">{text.doneDesc}</p>
      <ul className="v3-ob-list">
        <ListItem icon={<MessageSquare size={14} />} label={text.entryInput} />
        <ListItem icon={<Terminal size={14} />} label={text.entryTerminal} />
        <ListItem icon={<SettingsIcon size={14} />} label={text.entrySettings} />
        <ListItem icon={<PanelLeft size={14} />} label={text.entrySidebar} />
        <ListItem icon={<Smartphone size={14} />} label={text.entryPhone} />
      </ul>
    </div>
  )
}

function AuthStep({ text, onOpen }: { text: OnboardingText; onOpen: () => void }): ReactElement {
  return (
    <div className="v3-ob-lead">
      <h2 className="v3-ob-lead-title">{text.authTitle}</h2>
      <p className="v3-ob-lead-desc">{text.authDesc}</p>
      <p className="v3-ob-note" role="note">
        {text.authNote}
      </p>
      <div className="v3-ob-actions">
        <Button variant="primary" data-testid="v3-ob-open-models" onPress={onOpen}>
          {text.authOpen}
        </Button>
      </div>
      <p className="v3-ob-hint">{text.authModelHint}</p>
    </div>
  )
}

interface SettingStepProps {
  text: OnboardingText
  stepId: OnboardingStepId
  settings: AppSettings
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>
  onTouch: () => void
}

type StepProps = Omit<SettingStepProps, 'stepId'>

function SettingStep({ text, stepId, settings, patchSettings, onTouch }: SettingStepProps): ReactElement {
  if (stepId === 'theme') return <ThemeStep text={text} settings={settings} patchSettings={patchSettings} onTouch={onTouch} />
  if (stepId === 'sound') return <SoundStep text={text} settings={settings} patchSettings={patchSettings} onTouch={onTouch} />
  return <ContextStep text={text} settings={settings} patchSettings={patchSettings} onTouch={onTouch} />
}

function ThemeStep({ text, settings, patchSettings, onTouch }: StepProps): ReactElement {
  const theme = settings.theme === 'light' ? 'light' : 'dark'
  return (
    <div className="v3-ob-lead">
      <h2 className="v3-ob-lead-title">{text.themeTitle}</h2>
      <p className="v3-ob-lead-desc">{text.themeDesc}</p>
      <RadioGroup
        className="v3-ob-choice"
        label={text.themeLabel}
        value={theme}
        orientation="horizontal"
        onChange={(value) => {
          onTouch()
          void patchSettings({ theme: value === 'light' ? 'light' : 'dark' })
        }}
      >
        <Radio value="light" data-testid="v3-ob-theme-light">
          {text.themeLight}
        </Radio>
        <Radio value="dark" data-testid="v3-ob-theme-dark">
          {text.themeDark}
        </Radio>
      </RadioGroup>
      <p className="v3-ob-hint">{text.themeNote}</p>
    </div>
  )
}

function SoundStep({ text, settings, patchSettings, onTouch }: StepProps): ReactElement {
  const sound = settings.sound
  const volume = typeof sound.volume === 'number' ? sound.volume : 0.4
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? volume
  const commit = (value: number): void => {
    onTouch()
    setDraft(null)
    void patchSettings({ sound: { ...sound, volume: value } })
  }
  return (
    <div className="v3-ob-lead">
      <h2 className="v3-ob-lead-title">{text.soundTitle}</h2>
      <p className="v3-ob-lead-desc">{text.soundDesc}</p>
      <div className="v3-ob-row">
        <span className="v3-ob-row__text">
          <span className="v3-ob-row__label">{text.soundEnable}</span>
          <span className="v3-ob-row__desc">{text.soundEnableDesc}</span>
        </span>
        <Switch
          aria-label={text.soundEnable}
          isSelected={sound.enabled}
          data-testid="v3-ob-sound-toggle"
          onChange={(next) => {
            onTouch()
            void patchSettings({ sound: { ...sound, enabled: next } })
          }}
        />
      </div>
      <div className="v3-ob-row">
        <span className="v3-ob-row__text">
          <span className="v3-ob-row__label">{text.soundVolume}</span>
          <span className="v3-ob-row__desc">{Math.round(shown * 100)}%</span>
        </span>
        <Slider
          className="v3-ob-slider"
          aria-label={text.soundVolume}
          minValue={0}
          maxValue={1}
          step={0.05}
          value={shown}
          isDisabled={!sound.enabled}
          data-testid="v3-ob-sound-volume"
          onChange={(next) => setDraft(next as number)}
          onChangeEnd={(next) => commit(next as number)}
        />
      </div>
    </div>
  )
}

function ContextStep({ text, settings, patchSettings, onTouch }: StepProps): ReactElement {
  const contextWindow = useStore((s) => s.stats?.contextUsage?.contextWindow) ?? 0
  const limit = settings.autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
  const effective = autoCompactAt(limit, contextWindow)
  const nowText =
    contextWindow > 0 && effective < limit
      ? text.contextClamped.replace('{n}', kTokens(limit)).replace('{e}', kTokens(effective))
      : text.contextNow.replace('{n}', kTokens(limit))
  return (
    <div className="v3-ob-lead">
      <h2 className="v3-ob-lead-title">{text.contextTitle}</h2>
      <p className="v3-ob-lead-desc">{text.contextDesc}</p>
      <Select
        className="v3-ob-select"
        aria-label={text.contextLimit}
        selectedKey={String(limit)}
        onSelectionChange={(key) => {
          if (key == null) return
          onTouch()
          void patchSettings({ autoCompactTokens: Number(key) })
        }}
      >
        {AUTO_COMPACT_STEPS.map((value) => (
          <ListBoxItem key={value} id={String(value)}>
            {kTokens(value)}
          </ListBoxItem>
        ))}
      </Select>
      <p className="v3-ob-hint" data-testid="v3-ob-ctx-now">
        {nowText}
      </p>
      <p className="v3-ob-note" role="note">
        {text.contextNote}
      </p>
    </div>
  )
}
