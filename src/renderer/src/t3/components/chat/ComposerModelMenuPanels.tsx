import { useEffect, useRef, useSyncExternalStore } from 'react'
import { ShieldOffIcon, ZapIcon } from 'lucide-react'
import type { PermissionMode } from '../../../../../shared/approval'
import { useT } from '../../../i18n'
import { FluidEffortSlider } from '../../../ui/FluidEffortSlider'
import { Switch } from '../../../ui/Switch'
import { VerticalEffortSlider } from '../../../ui/VerticalEffortSlider'
import type { ComposerTraitsAdapter } from '../../adapters/composer-thinking'
import { cx } from '../../../ui/cx'
import { levelFallbackLabel } from './EffortSlider'

const WHEEL_STEP_INTERVAL_MS = 130
const WHEEL_STEP_DELTA = 4
const NARROW_MENU_QUERY = '(max-width: 720px)'

function subscribeNarrow(listener: () => void): () => void {
  const query = window.matchMedia(NARROW_MENU_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

function narrowSnapshot(): boolean {
  return window.matchMedia(NARROW_MENU_QUERY).matches
}

export function useNarrowModelMenu(): boolean {
  return useSyncExternalStore(subscribeNarrow, narrowSnapshot)
}

export function FastBolt(props: { className?: string; label?: string }) {
  return (
    <span
      className={cx('composer-fast-bolt', props.className)}
      data-composer-fast-badge="true"
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
    >
      <ZapIcon className="composer-fast-bolt__icon" aria-hidden="true" />
      <span className="composer-fast-bolt__flash" aria-hidden="true" />
    </span>
  )
}

export function ComposerReasoningPanel({ traits }: { traits: ComposerTraitsAdapter }) {
  const narrow = useNarrowModelMenu()
  const { descriptor, levels } = traits
  const current = descriptor.currentValue ?? 'off'
  const labelOf = (level: string) =>
    descriptor.options.find((option) => option.id === level)?.label ?? levelFallbackLabel(level)
  const blocked = traits.unsupportedReason !== null
  const panelRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef({ levels, current, blocked, select: traits.select })
  stateRef.current = { levels, current, blocked, select: traits.select }

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    let lastStepAt = 0
    const onWheel = (event: WheelEvent) => {
      const state = stateRef.current
      if (state.blocked || state.levels.length < 2) return
      if (Math.abs(event.deltaY) < WHEEL_STEP_DELTA) return
      event.preventDefault()
      const now = event.timeStamp || Date.now()
      if (now - lastStepAt < WHEEL_STEP_INTERVAL_MS) return
      lastStepAt = now
      const count = state.levels.length
      const index = Math.max(0, state.levels.indexOf(state.current))
      const next = state.levels[(index + (event.deltaY < 0 ? 1 : -1) + count) % count]
      if (next && next !== state.current) state.select(next)
    }
    panel.addEventListener('wheel', onWheel, { passive: false })
    return () => panel.removeEventListener('wheel', onWheel)
  }, [])

  const sliderProps = {
    label: descriptor.label,
    title: descriptor.label,
    levels,
    value: current,
    labelOf,
    disabled: blocked,
    onChange: (level: string) => {
      if (!blocked && level !== current) traits.select(level)
    }
  }

  return (
    <div
      ref={panelRef}
      className="composer-model-menu__reasoning"
      data-composer-effort-panel="true"
      data-orientation={narrow ? 'horizontal' : 'vertical'}
    >
      {narrow ? <FluidEffortSlider {...sliderProps} /> : <VerticalEffortSlider {...sliderProps} />}
      {blocked ? <p className="composer-model-menu__note">{traits.unsupportedReason}</p> : null}
    </div>
  )
}

export type ComposerSpeed = {
  fast: boolean
  onChange: (fast: boolean) => void
}

export function ComposerAccessFooter(props: {
  speed: ComposerSpeed | null
  mode: PermissionMode
  onModeChange: (mode: PermissionMode) => void
}) {
  const t = useT()
  const unrestricted = props.mode === 'all'
  return (
    <div className="composer-model-menu__access-row" data-composer-permissions data-permission-mode={props.mode}>
        {props.speed ? (
          <Switch
            className="composer-model-menu__switch"
            isSelected={props.speed.fast}
            onChange={(fast) => props.speed?.onChange(fast)}
            data-testid="speed-fast"
            data-fast={props.speed.fast ? 'true' : undefined}
          >
            <span className="composer-model-menu__switch-label">
              {props.speed.fast ? <FastBolt /> : <ZapIcon className="composer-model-menu__switch-icon" aria-hidden="true" />}
              {t('picker.speed.fast')}
            </span>
          </Switch>
        ) : (
          <span />
        )}
        <Switch
          className="composer-model-menu__switch"
          isSelected={unrestricted}
          onChange={(on) => props.onModeChange(on ? 'all' : 'danger')}
          data-testid="permission-all"
          data-unrestricted={unrestricted ? 'true' : undefined}
        >
          <span className="composer-model-menu__switch-label">
            <ShieldOffIcon className="composer-model-menu__switch-icon" aria-hidden="true" />
            {t('permission.label.all')}
          </span>
        </Switch>
    </div>
  )
}
