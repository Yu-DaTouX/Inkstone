import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Dialog, SliderThumb, SliderTrack } from 'react-aria-components'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, Settings2, Star } from 'lucide-react'
import {
  Button,
  EmptyState,
  IconButton,
  Kbd,
  ListBox,
  ListBoxItem,
  Popover,
  SearchField,
  Separator,
  Slider,
  Toggle
} from '../ui'
import { PulseField, resolveColor } from './pulse-field'
import { APPEARANCE_EVENT } from '../lib/appearance'
import { requestSettingReveal } from '../features/settings/search/search-model'
import { useT } from '../i18n'
import { currentThinkingLevels, useStore } from '../state/store'
import {
  isFavorite,
  isHidden,
  shortWindow,
  sortByProviderThenNewest,
  toggleFavorite,
  withHidden
} from '../features/settings/models/models-model'
import { useModelsText } from '../features/settings/models/models-text'
import {
  thinkingCommitAction,
  thinkingDragAction,
  thinkingLevelIndex
} from '../features/composer/composer-layout'
import type { ModelBrand } from '../../../shared/model-brand'
import type { ModelInfo } from '../../../shared/ipc'
import { levelLabel, ThinkingBadge } from './ThinkingBadge'
import { UltracodeConfirmDialog } from './UltracodeConfirmDialog'
import { ModelBot } from './ModelBot'
import { brandLabel, brandOfModel, brandsOf } from './model-vendor'
import './model-thinking-picker.css'
import './ultracode.css'

export function thinkColor(level: string): string {
  return `var(--think-${level}, var(--fg3))`
}

function mixRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function isDarkTheme(): boolean {
  const theme = document.documentElement.dataset.theme
  if (theme) return theme === 'dark'
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

const keyOf = (m: Pick<ModelInfo, 'provider' | 'id'>): string => `${m.provider}/${m.id}`

const EMPTY: never[] = []

const HIDDEN_TOGGLE = '__hidden'

const ULTRACODE_OVERDRAG_PX = 28

export function ThinkingSection({
  levels,
  level,
  busy,
  onCommit,
  fallback,
  fallbackShort,
  ultracode = false,
  onUltracodeRequest,
  onUltracodeOff
}: {
  levels: readonly string[]
  level: string
  busy: boolean
  onCommit: (level: string) => void
  fallback?: string
  fallbackShort?: string
  ultracode?: boolean
  onUltracodeRequest?: () => void
  onUltracodeOff?: () => void
}) {
  const t = useT()
  const hasLevels = levels.length > 1
  const [preview, setPreview] = useState<string | null>(null)
  const headLevel = preview ?? level
  const headIndex = thinkingLevelIndex(levels, headLevel)
  const inputRef = useRef<HTMLInputElement>(null)

  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)
  const fieldRef = useRef<PulseField | null>(null)
  const palette = levels.join('|')
  const last = levels.length - 1
  const [overdrag, setOverdrag] = useState(false)
  const headIndexRef = useRef(headIndex)
  headIndexRef.current = headIndex
  const canUltracode = hasLevels && !!onUltracodeRequest && !ultracode && !busy

  const beginOverdrag = (): void => {
    if (!canUltracode) return
    let over = false
    const move = (event: PointerEvent): void => {
      const rect = trackRef.current?.getBoundingClientRect()
      over = !!rect && headIndexRef.current === last && event.clientX > rect.right + ULTRACODE_OVERDRAG_PX
      setOverdrag(over)
    }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setOverdrag(false)
      if (over) onUltracodeRequest?.()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  useEffect(() => {
    const input = inputRef.current
    if (!input || !canUltracode) return
    const onKey = (event: KeyboardEvent): void => {
      if (headIndexRef.current !== last) return
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'End' && event.key !== 'PageUp') return
      event.preventDefault()
      onUltracodeRequest?.()
    }
    input.addEventListener('keydown', onKey)
    return () => input.removeEventListener('keydown', onKey)
  }, [canUltracode, last, onUltracodeRequest])

  useEffect(() => {
    if (preview && preview === level) setPreview(null)
  }, [preview, level])

  useEffect(() => {
    if (!hasLevels) return
    inputRef.current?.setAttribute('aria-valuetext', levelLabel(t, headLevel))
  }, [hasLevels, headLevel, t])

  useEffect(() => {
    if (!hasLevels) return
    const canvas = canvasRef.current
    const host = trackRef.current
    const probe = probeRef.current
    if (!canvas || !host || !probe) return
    const engine = new PulseField(canvas, host)
    fieldRef.current = engine
    const paint = (): void => {
      const el = probeRef.current
      if (!el) return
      engine.setColors({
        levels: palette.split('|').map((l) => resolveColor(el, thinkColor(l))),
        off: mixRgb(resolveColor(el, 'var(--fg3)'), resolveColor(el, 'var(--surface)'), 0.72),
        dark: isDarkTheme()
      })
    }
    paint()
    const themes = new MutationObserver(paint)
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    window.addEventListener(APPEARANCE_EVENT, paint)
    return () => {
      themes.disconnect()
      window.removeEventListener(APPEARANCE_EVENT, paint)
      engine.dispose()
      fieldRef.current = null
    }
  }, [hasLevels, palette])

  useEffect(() => {
    if (!hasLevels) return
    fieldRef.current?.setLevel(headIndex, levels.length, !!busy)
  }, [hasLevels, palette, headIndex, levels.length, busy])

  const at = (index: number): number => (levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0)

  return (
    <>
      <div className="mtp-thinking-head">
        <span className="mtp-thinking-title" title={t('picker.thinkDesc')}>
          {t('picker.think')}
        </span>
        <span className="mtp-thinking-fill" />
        {hasLevels && (ultracode || overdrag) ? (
          <span className="mtp-head-level uc-head" data-pending={overdrag && !ultracode} data-testid="thinking-current" title={t('picker.deepDesc')}>
            <span key={ultracode ? 'on' : 'pending'} className="mtp-step-value">
              {ultracode ? 'Ultracode' : t('picker.deepRelease')}
            </span>
          </span>
        ) : hasLevels ? (
          <span className="mtp-head-level" data-level={headLevel} data-testid="thinking-current" title={t('picker.thinkDesc')}>
            <span key={headLevel} className="mtp-step-value">
              {levelLabel(t, headLevel)}
            </span>
          </span>
        ) : (
          <span className="mtp-head-level" data-muted="true" data-testid="thinking-current" title={fallback}>
            {fallbackShort}
          </span>
        )}
      </div>
      {hasLevels ? (
        <div className="mtp-step" data-level={headLevel} data-ultracode={ultracode || overdrag} onPointerDownCapture={beginOverdrag}>
          <Slider
            className="mtp-slider"
            style={{ '--mtp-pct': `${at(headIndex)}%` } as CSSProperties}
            aria-label={t('picker.think')}
            minValue={0}
            maxValue={Math.max(0, levels.length - 1)}
            step={1}
            value={headIndex}
            onChange={(next) => {
              const action = thinkingDragAction(levels, next as number)
              if (action.kind === 'preview') setPreview(action.level)
            }}
            onChangeEnd={(next) => {
              if (ultracode && (next as number) < last) onUltracodeOff?.()
              const action = thinkingCommitAction(levels, next as number, level)
              if (action.kind === 'commit') onCommit(action.level)
            }}
            isDisabled={busy}
            data-testid="thinking-stops"
          >
            {() => (
              <div className="ui-slider__row">
                <span ref={probeRef} className="mtp-probe" aria-hidden />
                <SliderTrack className="ui-slider__track mtp-track" ref={trackRef}>
                  <canvas ref={canvasRef} className="mtp-field" aria-hidden data-lit={headIndex > 0 ? '1' : '0'} />
                  <SliderThumb
                    index={0}
                    className="ui-slider__thumb mtp-thumb"
                    aria-label={t('picker.think')}
                    inputRef={inputRef}
                  />
                </SliderTrack>
              </div>
            )}
          </Slider>
          <div className="mtp-scale">
            {levels.map((l, i) => (
              <button
                key={l}
                type="button"
                tabIndex={-1}
                className="mtp-scale-item"
                style={{ left: `${at(i)}%` }}
                data-level={l}
                data-active={l === headLevel}
                data-testid={`thinking-${l}`}
                disabled={busy}
                onClick={() => {
                  if (ultracode) onUltracodeOff?.()
                  const action = thinkingCommitAction(levels, i, level)
                  if (action.kind === 'commit') onCommit(action.level)
                }}
              >
                {levelLabel(t, l)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

const FAVORITES_TAB = '__favorites'
const JUMP_LIMIT = 9

function jumpLabel(index: number): string {
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
  return `${mac ? '⌘' : 'Ctrl+'}${index + 1}`
}

export function ModelThinkingPicker({ className }: { className?: string } = {}) {
  const t = useT()
  const text = useModelsText()
  const session = useStore((s) => s.session)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const levels = useStore(currentThinkingLevels)
  const setModel = useStore((s) => s.setModel)
  const setThinking = useStore((s) => s.setThinking)
  const setUltracode = useStore((s) => s.setUltracode)
  const patchSettings = useStore((s) => s.patchSettings)
  const authProviders = useStore((s) => s.authProviders)
  const loadAuthProviders = useStore((s) => s.loadAuthProviders)
  const notify = useStore((s) => s.notify)
  const openSettings = useStore((s) => s.openSettings)

  const [open, setOpen] = useState(false)
  const [thinkOpen, setThinkOpen] = useState(false)
  const [confirmDeep, setConfirmDeep] = useState(false)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('')
  const [hiddenView, setHiddenView] = useState(false)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const thinkRef = useRef<HTMLSpanElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const focusSearch = (): void => searchRef.current?.querySelector<HTMLInputElement>('input')?.focus()

  const cur =
    session?.model && session.model.id !== 'unknown' && session.model.name !== 'unknown' ? session.model : undefined
  const level = session?.thinkingLevel ?? 'off'
  const deep = !!session?.ultracode
  const hasLevels = levels.length > 1
  const busy = !!session?.isStreaming || !!session?.isCompacting
  const thinkingStatus = session?.thinkingLevelsStatus ?? (levels.length ? 'known' : 'unknown')
  const notDeclared = !hasLevels && thinkingStatus === 'known' && !!cur
  const customProvider = !!cur?.provider && /^yan-/.test(cur.provider)
  const showThinkingSection = hasLevels || thinkingStatus !== 'known' || notDeclared
  const capabilityNote = notDeclared
    ? t(customProvider ? 'picker.thinkNotDeclaredCustom' : 'picker.thinkNotDeclared')
    : thinkingStatus === 'unsupported'
      ? t('picker.thinkUnsupported')
      : t('picker.thinkUnknown')
  const capabilityShort = notDeclared
    ? levelLabel(t, 'off')
    : thinkingStatus === 'unsupported'
      ? t('picker.thinkUnsupportedShort')
      : t('picker.thinkUnknownShort')

  const favorites = settings?.modelFavorites ?? EMPTY
  const hidden = settings?.modelHidden ?? EMPTY
  const providerOrder = settings?.modelProviderOrder ?? EMPTY

  const ordered = useMemo(() => sortByProviderThenNewest(models, providerOrder), [models, providerOrder])
  const brands = useMemo(() => brandsOf(models), [models])
  const otherLabel = t('picker.otherModels')
  const favoriteModels = useMemo(
    () => favorites.map((choice) => models.find((m) => keyOf(m) === keyOf(choice))).filter((m): m is ModelInfo => !!m),
    [favorites, models]
  )

  useEffect(() => {
    if (open && !useStore.getState().models.length) void useStore.getState().reloadModels()
    if (open) void loadAuthProviders()
    if (!open) {
      setQuery('')
      setHiddenView(false)
      return
    }
    const current = cur ? models.find((m) => keyOf(m) === keyOf(cur)) : undefined
    setTab(current && !isFavorite(favorites, current) ? brandOfModel(current) : favoriteModels.length ? FAVORITES_TAB : brands[0] ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const choose = async (m: ModelInfo): Promise<void> => {
    setOpen(false)
    if (cur && keyOf(cur) === keyOf(m)) return
    const result = await setModel(m.provider, m.id, true)
    if (!result.ok) notify('error', result.error ?? t('models.selectFailed'))
  }

  const chooseRef = useRef(choose)
  chooseRef.current = choose
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const index = Number(event.key) - 1
      if (!Number.isInteger(index) || index < 0 || index >= JUMP_LIMIT) return
      const target = favoriteModels[index]
      if (!target || busy) return
      event.preventDefault()
      void chooseRef.current(target)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [favoriteModels, busy])

  const needsAuth = (provider: string): boolean => {
    if (authProviders.length === 0) return false
    const info = authProviders.find((p) => p.id === provider || p.authKey === provider)
    return !!info && info.status !== 'ready'
  }

  const setModelHidden = (m: ModelInfo, hide: boolean): void => {
    const state = useStore.getState().settings
    void patchSettings({ modelHidden: withHidden(state?.modelHidden ?? [], [m], hide) }).catch(() => notify('error', t('models.selectFailed')))
  }

  const toggleModelFavorite = (m: Pick<ModelInfo, 'provider' | 'id' | 'name'>): void => {
    const state = useStore.getState().settings
    const adding = !isFavorite(state?.modelFavorites ?? [], m)
    const unhide = adding && isHidden(state?.modelHidden ?? [], m)
    void patchSettings({
      modelFavorites: toggleFavorite(state?.modelFavorites ?? [], m),
      ...(unhide ? { modelHidden: withHidden(state?.modelHidden ?? [], [m], false) } : {})
    })
      .then(() => {
        if (unhide) notify('info', text('pickerUnhidden').replace('{name}', m.name))
      })
      .catch(() => notify('error', t('models.selectFailed')))
  }

  const q = query.trim().toLowerCase()
  const hiddenOf = (m: ModelInfo): boolean => isHidden(hidden, m) && !isFavorite(favorites, m)
  const inTab = ordered.filter((m) => brandOfModel(m) === tab)
  const rows: ModelInfo[] = q
    ? ordered.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q))
    : hiddenView
      ? inTab.filter(hiddenOf)
      : tab === FAVORITES_TAB
        ? favoriteModels
        : inTab.filter((m) => !hiddenOf(m))
  const hiddenCount = !q && !hiddenView && tab !== FAVORITES_TAB ? inTab.filter(hiddenOf).length : 0
  const providerSpread = new Set(rows.map((m) => m.provider)).size > 1
  const showProvider = !!q || tab === FAVORITES_TAB || providerSpread
  const selectedKey = cur ? keyOf(cur) : undefined
  const tabLabel = tab === FAVORITES_TAB ? t('models.favorites') : brands.includes(tab as ModelBrand) ? brandLabel(tab as ModelBrand, otherLabel) : ''

  return (
    <div className={`mtp-wrap ${className ?? ''}`}>
      <span className="mtp-anchor" ref={triggerRef}>
        <Button
          variant="ghost"
          className="mtp-trigger"
          data-state={cur ? 'ready' : 'unknown'}
          aria-haspopup="dialog"
          aria-expanded={open}
          isDisabled={busy}
          data-testid="model-picker"
          onPressStart={(e) => { if (e.pointerType === 'mouse') setOpen((v) => !v) }}
          onPress={(e) => { if (e.pointerType !== 'mouse') setOpen((v) => !v) }}
        >
          {cur ? <ModelBot className="mtp-bot" brand={brandOfModel(cur)} mood="icon" size={16} /> : null}
          <span className="mtp-model" data-testid="model-picker-name">
            {cur ? cur.name : t('picker.notReady')}
          </span>
          <ChevronDown className="mtp-chev" size={12} aria-hidden />
        </Button>
      </span>

      {showThinkingSection ? (
        <span className="mtp-anchor" ref={thinkRef}>
          <Button
            variant="ghost"
            className="mtp-trigger mtp-think-trigger"
            data-level={level}
            aria-haspopup="dialog"
            aria-expanded={thinkOpen}
            isDisabled={busy}
            data-testid="thinking-picker"
            onPressStart={(e) => { if (e.pointerType === 'mouse') setThinkOpen((v) => !v) }}
            onPress={(e) => { if (e.pointerType !== 'mouse') setThinkOpen((v) => !v) }}
          >
            <span className="mtp-think-icon" aria-hidden>{t('picker.thinkShort')}</span>
            {deep ? (
              <span className="uc-badge" data-testid="ultracode-badge" title={t('picker.deepDesc')}>Ultracode</span>
            ) : hasLevels ? (
              <ThinkingBadge level={level} data-testid="thinking-badge" />
            ) : (
              <span className="mtp-model">{capabilityShort}</span>
            )}
            <ChevronDown className="mtp-chev" size={12} aria-hidden />
          </Button>
        </span>
      ) : null}

      <Popover
        className="mtp-pop"
        isOpen={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        placement="top start"
        offset={8}
      >
        <Dialog className="mtp-dialog" aria-label={t('picker.searchModel')}>
          <nav className="mtp-rail" aria-label={t('models.provider')}>
            {favoriteModels.length ? (
              <>
                <Toggle
                  size="md"
                  icon
                  className="mtp-rail-btn"
                  isSelected={tab === FAVORITES_TAB && !q}
                  aria-label={t('models.favorites')}
                  tooltip={t('models.favorites')}
                  tooltipPlacement="end"
                  data-testid="model-picker-tab-favorites"
                  onPress={() => { setTab(FAVORITES_TAB); setHiddenView(false); setQuery(''); focusSearch() }}
                >
                  <Star size={16} fill="currentColor" aria-hidden />
                </Toggle>
                <Separator className="mtp-rail-sep" />
              </>
            ) : null}
            {brands.map((brand) => (
              <Toggle
                key={brand}
                size="md"
                icon
                className="mtp-rail-btn"
                isSelected={tab === brand && !q}
                aria-label={brandLabel(brand, otherLabel)}
                tooltip={brandLabel(brand, otherLabel)}
                tooltipPlacement="end"
                data-testid={`model-picker-tab-${brand}`}
                onPress={() => { setTab(brand); setHiddenView(false); setQuery(''); focusSearch() }}
              >
                <ModelBot className="mtp-bot" brand={brand} mood="icon" size={20} />
              </Toggle>
            ))}
            <span className="mtp-rail-fill" />
            <IconButton
              className="mtp-rail-btn"
              aria-label={text('pickerManage')}
              tooltip={text('pickerManage')}
              tooltipPlacement="end"
              data-testid="model-picker-manage"
              onPress={() => {
                setOpen(false)
                openSettings('models')
                requestSettingReveal({ section: 'models', id: 'models-visibility' })
              }}
            >
              <Settings2 size={16} aria-hidden />
            </IconButton>
          </nav>

          <div className="mtp-main">
            <SearchField
              ref={searchRef}
              className="mtp-search"
              aria-label={t('picker.searchModel')}
              placeholder={t('picker.searchModel')}
              value={query}
              onChange={setQuery}
              autoFocus
            />
            {hiddenView && !q ? (
              <Button
                variant="ghost"
                size="sm"
                className="mtp-subhead"
                icon={<ChevronLeft size={14} />}
                onPress={() => setHiddenView(false)}
              >
                <span>{tabLabel}</span>
                <span className="mtp-subhead-note">{text('pickerHiddenTag')}</span>
              </Button>
            ) : null}
            <div className="mtp-scroll">
              {rows.length || hiddenCount ? (
                <ListBox
                  className="mtp-list"
                  aria-label={t('picker.searchModel')}
                  selectionMode="single"
                  selectedKeys={selectedKey ? [selectedKey] : []}
                  onSelectionChange={(keys) => {
                    const key = keys === 'all' ? undefined : [...keys][0]
                    if (key === HIDDEN_TOGGLE) {
                      setHiddenView(true)
                      return
                    }
                    const hit = models.find((model) => keyOf(model) === key)
                    if (hit) void choose(hit)
                  }}
                >
                  {rows.map((m) => {
                    const fav = isFavorite(favorites, m)
                    const jump = favoriteModels.findIndex((f) => keyOf(f) === keyOf(m))
                    const modelHidden = hiddenOf(m)
                    return (
                      <ListBoxItem key={keyOf(m)} id={keyOf(m)} className="mtp-item" textValue={`${m.name} ${m.provider}`}>
                        {q || tab === FAVORITES_TAB ? <ModelBot className="mtp-bot" brand={brandOfModel(m)} mood="icon" size={16} /> : null}
                        <span className="mtp-item-main">
                          <span className="mtp-item-name">{m.name}</span>
                          {showProvider || needsAuth(m.provider) || modelHidden ? (
                            <span className="mtp-item-sub">
                              {m.provider}
                              {shortWindow(m.contextWindow) ? ` · ${shortWindow(m.contextWindow)}` : ''}
                              {needsAuth(m.provider) ? <span className="mtp-tag-auth"> · {t('picker.needsAuth')}</span> : null}
                              {modelHidden ? ` · ${text('pickerHiddenTag')}` : null}
                            </span>
                          ) : null}
                        </span>
                        {jump >= 0 && jump < JUMP_LIMIT ? <Kbd>{jumpLabel(jump)}</Kbd> : null}
                        {fav ? null : (
                          <IconButton
                            size="sm"
                            className="mtp-row-btn"
                            aria-label={`${modelHidden ? text('pickerShow') : text('pickerHide')}: ${m.name}`}
                            tooltip={modelHidden ? text('pickerShow') : text('pickerHide')}
                            data-testid="model-picker-hide"
                            onPress={() => setModelHidden(m, !modelHidden)}
                          >
                            {modelHidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
                          </IconButton>
                        )}
                        <IconButton
                          size="sm"
                          className="mtp-row-btn"
                          data-on={fav || undefined}
                          aria-label={`${fav ? text('pickerUnfavoriteCurrent') : text('pickerFavoriteCurrent')}: ${m.name}`}
                          tooltip={fav ? text('pickerUnfavoriteCurrent') : text('pickerFavoriteCurrent')}
                          data-testid="model-picker-favorite"
                          onPress={() => toggleModelFavorite(m)}
                        >
                          <Star size={14} fill={fav ? 'currentColor' : 'none'} aria-hidden />
                        </IconButton>
                        <Check className="mtp-check" size={14} data-on={selectedKey === keyOf(m) || undefined} aria-hidden />
                      </ListBoxItem>
                    )
                  })}
                  {hiddenCount ? (
                    <ListBoxItem
                      id={HIDDEN_TOGGLE}
                      className="mtp-item mtp-hidden-toggle"
                      textValue={text('pickerHidden').replace('{n}', String(hiddenCount))}
                      data-testid="model-picker-hidden-toggle"
                    >
                      <span className="mtp-item-main">
                        <span className="mtp-item-name">{text('pickerHidden').replace(' · {n}', '').replace('{n}', '')}</span>
                        <span className="mtp-item-sub">{t('picker.modelCount', { n: hiddenCount })}</span>
                      </span>
                      <ChevronRight size={14} aria-hidden />
                    </ListBoxItem>
                  ) : null}
                </ListBox>
              ) : (
                <EmptyState size="sm" className="mtp-empty" title={models.length ? t('picker.noMatch') : t('picker.noModels')} />
              )}
            </div>
          </div>
        </Dialog>
      </Popover>

      {showThinkingSection ? (
        <Popover
          variant="panel"
          className="mtp-think-pop"
          isOpen={thinkOpen}
          onOpenChange={setThinkOpen}
          triggerRef={thinkRef}
          placement="top start"
          offset={8}
        >
          <Dialog className="mtp-think-dialog" aria-label={t('picker.think')}>
            <div className="mtp-thinking" data-testid="model-thinking-settings">
              <ThinkingSection
                levels={levels}
                level={level}
                busy={busy}
                onCommit={(next) => void setThinking(next)}
                fallback={capabilityNote}
                fallbackShort={capabilityShort}
                ultracode={deep}
                onUltracodeRequest={session?.sessionId ? () => { setThinkOpen(false); setConfirmDeep(true) } : undefined}
                onUltracodeOff={() => void setUltracode(false)}
              />
              {!hasLevels ? (
                <div className="mtp-capability-note" data-testid="thinking-capability-status">
                  {capabilityNote}
                  {notDeclared && customProvider ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mtp-capability-action"
                      data-testid="thinking-open-settings"
                      onPress={() => {
                        setThinkOpen(false)
                        openSettings('auth')
                      }}
                    >
                      {t('picker.thinkOpenSettings')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Dialog>
        </Popover>
      ) : null}
      <UltracodeConfirmDialog
        isOpen={confirmDeep}
        onCancel={() => setConfirmDeep(false)}
        onConfirm={() => {
          setConfirmDeep(false)
          void setUltracode(true)
        }}
      />
    </div>
  )
}
