import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Dialog,
  Header,
  Input,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  SearchField,
  Separator,
  SliderThumb,
  SliderTrack
} from 'react-aria-components'
import { Check, ChevronDown, Search, Star } from 'lucide-react'
import { Button, Popover, Slider, Select, ListBoxItem as ProviderItem } from '../ui'
import { PulseField, resolveColor } from './pulse-field'
import { APPEARANCE_EVENT } from '../lib/appearance'
import { useT } from '../i18n'
import { currentThinkingLevels, useStore } from '../state/store'
import {
  buildPickerSections,
  isFavorite,
  parseRecentModels,
  recentModelsAfterPick,
  RECENT_STORAGE_KEY,
  shortWindow,
  toggleFavorite,
  type PickerSection
} from '../features/settings/models/models-model'
import { useModelsText } from '../features/settings/models/models-text'
import {
  thinkingCommitAction,
  thinkingDragAction,
  thinkingLevelIndex
} from '../features/composer/composer-layout'
import type { ModelChoice } from '../../../shared/model-selection'
import type { ModelInfo } from '../../../shared/ipc'
import { levelLabel, ThinkingBadge } from './ThinkingBadge'
import { UltracodeConfirmDialog } from './UltracodeConfirmDialog'
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
  const [confirmDeep, setConfirmDeep] = useState(false)
  useEffect(() => {
    if (open && !useStore.getState().models.length) void useStore.getState().reloadModels()
  }, [open])
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('')
  const [recent, setRecent] = useState<ModelChoice[]>(() => {
    if (typeof localStorage === 'undefined') return []
    try {
      return parseRecentModels(localStorage.getItem(RECENT_STORAGE_KEY))
    } catch {
      return []
    }
  })
  const triggerRef = useRef<HTMLSpanElement>(null)

  const cur =
    session?.model && session.model.id !== 'unknown' && session.model.name !== 'unknown' ? session.model : undefined
  const level = session?.thinkingLevel ?? 'off'
  const deep = !!session?.ultracode
  const requestUltracode = (): void => {
    setOpen(false)
    setConfirmDeep(true)
  }
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

  useEffect(() => {
    if (open) void loadAuthProviders()
  }, [open, loadAuthProviders])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const needsAuth = (provider: string): boolean => {
    if (authProviders.length === 0) return false
    const info = authProviders.find((p) => p.id === provider || p.authKey === provider)
    return !!info && info.status !== 'ready'
  }

  const favorites = settings?.modelFavorites ?? EMPTY
  const providerOrder = settings?.modelProviderOrder ?? EMPTY
  const sections = useMemo(
    () => buildPickerSections({ models: provider ? models.filter((m) => m.provider === provider) : models, favorites, recent, query, providerOrder }),
    [models, favorites, recent, query, providerOrder, provider]
  )

  const selectedKey = cur ? keyOf(cur) : undefined

  const sectionTitle = (section: PickerSection): string => {
    if (section.kind === 'favorites') return t('models.favorites')
    if (section.kind === 'recent') return text('pickerRecent')
    return section.id
  }

  const rememberRecent = (m: ModelInfo): void => {
    setRecent((current) => {
      const next = recentModelsAfterPick(current, m)
      try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next))
      } catch {
      }
      return next
    })
  }

  const choose = async (m: ModelInfo): Promise<void> => {
    if (cur && keyOf(cur) === keyOf(m)) {
      setOpen(false)
      return
    }
    const result = await setModel(m.provider, m.id, true)
    if (!result.ok) {
      notify('error', result.error ?? t('models.selectFailed'))
      return
    }
    rememberRecent(m)
    setOpen(false)
  }

  const curFavorite = cur ? isFavorite(favorites, cur) : false
  const toggleCurrentFavorite = async (): Promise<void> => {
    if (!cur) return
    try {
      await patchSettings({ modelFavorites: toggleFavorite(favorites, cur) })
    } catch {
      notify('error', t('models.selectFailed'))
    }
  }

  return (
    <div className={`mtp-wrap ${className ?? ''}`}>
      <span className="mtp-anchor" ref={triggerRef}>
        <Button
          variant="ghost"
          size="sm"
          className="mtp-trigger"
          data-state={cur ? 'ready' : 'unknown'}
          aria-haspopup="dialog"
          aria-expanded={open}
          isDisabled={busy}
          data-testid="model-picker"
          onPressStart={(e) => { if (e.pointerType === 'mouse') setOpen((v) => !v) }}
          onPress={(e) => { if (e.pointerType !== 'mouse') setOpen((v) => !v) }}
        >
          <span className="mtp-model" data-testid="model-picker-name">
            {cur ? cur.name : t('picker.notReady')}
          </span>
          {hasLevels && level !== 'off' ? (
            <>
              <span className="mtp-trigger-sep" aria-hidden>·</span>
              <ThinkingBadge level={level} data-testid="thinking-badge" />
            </>
          ) : null}
          {deep ? (
            <>
              <span className="mtp-trigger-sep" aria-hidden>·</span>
              <span className="uc-badge" data-testid="ultracode-badge" title={t('picker.deepDesc')}>Ultracode</span>
            </>
          ) : null}
          <ChevronDown className="mtp-chev" size={12} aria-hidden />
        </Button>
      </span>

      <Popover
        variant="panel"
        className="mtp-pop"
        isOpen={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        placement="top start"
        offset={8}
      >
        <Dialog className="mtp-dialog" aria-label={t('picker.searchModel')}>
          <SearchField className="mtp-search" aria-label={t('picker.searchModel')} value={query} onChange={setQuery}>
            <Search className="mtp-search-icon" size={14} aria-hidden />
            <Input className="mtp-search-input" placeholder={t('picker.searchModel')} autoFocus />
          </SearchField>

          <Select className="mtp-provider" label={t('models.provider')} selectedKey={provider || '__all'} onSelectionChange={(key) => setProvider(key === '__all' ? '' : String(key))}>
            <ProviderItem id="__all" textValue={t('usage.all')}>{t('usage.all')}</ProviderItem>
            {[...new Set(models.map((m) => m.provider))].map((id) => <ProviderItem key={id} id={id} textValue={id}>{id}</ProviderItem>)}
          </Select>
          <div className="mtp-scroll">
            {sections.length ? (
              <ListBox
                className="mtp-list"
                aria-label={t('picker.searchModel')}
                selectionMode="single"
                selectedKeys={selectedKey ? [selectedKey] : []}
                onSelectionChange={(keys) => {
                  const selected = [...keys][0]
                  const hit = models.find((model) => keyOf(model) === selected)
                  if (hit) void choose(hit)
                }}
              >
                {sections.map((section) => (
                  <ListBoxSection key={section.id} className="mtp-group">
                    <Header className="mtp-group-title">{sectionTitle(section)}</Header>
                    {section.models.map((m) => {
                      return (
                        <ListBoxItem
                          key={keyOf(m)}
                          id={keyOf(m)}
                          onAction={() => { if (keyOf(m) === selectedKey) setOpen(false) }}
                          className="mtp-item"
                          textValue={`${m.name} ${m.provider}`}
                        >
                          <span className="mtp-item-main">
                            <span className="mtp-item-name">{m.name}</span>
                            <span className="mtp-tags">
                              {isFavorite(favorites, m) ? (
                                <Star className="mtp-fav" size={11} fill="currentColor" aria-hidden />
                              ) : null}
                              {shortWindow(m.contextWindow) ? (
                                <span className="mtp-tag">{shortWindow(m.contextWindow)}</span>
                              ) : null}
                              {m.input?.includes('image') ? <span className="mtp-tag">{t('picker.image')}</span> : null}
                              {m.reasoning ? <span className="mtp-tag">{t('picker.reasoning')}</span> : null}
                              {needsAuth(m.provider) ? (
                                <span className="mtp-tag mtp-tag-auth">{t('picker.needsAuth')}</span>
                              ) : null}
                            </span>
                          </span>
                          <Button variant="ghost" size="sm" aria-label={`${isFavorite(favorites, m) ? text('pickerUnfavoriteCurrent') : text('pickerFavoriteCurrent')}: ${m.name}`} onPress={() => {
                            void patchSettings({ modelFavorites: toggleFavorite(useStore.getState().settings?.modelFavorites ?? [], m) }).catch(() => notify('error', t('models.selectFailed')))
                          }}>
                            <Star size={14} fill={isFavorite(favorites, m) ? 'currentColor' : 'none'} aria-hidden />
                          </Button>
                          {cur && keyOf(cur) === keyOf(m) ? <Check size={14} aria-hidden /> : null}
                        </ListBoxItem>
                      )
                    })}
                  </ListBoxSection>
                ))}
              </ListBox>
            ) : (
              <p className="mtp-empty">{models.length ? t('picker.noMatch') : t('picker.noModels')}</p>
            )}
          </div>

          <Separator className="mtp-sep" />

          {showThinkingSection ? (
            <div className="mtp-thinking" data-testid="model-thinking-settings">
              <ThinkingSection
                levels={levels}
                level={level}
                busy={busy}
                onCommit={(next) => void setThinking(next)}
                fallback={capabilityNote}
                fallbackShort={capabilityShort}
                ultracode={deep}
                onUltracodeRequest={session?.sessionId ? requestUltracode : undefined}
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
                        setOpen(false)
                        openSettings('auth')
                      }}
                    >
                      {t('picker.thinkOpenSettings')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <Separator className="mtp-sep" />

          <div className="mtp-footer">
            {cur ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="model-picker-favorite"
                onPress={() => void toggleCurrentFavorite()}
              >
                <Star size={13} fill={curFavorite ? 'currentColor' : 'none'} aria-hidden />
                {curFavorite ? text('pickerUnfavoriteCurrent') : text('pickerFavoriteCurrent')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                setOpen(false)
                openSettings('auth')
              }}
            >
              {t('picker.thinkOpenSettings')}
            </Button>
          </div>
        </Dialog>
      </Popover>
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
