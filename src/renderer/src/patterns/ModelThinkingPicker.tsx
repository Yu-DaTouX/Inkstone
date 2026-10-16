import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Dialog,
  Header,
  Input,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  SearchField,
  Separator,
  SliderThumb,
  SliderTrack
} from 'react-aria-components'
import { Check, ChevronDown, Search, Star } from 'lucide-react'
import { Button, Slider, Select, ListBoxItem as ProviderItem } from '../ui'
import { PulseField, resolveColor } from '../components/ui/pulse-field'
import { APPEARANCE_EVENT } from '../lib/appearance'
import { useT, type MessageKey, type TFunc } from '../i18n'
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
import {
  thinkingCommitAction,
  thinkingDragAction,
  thinkingLevelIndex
} from '../features/composer/composer-layout'
import type { ModelChoice } from '../../../shared/model-selection'
import type { ModelInfo } from '../../../shared/ipc'
import './model-thinking-picker.css'

/**
 * 输入框底栏的模型与思考档选择器（v2 `ModelThinkingPicker` 的 v3 复刻）。
 *
 * 一个按钮承载两件事：当前模型（图标 + 名字）与思考强度（短标签加档位色点）；
 * 点开同一个浮层里换模型、拖滑杆调强度 —— 它们是同一个决定。
 *
 * 思考强度三处反馈：
 *   · 触发器上的档位色点与档位徽标按 `data-level` 染色；
 *   · 弹层里档位值以 `key={headLevel}` 重挂，触发 `v3-step-value-in` 切换动画；
 *     拖动滑杆时头部实时预览，松手/确认才真正写设置；
 *   · 输入框顶边（ComposerBorder）在运行时随档位换色，过渡用 v3 动效令牌。
 *
 * 档位滑杆按 v2 `StepSlider` 复原：轨道是 `components/ui/pulse-field` 的点阵画布
 * （按档位色点亮到当前档，脉冲密度随档位上升），光标是档位色块带发光与启动闪烁，
 * 档位名可点击切档。语义、键盘与拖拽仍由正式 `ui/Slider` 提供，不在这里另写指针状态机。
 *
 * 权威边界与旧 ModelPicker 一致：模型列表 / 当前模型 / 可用档位全部来自 store，
 * 不在组件里猜；收藏读设置，最近使用只写 v3 本地键。档位滑杆用正式 `ui/Slider`，
 * 离散档位映射为 step，并在渲染后把 `aria-valuetext` 补成档位名。
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

/** 档位名：与 pi 的 7 档一一对应，不合并、不改写。 */
export function levelLabel(t: TFunc, level: string): string {
  const key = LEVEL_LABEL[level]
  return key ? t(key) : level
}

/** 档位色：composer.css 用现有 v3 令牌派生的 `--think-*`，这里带兜底引用。 */
export function thinkColor(level: string): string {
  return `var(--think-${level}, var(--fg3))`
}

/** 两色线性插值：画布要的是实色，不透明度由引擎自己给。 */
function mixRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** v3 主题令牌挂在 `<html data-theme>`；没设时才跟随系统色偏好。 */
function isDarkTheme(): boolean {
  const theme = document.documentElement.dataset.theme
  if (theme) return theme === 'dark'
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

const keyOf = (m: Pick<ModelInfo, 'provider' | 'id'>): string => `${m.provider}/${m.id}`

const EMPTY: never[] = []

/**
 * 思考档位区（可独立 SSR 的纯展示）。
 *
 * 状态只有「预览」一项：`onChange` 只更新它，`onChangeEnd` 才回调 `onCommit`。
 * 这样拖动过程的档位不会落盘，测试也能直接对 `thinkingDragAction` /
 * `thinkingCommitAction` 断言这条边界。
 */
export function ThinkingSection({
  levels,
  level,
  busy,
  onCommit,
  fallback
}: {
  levels: readonly string[]
  level: string
  busy: boolean
  onCommit: (level: string) => void
  fallback?: string
}) {
  const t = useT()
  const hasLevels = levels.length > 1
  /* 拖动手柄时头部实时显示手柄所在档位（松手才真正切档） */
  const [preview, setPreview] = useState<string | null>(null)
  const headLevel = preview ?? level
  const headIndex = thinkingLevelIndex(levels, headLevel)
  const inputRef = useRef<HTMLInputElement>(null)

  /* 点阵画布、弹簧前沿宿主（轨道）与档位色探针 */
  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)
  const fieldRef = useRef<PulseField | null>(null)
  /* 档位表拼成字符串当依赖：避免上层每次传新数组时重建引擎 */
  const palette = levels.join('|')

  /* 设置落盘后清掉预览，头部交回权威值；不会出现「预览停在旧档」 */
  useEffect(() => {
    if (preview && preview === level) setPreview(null)
  }, [preview, level])

  /* RAC 1.22 的隐藏 input 固定用数字格式化值当 aria-valuetext，不接受自定义
     档位名，所以在渲染后用同一个 input 覆盖成档位名。 */
  useEffect(() => {
    if (!hasLevels) return
    inputRef.current?.setAttribute('aria-valuetext', levelLabel(t, headLevel))
  }, [hasLevels, headLevel, t])

  /*
   * 点阵画布跟菜单同生命周期：挂载建引擎、关闭 dispose 停帧。
   * 档位色取 composer.css 派生的 `--think-*`；未点亮的暗点由 v3 令牌混出一档
   * 低对比灰（深浅主题都看得见）。主题属性或外观事件变化时重解析颜色。
   */
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

  /* 引擎跟当前档位（含拖动预览）：脉冲密度与前沿位置随之更新 */
  useEffect(() => {
    if (!hasLevels) return
    fieldRef.current?.setLevel(headIndex, levels.length, !!busy)
  }, [hasLevels, palette, headIndex, levels.length, busy])

  /** 档位下标 → 百分比位置（轨道两端是首尾档） */
  const at = (index: number): number => (levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0)

  return (
    <>
      <div className="mtp-thinking-head">
        <span className="mtp-thinking-title" title={t('picker.thinkDesc')}>
          {t('picker.think')}
        </span>
        <span className="mtp-thinking-fill" />
        <span
          className="mtp-head-level"
          data-level={hasLevels ? headLevel : level}
          data-testid="thinking-current"
          title={fallback ?? t('picker.thinkDesc')}
        >
          {hasLevels ? (
            <span key={headLevel} className="mtp-step-value">
              {levelLabel(t, headLevel)}
            </span>
          ) : (
            fallback
          )}
        </span>
      </div>
      {hasLevels ? (
        <div className="mtp-step" data-level={headLevel}>
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
  const [provider, setProvider] = useState('')
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
  const busy = !!session?.isStreaming || !!session?.isCompacting
  const thinkingStatus = session?.thinkingLevelsStatus ?? (levels.length ? 'known' : 'unknown')
  const notDeclared = !hasLevels && thinkingStatus === 'known' && !!cur
  const customProvider = !!cur?.provider && /^yan-/.test(cur.provider)
  const showThinkingSection = hasLevels || thinkingStatus !== 'known' || notDeclared

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
    () => buildPickerSections({ models: provider ? models.filter((m) => m.provider === provider) : models, favorites, recent, query, providerOrder }),
    [models, favorites, recent, query, providerOrder, provider]
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
          onPress={() => setOpen((v) => !v)}
        >
          {/* 档位色的小点：与输入框顶边同一套 --think-* 颜色，一眼看出当前强度 */}
          <span className="mtp-dot" data-level={hasLevels ? level : 'off'} aria-hidden />
          <span className="mtp-model" data-testid="model-picker-name">
            {cur ? cur.name : t('picker.notReady')}
          </span>
          {hasLevels && level !== 'off' ? (
            <span className="mtp-level" data-level={level} data-testid="thinking-badge">
              {levelLabel(t, level)}
            </span>
          ) : null}
          <ChevronDown className="mtp-chev" size={12} aria-hidden />
        </Button>
      </span>

      <Popover
        className="mtp-pop"
        isOpen={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        placement="top start"
        offset={8}
        isNonModal
      >
        <Dialog className="mtp-dialog" aria-label={t('picker.searchModel')}>
          <SearchField className="mtp-search" aria-label={t('picker.searchModel')} value={query} onChange={setQuery}>
            <Search className="mtp-search-icon" size={14} aria-hidden />
            <Input className="mtp-search-input" placeholder={t('picker.searchModel')} />
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
                fallback={
                  notDeclared
                    ? t(customProvider ? 'picker.thinkNotDeclaredCustom' : 'picker.thinkNotDeclared')
                    : thinkingStatus === 'unsupported'
                      ? t('picker.thinkUnsupported')
                      : t('picker.thinkUnknown')
                }
              />
              {!hasLevels ? (
                <div className="mtp-capability-note" data-testid="thinking-capability-status">
                  {notDeclared
                    ? t(customProvider ? 'picker.thinkNotDeclaredCustom' : 'picker.thinkNotDeclared')
                    : thinkingStatus === 'unsupported'
                      ? t('picker.thinkUnsupported')
                      : t('picker.thinkUnknown')}
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
    </div>
  )
}
