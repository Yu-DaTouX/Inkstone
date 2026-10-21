import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowLeft, ArrowRight, CornerUpLeft, Folder, File, RefreshCw, RotateCw, X } from 'lucide-react'
import './apply-theme'
import '../src/design/index.css'
import { Badge, Button, IconButton, cx } from '../src/ui'
import { paneBrowserBridge, panePopoutBridge, paneTerminalBridge, type PaneBrowserBridge } from './pane-bridge'
import { PaneTerminalView } from './pane-terminal'
import type {
  PaneBrowserStateView,
  PaneChangeRow,
  PaneContextSegment,
  PanePopoutLocale,
  PaneProjection,
  PaneStateView
} from '../../shared/pane-popout'
import './pane.css'

interface Dict {
  waiting: string
  invalid: string
  invalidHint: string
  unsupported: string
  empty: string
  refresh: string
  close: string
  attach: string
  preview: string
  files: string
  changes: string
  context: string
  branch: string
  used: string
  known: string
  unknown: string
  detached: string
  back: string
  forward: string
  reload: string
  address: string
  returnHost: string
  browser: string
  loading: string
}

const DICT: Record<PanePopoutLocale, Dict> = {
  'zh-CN': {
    waiting: '等待主窗口推送投影…',
    invalid: '归属已失效',
    invalidHint: '打开时的会话已切换或结束，数据已释放。可关闭本窗口。',
    unsupported: '本页签暂不支持独立窗口',
    empty: '没有可显示的内容',
    refresh: '刷新',
    close: '关闭',
    attach: '加入当前会话上下文',
    preview: '预览',
    files: '文件',
    changes: '改动',
    context: '上下文',
    branch: '分支',
    used: '已用',
    known: '已知',
    unknown: '未知',
    detached: '独立窗口（只读投影）',
    back: '后退',
    forward: '前进',
    reload: '刷新',
    address: '地址',
    returnHost: '归还主窗口',
    browser: '浏览器',
    loading: '加载中…'
  },
  'en-US': {
    waiting: 'Waiting for the main window to push a projection…',
    invalid: 'Ownership expired',
    invalidHint: 'The session this window was opened for changed or ended; data was released. Close this window.',
    unsupported: 'This tab does not support a separate window yet',
    empty: 'Nothing to show',
    refresh: 'Refresh',
    close: 'Close',
    attach: 'Add to current session context',
    preview: 'Preview',
    files: 'Files',
    changes: 'Changes',
    context: 'Context',
    branch: 'Branches',
    used: 'Used',
    known: 'known',
    unknown: 'unknown',
    detached: 'Separate window (read-only projection)',
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    address: 'Address',
    returnHost: 'Return to main window',
    browser: 'Browser',
    loading: 'Loading…'
  }
}

function tabLabel(dict: Dict, tab: PaneStateView['tab']): string {
  return dict[tab]
}

function shortTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

function FilesView({ projection, state, dict }: { projection: Extract<PaneProjection, { kind: 'files' }>; state: PaneStateView; dict: Dict }): ReactElement {
  const canPreview = state.actions.includes('files.preview')
  const canAttach = state.actions.includes('files.attach')
  if (projection.rows.length === 0) return <p className="pane-note">{projection.note ?? dict.empty}</p>
  return (
    <ul className="pane-list">
      {projection.rows.map((row) => (
        <li key={row.path} className="pane-row" style={{ paddingInlineStart: `${8 + row.depth * 14}px` }}>
          <button
            type="button"
            className="pane-row__main"
            disabled={!canPreview || row.dir}
            onClick={() => panePopoutBridge()?.action({ type: 'files.preview', path: row.path })}
            title={row.path}
          >
            {row.dir ? <Folder size={13} aria-hidden /> : <File size={13} aria-hidden />}
            <span className="pane-row__name">{row.name}</span>
          </button>
          {canAttach && !row.dir ? (
            <IconButton
              size="sm"
              aria-label={dict.attach}
              title={dict.attach}
              onPress={() => panePopoutBridge()?.action({ type: 'files.attach', path: row.path })}
            >
              <span aria-hidden>＋</span>
            </IconButton>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function ChangesView({ projection, dict }: { projection: Extract<PaneProjection, { kind: 'changes' }>; dict: Dict }): ReactElement {
  if (!projection.repo) return <p className="pane-note">{projection.note ?? dict.empty}</p>
  return (
    <div className="pane-stack">
      <div className="pane-meta">
        <span>{projection.repo}</span>
        {projection.branch ? <Badge tone="neutral">{projection.branch}</Badge> : null}
      </div>
      {projection.rows.length === 0 ? (
        <p className="pane-note">{projection.note ?? dict.empty}</p>
      ) : (
        <ul className="pane-list">
          {projection.rows.map((row: PaneChangeRow) => (
            <li key={row.path} className="pane-row">
              <span className="pane-row__name" title={row.path}>
                {row.path}
              </span>
              <Badge tone={row.untracked ? 'stall' : 'neutral'}>{row.status.trim() || 'M'}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ContextView({ projection, dict }: { projection: Extract<PaneProjection, { kind: 'context' }>; dict: Dict }): ReactElement {
  const pct = projection.windowTokens > 0 ? (projection.usedTokens / projection.windowTokens) * 100 : 0
  return (
    <div className="pane-stack">
      <div className="pane-meta">
        <span>{dict.used}</span>
        <span className="pane-num">
          {projection.known
            ? `${shortTokens(projection.usedTokens)} / ${shortTokens(projection.windowTokens)} (${Math.round(pct)}%)`
            : dict.unknown}
        </span>
      </div>
      <div className="pane-bar" role="img" aria-label={`${dict.used} ${Math.round(pct)}%`}>
        {projection.segments.map((segment: PaneContextSegment) => (
          <i
            key={segment.id}
            className={cx('pane-bar__seg', segment.tone === 'warn' && 'is-warn', segment.tone === 'free' && 'is-free')}
            style={{ width: `${projection.windowTokens > 0 ? (segment.tokens / projection.windowTokens) * 100 : 0}%` }}
          />
        ))}
      </div>
      <ul className="pane-list">
        {projection.segments.map((segment) => (
          <li key={segment.id} className="pane-row">
            <span className="pane-row__name">{segment.label}</span>
            <span className="pane-num">{shortTokens(segment.tokens)}</span>
          </li>
        ))}
      </ul>
      {projection.note ? <p className="pane-note">{projection.note}</p> : null}
    </div>
  )
}

function BranchView({ projection, dict }: { projection: Extract<PaneProjection, { kind: 'branch' }>; dict: Dict }): ReactElement {
  if (projection.rows.length === 0) return <p className="pane-note">{projection.note ?? dict.empty}</p>
  return (
    <ul className="pane-list">
      {projection.rows.map((row) => (
        <li key={row.id} className="pane-row" style={{ paddingInlineStart: `${8 + (row.depth ?? 0) * 14}px` }}>
          <span className="pane-row__name" title={row.label}>
            {row.label}
          </span>
          {row.active ? <Badge tone="accent">{dict.branch}</Badge> : null}
        </li>
      ))}
    </ul>
  )
}

function ProjectionView({ state, dict }: { state: PaneStateView; dict: Dict }): ReactElement {
  const projection = state.projection
  if (!projection) return <p className="pane-note">{dict.waiting}</p>
  switch (projection.kind) {
    case 'files':
      return <FilesView projection={projection} state={state} dict={dict} />
    case 'changes':
      return <ChangesView projection={projection} dict={dict} />
    case 'context':
      return <ContextView projection={projection} dict={dict} />
    case 'branch':
      return <BranchView projection={projection} dict={dict} />
    default:
      return <p className="pane-note">{dict.empty}</p>
  }
}

function PaneApp(): ReactElement {
  const bridge = panePopoutBridge()
  const [state, setState] = useState<PaneStateView | null>(null)

  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.state().then((view) => {
      if (alive) setState(view)
    })
    const off = bridge.onPush((view) => setState(view))
    return () => {
      alive = false
      off()
    }
  }, [bridge])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') bridge?.closeSelf()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bridge])

  const locale = state?.locale ?? 'zh-CN'
  const dict = useMemo(() => DICT[locale], [locale])

  if (!bridge) {
    return (
      <div className="pane">
        <p className="pane-note">{dict.unsupported}</p>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="pane">
        <p className="pane-note">{dict.waiting}</p>
      </div>
    )
  }

  const canRefresh = state.actions.includes('refresh')

  return (
    <div className="pane" data-tab={state.tab} data-invalidated={state.invalidated ? '1' : '0'}>
      <header className="pane-head">
        <div className="pane-head__title">
          <span>{tabLabel(dict, state.tab)}</span>
          <span className="pane-head__sub">{state.owner.cwd || dict.detached}</span>
        </div>
        <div className="pane-head__actions">
          {canRefresh ? (
            <IconButton aria-label={dict.refresh} title={dict.refresh} onPress={() => panePopoutBridge()?.action({ type: 'refresh' })}>
              <RefreshCw size={14} aria-hidden />
            </IconButton>
          ) : null}
          <IconButton aria-label={dict.close} title={dict.close} onPress={() => bridge.closeSelf()}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
      </header>

      {state.invalidated ? (
        <div className="pane-invalid" role="status">
          <p className="pane-invalid__title">{dict.invalid}</p>
          <p className="pane-invalid__hint">{state.invalidReason || dict.invalidHint}</p>
          <Button variant="secondary" size="sm" onPress={() => bridge.closeSelf()}>
            {dict.close}
          </Button>
        </div>
      ) : (
        <main className="pane-body">
          <ProjectionView state={state} dict={dict} />
        </main>
      )}
    </div>
  )
}

function dipScale(zoomFactor: number | undefined): number {
  if (typeof zoomFactor === 'number' && Number.isFinite(zoomFactor) && zoomFactor > 0) return zoomFactor
  const dpr = window.devicePixelRatio
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1
}

function PaneBrowserView({ bridge }: { bridge: PaneBrowserBridge | null }): ReactElement {
  const [state, setState] = useState<PaneBrowserStateView | null>(null)
  const [url, setUrl] = useState('')
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const dict = useMemo(() => DICT[state?.locale ?? 'zh-CN'], [state?.locale])

  const refresh = useCallback((): void => {
    if (!bridge) return
    void bridge
      .state()
      .then((view) => {
        if (!view) return
        setState(view)
        setUrl(view.url)
      })
      .catch(() => {})
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge
      .state()
      .then((view) => {
        if (!alive || !view) return
        setState(view)
        setUrl(view.url)
      })
      .catch(() => {})
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void bridge.returnToHost().catch(() => {})
    }
    window.addEventListener('keydown', onKey)
    const off = panePopoutBridge()?.onPush((view) => {
      const next = view as unknown as PaneBrowserStateView
      if (!next || next.tab !== 'browser' || next.tabId !== state?.tabId) return
      setState(next)
    })
    return () => {
      alive = false
      window.removeEventListener('keydown', onKey)
      off?.()
    }
  }, [bridge, state?.tabId])

  useEffect(() => {
    if (!bridge) return
    const el = viewportRef.current
    if (!el) return
    const scale = dipScale(state?.zoomFactor)
    let frame = 0
    let last = ''
    const tick = (): void => {
      const rect = el.getBoundingClientRect()
      const bounds = {
        x: Math.max(0, Math.round(rect.left * scale)),
        y: Math.max(0, Math.round(rect.top * scale)),
        width: Math.max(1, Math.round(rect.width * scale)),
        height: Math.max(1, Math.round(rect.height * scale))
      }
      const signature = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
      if (signature !== last) {
        last = signature
        void bridge.setBounds(bounds).catch(() => {})
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [bridge, state?.zoomFactor])

  const run = (action: () => Promise<unknown>): void => {
    void action()
      .then(() => refresh())
      .catch(() => {})
  }

  if (!bridge) {
    return (
      <div className="pane">
        <p className="pane-note">{DICT['zh-CN'].unsupported}</p>
      </div>
    )
  }
  if (!state) {
    return (
      <div className="pane">
        <p className="pane-note">{dict.waiting}</p>
      </div>
    )
  }

  return (
    <div className="pane" data-tab="browser" data-invalidated={state.invalidated ? '1' : '0'}>
      <header className="pane-head pane-head--browser">
        <IconButton
          aria-label={dict.back}
          title={dict.back}
          isDisabled={state.invalidated || !state.canGoBack}
          onPress={() => run(() => bridge.goBack())}
        >
          <ArrowLeft size={14} aria-hidden />
        </IconButton>
        <IconButton
          aria-label={dict.forward}
          title={dict.forward}
          isDisabled={state.invalidated || !state.canGoForward}
          onPress={() => run(() => bridge.goForward())}
        >
          <ArrowRight size={14} aria-hidden />
        </IconButton>
        <IconButton aria-label={dict.reload} title={dict.reload} isDisabled={state.invalidated} onPress={() => run(() => bridge.reload())}>
          <RotateCw size={14} aria-hidden />
        </IconButton>
        <form
          className="pane-address"
          onSubmit={(event) => {
            event.preventDefault()
            if (!state.invalidated) run(() => bridge.navigate(url))
          }}
        >
          <input
            className="pane-address__input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-label={dict.address}
            placeholder={dict.address}
            spellCheck={false}
            disabled={state.invalidated}
          />
        </form>
        <div className="pane-head__actions">
          <IconButton aria-label={dict.returnHost} title={dict.returnHost} onPress={() => run(() => bridge.returnToHost())}>
            <CornerUpLeft size={14} aria-hidden />
          </IconButton>
          <IconButton aria-label={dict.close} title={dict.close} onPress={() => run(() => bridge.close())}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
      </header>

      {state.invalidated ? (
        <div className="pane-invalid" role="status">
          <p className="pane-invalid__title">{dict.invalid}</p>
          <p className="pane-invalid__hint">{state.invalidReason || dict.invalidHint}</p>
          <Button variant="secondary" size="sm" onPress={() => run(() => bridge.returnToHost())}>
            {dict.returnHost}
          </Button>
        </div>
      ) : (
        <main className="pane-browser">
          <div className="pane-browser__native" ref={viewportRef} role="region" aria-label={dict.browser} data-tab-id={state.tabId} />
        </main>
      )}
    </div>
  )
}

function PaneRoot(): ReactElement {
  const [mode, setMode] = useState<'checking' | 'terminal' | 'browser' | 'projection'>('checking')
  useEffect(() => {
    let alive = true
    const detect = async (): Promise<'terminal' | 'browser' | 'projection'> => {
      const terminal = paneTerminalBridge()
      if (terminal) {
        const view = await terminal.state().catch(() => null)
        if (view) return 'terminal'
      }
      const browser = paneBrowserBridge()
      if (browser) {
        const view = await browser.state().catch(() => null)
        if (view) return 'browser'
      }
      return 'projection'
    }
    void detect().then((next) => {
      if (alive) setMode(next)
    })
    return () => {
      alive = false
    }
  }, [])
  if (mode === 'checking') {
    return (
      <div className="pane">
        <p className="pane-note">…</p>
      </div>
    )
  }
  if (mode === 'terminal') return <PaneTerminalView bridge={paneTerminalBridge()} />
  if (mode === 'browser') return <PaneBrowserView bridge={paneBrowserBridge()} />
  return <PaneApp />
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PaneRoot />
    </StrictMode>
  )
}
