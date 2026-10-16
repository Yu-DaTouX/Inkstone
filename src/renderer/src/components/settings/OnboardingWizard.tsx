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

/**
 * 首次使用向导：把「装完还要配什么」一次讲完。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它和「开始之前」自检清单不是一回事
 * ══════════════════════════════════════════════════════════════════
 *   · 清单（`Onboarding.tsx`）回答「现在这样能不能用」——检测 pi、凭证、
 *     命令行工具、连通性，从「关于」页随时打开。
 *   · 向导回答「怎么把它配成我想要的样子」——主题、提醒、模型接入、上下文，
 *     最后告诉用户主要入口在哪。
 *
 * ── 设计取舍 ──
 * · **每步当场落盘**：直接写既有设置键（`theme` / `backgroundPreset` /
 *   `fontUi` / `sound` / `autoCompactTokens`），不攒草稿到最后一起提交。
 *   中途关掉窗口，已经改过的部分保留 —— 用户看到的效果就是最终状态。
 * · **不复制第二份表单**：外观、提醒、接入、上下文都复用设置页里那几个
 *   组件（`BackgroundSetting` / `SoundTab` / `AuthTab` / `StepSlider`），
 *   向导里改的值和设置页看到的必然一致。
 * · **步骤条可点**：允许回看或直接跳到某一步，不强制线性走完。
 * · **可以随时退出**（右上角 ×），退出即标记看过，不再自动出现。
 */
const STEPS = ['welcome', 'theme', 'sound', 'auth', 'context', 'done'] as const
type WizardStep = (typeof STEPS)[number]

/** 最后一步列的入口，只写真实存在的行为（键位取自 `lib/host-actions.ts`）。 */
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

  /* 卡片本身就是一层模态：Esc 关闭 + 焦点圈定 + 通知主进程暂停快捷键 */
  const card = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(card, true, isTop)

  /* 切步后回到顶部：从「接入」切到「上下文」不该停在半中间 */
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

        {/* 步骤条：可点，允许回看或跳到后面 */}
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

/* ------------------------------------------------------------ 各步 */

/** 开场：说清要配几件事，以及每步都能改。 */
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

/** 外观：主题、背景、字体、字号，全部复用设置页的控件。 */
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

/** 提醒：整块复用设置页的提醒分区（开关、音量、逐项试听）。 */
function SoundStep() {
  const t = useT()
  return (
    <div className="wiz-sound">
      <p className="wiz-lead-desc">{t('wiz.soundDesc')}</p>
      <SoundTab />
    </div>
  )
}

/** 模型接入：整块复用「模型」设置页，含订阅登录与 API Key。 */
function AuthStep() {
  const t = useT()
  return (
    <div className="wiz-auth">
      <p className="wiz-lead-desc">{t('wiz.authDesc')}</p>
      <AuthTab />
    </div>
  )
}

/**
 * 上下文：只放一件用户此刻该做的决定 —— 自动压缩上限。
 *
 * 开关本身属于 pi（写在 pi 的 settings.json），砚不另设一个；
 * 这里只调砚的上限，并如实说明 pi 那边关着时它不生效。
 */
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

/** 收尾：告诉用户主要入口在哪，不是再配一项。 */
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
