import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from 'react-aria-components'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, Settings2, Star } from 'lucide-react'
import {
  AsciiRule,
  AsciiScale,
  Button,
  EmptyState,
  IconButton,
  Kbd,
  ListBox,
  ListBoxItem,
  MiddleTruncate,
  Popover,
  SearchField,
  Toggle,
  ToggleGroup
} from '../ui'
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
import { thinkingCommitAction } from '../features/composer/composer-layout'
import type { ModelInfo } from '../../../shared/ipc'
import { levelLabel, ThinkingBadge } from './ThinkingBadge'
import { UltracodeConfirmDialog } from './UltracodeConfirmDialog'
import { ModelBot } from './ModelBot'
import { brandOfModel } from './model-vendor'
import './model-thinking-picker.css'
import './ultracode.css'

export function thinkColor(level: string): string {
  return `var(--think-${level}, var(--fg3))`
}

export const THINK_SCALE = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function thinkingScale(levels: readonly string[]): string[] {
  const known: readonly string[] = THINK_SCALE
  return [...THINK_SCALE, ...levels.filter((level) => !known.includes(level))]
}

const keyOf = (m: Pick<ModelInfo, 'provider' | 'id'>): string => `${m.provider}/${m.id}`

const EMPTY: never[] = []

const HIDDEN_TOGGLE = '__hidden'

export function modelNameTail(name: string): number | undefined {
  const space = name.indexOf(' ')
  return space > 0 ? Math.min(14, name.length - space - 1) : undefined
}

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
  const last = levels[levels.length - 1]
  const canUltracode = hasLevels && !!onUltracodeRequest && !ultracode && !busy
  const options = thinkingScale(levels).map((id) => {
    const supported = levels.includes(id)
    return {
      id,
      label: levelLabel(t, id),
      isDisabled: !supported,
      title: !supported ? t('picker.thinkLevelUnsupported') : canUltracode && id === last && id === level ? t('picker.deepAgain') : undefined,
      testId: `thinking-${id}`
    }
  })

  const commit = (next: string): void => {
    if (ultracode) onUltracodeOff?.()
    const action = thinkingCommitAction(levels, levels.indexOf(next), level)
    if (action.kind === 'commit') onCommit(action.level)
  }

  const reselect = (id: string): void => {
    if (ultracode) onUltracodeOff?.()
    else if (canUltracode && id === last) onUltracodeRequest?.()
  }

  return (
    <>
      <div className="mtp-thinking-head">
        <span className="mtp-thinking-title" title={t('picker.thinkDesc')}>
          {t('picker.think')}
        </span>
        <span className="mtp-thinking-fill" />
        {hasLevels && ultracode ? (
          <span className="mtp-head-level uc-head" data-testid="thinking-current" title={t('picker.deepDesc')}>
            Ultracode
          </span>
        ) : !hasLevels ? (
          <span className="mtp-head-level" data-muted="true" data-testid="thinking-current" title={fallback}>
            {fallbackShort}
          </span>
        ) : null}
      </div>
      {hasLevels ? (
        <AsciiScale
          className="mtp-scale"
          label={t('picker.think')}
          options={options}
          value={level}
          tone={ultracode ? 'var(--accent-t)' : thinkColor(level)}
          isDisabled={busy}
          onChange={commit}
          onReselect={reselect}
          onPastEnd={canUltracode ? onUltracodeRequest : undefined}
          data-testid="thinking-stops"
        />
      ) : null}
    </>
  )
}

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
  const providers = useMemo(() => [...new Set(ordered.map((m) => m.provider))], [ordered])
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
    setTab(cur && providers.includes(cur.provider) ? cur.provider : providers[0] ?? '')
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
  const inTab = ordered.filter((m) => m.provider === tab)
  const rows: ModelInfo[] = q
    ? ordered.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q))
    : hiddenView
      ? inTab.filter(hiddenOf)
      : inTab.filter((m) => !hiddenOf(m))
  const hiddenCount = !q && !hiddenView ? inTab.filter(hiddenOf).length : 0
  const visibleCount = (provider: string): number => ordered.filter((m) => m.provider === provider && !hiddenOf(m)).length
  const showPinned = !q && !hiddenView && favoriteModels.length > 0
  const selectedKey = cur ? keyOf(cur) : undefined
  const pick = (key: unknown): void => {
    const hit = models.find((model) => keyOf(model) === key)
    if (hit) void choose(hit)
  }

  const renderRow = (m: ModelInfo, variant: 'pinned' | 'list') => {
    const fav = isFavorite(favorites, m)
    const jump = favoriteModels.findIndex((f) => keyOf(f) === keyOf(m))
    const modelHidden = hiddenOf(m)
    const contextSize = shortWindow(m.contextWindow)
    return (
      <ListBoxItem key={keyOf(m)} id={keyOf(m)} className="mtp-item" textValue={`${m.name} ${m.provider}`}>
        <ModelBot className="mtp-bot" brand={brandOfModel(m)} mood="icon" size={16} />
        <span className="mtp-item-main">
          <span className="mtp-item-name">{m.name}</span>
          {needsAuth(m.provider) ? <span className="mtp-tag mtp-tag-auth">{t('picker.needsAuth')}</span> : null}
          {modelHidden ? <span className="mtp-tag">{text('pickerHiddenTag')}</span> : null}
        </span>
        {variant === 'pinned' || q ? (
          <span className="mtp-prov ui-meta-num" title={m.provider}>
            {m.provider}
          </span>
        ) : null}
        {variant === 'pinned' ? (
          <span className="mtp-jump">{jump >= 0 && jump < JUMP_LIMIT ? <Kbd>{jumpLabel(jump)}</Kbd> : null}</span>
        ) : (
          <span className="mtp-ctx ui-meta-num">{contextSize}</span>
        )}
        <span className="mtp-row-actions">
          {variant === 'list' && !fav ? (
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
          ) : null}
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
        </span>
        <Check className="mtp-check" size={14} data-on={selectedKey === keyOf(m) || undefined} aria-hidden />
      </ListBoxItem>
    )
  }

  const listRule = q ? (
    <AsciiRule className="mtp-rule" glyph="┄" label={t('picker.matchCount', { n: rows.length })} />
  ) : (
    <AsciiRule
      className="mtp-rule"
      glyph="┄"
      label={
        <span className="mtp-rule-label">
          <span className="ui-num">{tab}</span>
          <span className="ui-meta-num">{rows.length}</span>
        </span>
      }
    />
  )

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
          {cur ? (
            <MiddleTruncate
              className="mtp-model"
              data-testid="model-picker-name"
              value={cur.name.replace(/ /g, '\u00a0')}
              tail={modelNameTail(cur.name)}
              showTitle={false}
              title={`${cur.name} · ${cur.provider}`}
            />
          ) : (
            <span className="mtp-model" data-testid="model-picker-name">
              {t('picker.notReady')}
            </span>
          )}
          <ChevronDown className="mtp-chev" size={12} aria-hidden />
        </Button>
      </span>

      {showThinkingSection ? (
        <span className="mtp-anchor mtp-think-anchor" ref={thinkRef}>
          <Button
            variant="ghost"
            className="mtp-trigger mtp-think-trigger"
            data-level={level}
            aria-haspopup="dialog"
            aria-expanded={thinkOpen}
            aria-label={`${t('picker.think')}: ${deep ? 'Ultracode' : hasLevels ? levelLabel(t, level) : capabilityShort}`}
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
              <span className="mtp-level">{capabilityShort}</span>
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
            <ToggleGroup
              className="mtp-rail-group"
              orientation="vertical"
              selectionMode="single"
              aria-label={t('models.provider')}
              selectedKeys={q ? [] : [tab]}
              onSelectionChange={(keys) => {
                const next = [...keys][0]
                if (next == null) return
                setTab(String(next))
                setHiddenView(false)
                setQuery('')
                focusSearch()
              }}
            >
              {providers.map((provider) => (
                <Toggle
                  key={provider}
                  id={provider}
                  className="mtp-rail-btn"
                  aria-label={`${provider} · ${t('picker.modelCount', { n: visibleCount(provider) })}`}
                  data-testid={`model-picker-tab-${provider}`}
                >
                  <span className="mtp-rail-name ui-num" title={provider}>
                    {provider}
                  </span>
                  <span className="mtp-rail-count ui-meta-num">{visibleCount(provider)}</span>
                </Toggle>
              ))}
            </ToggleGroup>
            <span className="mtp-rail-fill" />
            <IconButton
              className="mtp-rail-manage"
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
            {showPinned ? (
              <div className="mtp-pinned" data-testid="model-picker-favorites">
                <AsciiRule className="mtp-rule" glyph="┄" label={t('models.favorites')} />
                <ListBox
                  className="mtp-list"
                  data-variant="pinned"
                  aria-label={t('models.favorites')}
                  selectionMode="single"
                  selectedKeys={selectedKey ? [selectedKey] : []}
                  onSelectionChange={(keys) => pick(keys === 'all' ? undefined : [...keys][0])}
                >
                  {favoriteModels.map((m) => renderRow(m, 'pinned'))}
                </ListBox>
              </div>
            ) : null}
            {hiddenView && !q ? (
              <Button
                variant="ghost"
                size="sm"
                className="mtp-subhead"
                icon={<ChevronLeft size={14} />}
                onPress={() => setHiddenView(false)}
              >
                <span className="ui-num">{tab}</span>
                <span className="mtp-subhead-note">{text('pickerHiddenTag')}</span>
              </Button>
            ) : (
              listRule
            )}
            <div className="mtp-scroll">
              {rows.length || hiddenCount ? (
                <ListBox
                  className="mtp-list"
                  data-variant={q ? 'search' : 'list'}
                  aria-label={t('picker.searchModel')}
                  selectionMode="single"
                  selectedKeys={selectedKey ? [selectedKey] : []}
                  onSelectionChange={(keys) => {
                    const key = keys === 'all' ? undefined : [...keys][0]
                    if (key === HIDDEN_TOGGLE) {
                      setHiddenView(true)
                      return
                    }
                    pick(key)
                  }}
                >
                  {rows.map((m) => renderRow(m, 'list'))}
                  {hiddenCount ? (
                    <ListBoxItem
                      id={HIDDEN_TOGGLE}
                      className="mtp-item mtp-hidden-toggle"
                      textValue={text('pickerHidden').replace('{n}', String(hiddenCount))}
                      data-testid="model-picker-hidden-toggle"
                    >
                      <EyeOff className="mtp-bot" size={14} aria-hidden />
                      <span className="mtp-item-main">
                        <span className="mtp-item-name">{text('pickerHidden').replace(' · {n}', '').replace('{n}', '')}</span>
                      </span>
                      <span className="mtp-ctx ui-meta-num">{hiddenCount}</span>
                      <ChevronRight className="mtp-check" size={14} aria-hidden />
                    </ListBoxItem>
                  ) : null}
                </ListBox>
              ) : (
                <EmptyState size="sm" className="mtp-empty" title={models.length ? t('picker.noMatch') : t('picker.noModels')} />
              )}
            </div>
            {hasLevels && cur ? (
              <div className="mtp-foot" data-testid="model-picker-thinking">
                <ThinkingSection
                  levels={levels}
                  level={level}
                  busy={busy}
                  onCommit={(next) => void setThinking(next)}
                  ultracode={deep}
                  onUltracodeRequest={session?.sessionId ? () => { setOpen(false); setConfirmDeep(true) } : undefined}
                  onUltracodeOff={() => void setUltracode(false)}
                />
              </div>
            ) : null}
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
