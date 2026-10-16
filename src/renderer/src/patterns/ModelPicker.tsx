import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, Header, Input, ListBox, ListBoxItem, ListBoxSection, Popover, SearchField, Separator } from 'react-aria-components'
import { Bot, Check, ChevronDown, Search, Star } from 'lucide-react'
import { Button } from '../ui'
import { useT, type MessageKey } from '../i18n'
import { useStore } from '../state/store'
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
import type { ModelChoice } from '../../../shared/model-selection'
import type { ModelInfo } from '../../../shared/ipc'
import './model-picker.css'

/**
 * 输入框底部一行的模型与思考档选择器（WP-24，方案 §8.7 / §10.4）。
 *
 * 一个按钮承载两件事：当前模型（图标 + 名字）与思考强度（短标签）。点开
 * 同一个浮层里换模型、调强度 —— 它们是同一个决定，分两个入口会让人来回找。
 *
 * 权威边界：
 *   · 模型列表 / 当前模型 / 可用档位全部来自 store（`models` / `session`），
 *     不在组件里猜；
 *   · 档位标签与 v2 的 7 档一一对应，不合并不改写；
 *   · 没配凭证的服务商标「未配置」，但不拦截选择 —— 交给 pi 报真实错误；
 *   · 收藏读设置里的 `modelFavorites`（收藏置顶）；「最近使用」只写
 *     `inkstone.v3.modelPicker.recent` 这个 v3 本地键，不进主进程字段；
 *   · 价格 / 上下文提示只在模型自带数据时显示，不按模型名猜。
 */

const LEVEL_LABEL: Record<string, MessageKey> = {
  off: 'think.off',
  minimal: 'think.minimal',
  low: 'think.low',
  medium: 'think.medium',
  high: 'think.high',
  xhigh: 'think.xhigh',
  max: 'think.max'
}

const keyOf = (m: Pick<ModelInfo, 'provider' | 'id'>): string => `${m.provider}/${m.id}`

const EMPTY: never[] = []

export function ModelPicker({ className }: { className?: string } = {}) {
  const t = useT()
  const text = useModelsText()
  const session = useStore((s) => s.session)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const levels = useStore((s) => s.thinkingLevels)
  const setModel = useStore((s) => s.setModel)
  const setThinking = useStore((s) => s.setThinking)
  const patchSettings = useStore((s) => s.patchSettings)
  const authProviders = useStore((s) => s.authProviders)
  const loadAuthProviders = useStore((s) => s.loadAuthProviders)
  const notify = useStore((s) => s.notify)
  const openSettings = useStore((s) => s.openSettings)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /* 「最近使用」是 v3 本地浏览偏好，坏了不影响选择。 */
  const [recent, setRecent] = useState<ModelChoice[]>(() => {
    if (typeof localStorage === 'undefined') return []
    try {
      return parseRecentModels(localStorage.getItem(RECENT_STORAGE_KEY))
    } catch {
      return []
    }
  })
  const triggerRef = useRef<HTMLSpanElement>(null)

  /* pi 没拿到模型时会报一个名为 unknown 的占位：界面上不直接露出这个词。 */
  const cur =
    session?.model && session.model.id !== 'unknown' && session.model.name !== 'unknown' ? session.model : undefined
  const level = session?.thinkingLevel ?? 'off'
  const hasLevels = levels.length > 1
  const levelLabel = (l: string): string => (LEVEL_LABEL[l] ? t(LEVEL_LABEL[l]) : l)
  const busy = !!session?.isStreaming || !!session?.isCompacting

  /* 打开时才拉凭证状态：它要读 auth.json 并探测环境变量。 */
  useEffect(() => {
    if (open) void loadAuthProviders()
  }, [open, loadAuthProviders])

  /* 关闭时清空搜索，下次打开是干净列表。 */
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const needsAuth = (provider: string): boolean => {
    if (authProviders.length === 0) return false
    const info = authProviders.find((p) => p.id === provider || p.authKey === provider)
    /* 目录里没有这个供应商 → 不判断，不当成未配置（宁可少标一个徽标）。 */
    return !!info && info.status !== 'ready'
  }

  const favorites = settings?.modelFavorites ?? EMPTY
  const providerOrder = settings?.modelProviderOrder ?? EMPTY
  const sections = useMemo(
    () => buildPickerSections({ models, favorites, recent, query, providerOrder }),
    [models, favorites, recent, query, providerOrder]
  )

  const selectedKey = cur ? keyOf(cur) : undefined

  /** 收藏置顶 / 最近使用的分组标题；服务分组直接用 provider id。 */
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
        /* 存储不可用只影响下次打开，不影响本次选择 */
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
    <div className={`mp-wrap ${className ?? ''}`}>
      <span className="mp-anchor" ref={triggerRef}>
        <Button
          variant="ghost"
          size="sm"
          className="mp-trigger"
          data-state={cur ? 'ready' : 'unknown'}
          aria-haspopup="dialog"
          aria-expanded={open}
          isDisabled={busy}
          data-testid="model-picker"
          onPress={() => setOpen((v) => !v)}
        >
          <Bot className="mp-icon" size={14} aria-hidden />
          <span className="mp-model" data-testid="model-picker-name">
            {cur ? cur.name : t('picker.notReady')}
          </span>
          {hasLevels && level !== 'off' ? (
            <span className="mp-level" data-level={level} data-testid="thinking-badge">
              {levelLabel(level)}
            </span>
          ) : null}
          <ChevronDown className="mp-chev" size={12} aria-hidden />
        </Button>
      </span>

      <Popover
        className="mp-pop"
        isOpen={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        placement="top start"
        offset={8}
      >
        <Dialog className="mp-dialog" aria-label={t('picker.searchModel')}>
          <SearchField className="mp-search" aria-label={t('picker.searchModel')} value={query} onChange={setQuery}>
            <Search className="mp-search-icon" size={14} aria-hidden />
            <Input className="mp-search-input" placeholder={t('picker.searchModel')} />
          </SearchField>

          <div className="mp-scroll">
            {sections.length ? (
              <ListBox
                className="mp-list"
                aria-label={t('picker.searchModel')}
                selectionMode="single"
                selectedKeys={selectedKey ? [selectedKey] : []}
                onSelectionChange={(keys) => {
                  const first = [...keys][0]
                  if (typeof first !== 'string') return
                  const hit = sections.flatMap((section) => section.models).find((m) => keyOf(m) === first)
                  if (hit) void choose(hit)
                }}
              >
                {sections.map((section) => (
                  <ListBoxSection key={section.id} className="mp-group">
                    <Header className="mp-group-title">{sectionTitle(section)}</Header>
                    {section.models.map((m) => {
                      return (
                        <ListBoxItem
                          key={keyOf(m)}
                          id={keyOf(m)}
                          className="mp-item"
                          textValue={`${m.name} ${m.provider}`}
                        >
                          <span className="mp-item-main">
                            <span className="mp-item-name">{m.name}</span>
                            <span className="mp-tags">
                              {isFavorite(favorites, m) ? (
                                <Star className="mp-fav" size={11} fill="currentColor" aria-hidden />
                              ) : null}
                              {shortWindow(m.contextWindow) ? (
                                <span className="mp-tag">{shortWindow(m.contextWindow)}</span>
                              ) : null}
                              {m.input?.includes('image') ? (
                                <span className="mp-tag">{t('picker.image')}</span>
                              ) : null}
                              {m.reasoning ? <span className="mp-tag">{t('picker.reasoning')}</span> : null}
                              {needsAuth(m.provider) ? (
                                <span className="mp-tag mp-tag-auth">{t('picker.needsAuth')}</span>
                              ) : null}
                            </span>
                          </span>
                          <Check className="mp-check" size={14} aria-hidden />
                        </ListBoxItem>
                      )
                    })}
                  </ListBoxSection>
                ))}
              </ListBox>
            ) : (
              <p className="mp-empty">{models.length ? t('picker.noMatch') : t('picker.noModels')}</p>
            )}
          </div>

          <Separator className="mp-sep" />

          <div className="mp-thinking" data-testid="model-thinking-settings">
            <span className="mp-thinking-title" title={t('picker.thinkDesc')}>
              {t('picker.think')}
            </span>
            {hasLevels ? (
              <div className="mp-levels" role="radiogroup" aria-label={t('picker.think')}>
                {levels.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={l === level}
                    className="mp-level-btn"
                    data-active={l === level}
                    data-level={l}
                    data-testid={`thinking-${l}`}
                    disabled={busy}
                    onClick={() => void setThinking(l)}
                  >
                    {levelLabel(l)}
                  </button>
                ))}
              </div>
            ) : (
              <span className="mp-thinking-note" data-testid="thinking-capability-status">
                {session?.thinkingLevelsStatus === 'unsupported'
                  ? t('picker.thinkUnsupported')
                  : session?.thinkingLevelsStatus === 'known'
                    ? t('picker.thinkNotDeclared')
                    : t('picker.thinkUnknown')}
              </span>
            )}
          </div>

          <Separator className="mp-sep" />

          <div className="mp-footer">
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
            <Button variant="ghost" size="sm" onPress={() => { setOpen(false); openSettings('auth') }}>
              {t('picker.thinkOpenSettings')}
            </Button>
          </div>
        </Dialog>
      </Popover>
    </div>
  )
}
