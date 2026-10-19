import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Plus, RefreshCw, Terminal as TerminalIcon, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { Badge, Button, EmptyState, IconButton, Notice, PaneHeader, type BadgeTone } from '../../ui'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { resourceOwner, claimResource, releaseResource } from '../../state/resource-owners'
import { installImeFallback, installTerminalRenderer, terminalFontReady } from './terminal-appearance'
import { observeTerminalEnvironment, readTerminalTheme, terminalFontFamily } from './terminal-theme'
import { terminalText } from './terminal-text'
import {
  TerminalSession,
  type TerminalPhase,
  type TerminalPushMessage,
  type TerminalViewState
} from './terminal-session'
import type { TerminalPaneProps } from '../workbench/types'
import type { TerminalProgramStatus } from '../../../../shared/ipc'
import './terminal.css'

function statusOf(state: TerminalViewState): { key: MessageKey; tone: BadgeTone; progress?: number } | null {
  const status: TerminalProgramStatus | undefined = state.status
  if (!status || status.state === 'clear') return null
  if (state.phase === 'exited' && status.state !== 'done' && status.state !== 'error') return null
  switch (status.state) {
    case 'working':
      return {
        key: 'term.running',
        tone: 'accent',
        ...(typeof status.progress === 'number' && Number.isFinite(status.progress) && status.progress >= 0 && status.progress <= 100
          ? { progress: Math.round(status.progress) }
          : {})
      }
    case 'blocked':
      return {
        key: status.kind === 'permission' ? 'term.waitPermission' : status.kind === 'question' ? 'term.waitAnswer' : status.kind === 'auth' ? 'term.waitAuth' : 'term.wait',
        tone: 'ask'
      }
    case 'done':
      return { key: 'term.ok', tone: 'ok' }
    case 'error':
      return { key: 'term.error', tone: 'fail' }
    case 'idle':
      return { key: 'term.idle', tone: 'neutral' }
    default:
      return null
  }
}

const BUSY_PHASES: ReadonlySet<TerminalPhase> = new Set(['starting', 'connecting'])

export function TerminalPane({ owner, visible = true }: TerminalPaneProps): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = terminalText(lang)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<TerminalSession | null>(null)
  const fitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [state, setState] = useState<TerminalViewState | null>(null)

  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const scheduleFit = useCallback((): void => {
    clearTimeout(fitTimer.current)
    fitTimer.current = setTimeout(() => {
      const term = termRef.current
      const fit = fitRef.current
      const host = hostRef.current
      if (!term || !fit || !host) return
      if (host.clientWidth < 24 || host.clientHeight < 24) return
      try {
        fit.fit()
      } catch {
      }
      sessionRef.current?.resize(term.cols, term.rows)
    }, 90)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let release = (): void => {}

    const options = {
      fontFamily: terminalFontFamily(),
      fontSize: 13,
      lineHeight: 1.15,
      letterSpacing: 0,
      cursorBlink: true,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      screenReaderMode: true,
      scrollback: 5000,
      theme: readTerminalTheme()
    }

    void terminalFontReady(options).then(() => {
      if (disposed) return
      const term = new Terminal(options)
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      installTerminalRenderer(term, host)
      const imeOff = installImeFallback(term)
      termRef.current = term
      fitRef.current = fit

      const controller = new TerminalSession({
        bridge: window.yan.terminal,
        onPush: (cb) => window.yan.onPush((msg) => cb(msg as unknown as TerminalPushMessage)),
        ownerOf: resourceOwner,
        claim: claimResource,
        release: releaseResource,
        text: { startFailed: text.startFailed, attachFailed: text.attachFailed, bufferOverflow: text.bufferOverflow }
      })
      controller.setSink({
        reset: () => term.reset(),
        write: (data) => term.write(data)
      })
      sessionRef.current = controller
      const unsubscribe = controller.subscribe((next) => setState(next))
      term.onData((data) => controller.input(data))
      controller.setOwner(ownerRef.current, visibleRef.current)
      if (visibleRef.current) scheduleFit()

      const readClipboard = (): void => {
        void navigator.clipboard.readText().then((value) => {
          if (value) term.paste(value)
        }).catch(() => undefined)
      }
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true
        const mod = event.ctrlKey || event.metaKey
        if (mod && event.shiftKey && event.code === 'KeyC') {
          const selection = term.getSelection()
          if (selection) void navigator.clipboard.writeText(selection).catch(() => undefined)
          return false
        }
        if (mod && event.shiftKey && event.code === 'KeyV') {
          readClipboard()
          return false
        }
        if (event.ctrlKey && event.code === 'Insert') {
          const selection = term.getSelection()
          if (selection) void navigator.clipboard.writeText(selection).catch(() => undefined)
          return false
        }
        if (event.shiftKey && event.code === 'Insert') {
          readClipboard()
          return false
        }
        return true
      })

      const observer = new ResizeObserver(() => scheduleFit())
      observer.observe(host)

      const releaseEnv = observeTerminalEnvironment(() => {
        term.options.theme = readTerminalTheme()
        term.options.fontFamily = terminalFontFamily()
        scheduleFit()
      })

      release = () => {
        clearTimeout(fitTimer.current)
        imeOff()
        unsubscribe()
        observer.disconnect()
        releaseEnv()
        controller.dispose()
        sessionRef.current = null
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    })

    return () => {
      disposed = true
      release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const controller = sessionRef.current
    if (!controller) return
    controller.setOwner(ownerRef.current, visible)
    if (visible) scheduleFit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.key, owner.generation, owner.active, owner.cwd, owner.sessionId, visible, scheduleFit])

  const busy = state ? BUSY_PHASES.has(state.phase) : false
  const inactive = state?.phase === 'inactive' || !owner.active
  const unavailable = state?.phase === 'unavailable'
  const failed = state?.phase === 'error'
  const exited = state?.phase === 'exited'
  const canEnd = !!state?.terminalId && !inactive

  const title = state?.title || ''
  const cwd = state?.cwd || owner.cwd
  const badge = state ? statusOf(state) : null
  const showHost = !inactive && !unavailable && !failed && !!state && state.phase !== 'idle'

  return (
    <div className="term-pane" data-phase={state?.phase ?? 'idle'} data-visible={visible ? '1' : '0'} data-testid="terminal-pane">
      <PaneHeader
        size="sm"
        className="term-pane-bar"
        icon={<TerminalIcon size={14} strokeWidth={1.75} />}
        title={<span className="term-pane-title" title={cwd || title}>{title || cwd || t('tile.terminal')}</span>}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<Plus size={14} strokeWidth={1.75} />} isDisabled={inactive} onPress={() => void sessionRef.current?.create()} data-testid="terminal-new">
              {t('term.new')}
            </Button>
            {canEnd ? (
              <IconButton size="sm" variant="ghost" aria-label={t('tile.endTerminal')} onPress={() => void sessionRef.current?.kill()} data-testid="terminal-close">
                <X size={14} strokeWidth={1.75} />
              </IconButton>
            ) : null}
          </>
        }
      >
        {badge ? (
          <Badge tone={badge.tone} className="term-pane-badge">
            {t(badge.key)}
            {badge.progress === undefined ? '' : ` ${badge.progress}%`}
          </Badge>
        ) : null}
        {exited ? (
          <span className="term-pane-exited" data-testid="terminal-exited">
            {t('term.exited', { code: state?.exitCode === null || state?.exitCode === undefined ? '—' : String(state.exitCode) })}
          </span>
        ) : null}
      </PaneHeader>

      {inactive ? (
        <EmptyState size="sm" className="term-pane-center" title={text.activateFirst} data-testid="terminal-inactive" />
      ) : null}

      {!inactive && unavailable ? (
        <div className="term-pane-stack" data-testid="terminal-unavailable">
          <EmptyState
            size="sm"
            title={t('term.unavailable')}
            action={
              <Button size="sm" icon={<RefreshCw size={14} strokeWidth={1.75} />} onPress={() => void sessionRef.current?.retry()} data-testid="terminal-retry">
                {t('term.retry')}
              </Button>
            }
          />
          {state?.error ? <Notice tone="fail" compact className="term-pane-error" data-testid="terminal-error">{state.error}</Notice> : null}
        </div>
      ) : null}

      {!inactive && failed ? (
        <EmptyState
          size="sm"
          className="term-pane-center"
          title={state?.notice || text.startFailed}
          data-testid="terminal-failed"
          action={
            <Button size="sm" icon={<RefreshCw size={14} strokeWidth={1.75} />} onPress={() => void sessionRef.current?.retry()} data-testid="terminal-retry">
              {t('term.retry')}
            </Button>
          }
        />
      ) : null}

      {!inactive && !unavailable && !failed && busy ? (
        <Notice compact className="term-pane-note" data-testid="terminal-busy">
          {state?.phase === 'starting' ? text.starting : text.connecting}
        </Notice>
      ) : null}

      {!inactive && !unavailable && !failed && !busy && !state?.terminalId ? (
        <EmptyState
          size="sm"
          className="term-pane-center"
          title={t('term.none')}
          data-testid="terminal-empty"
          action={
            <Button size="sm" icon={<Plus size={14} strokeWidth={1.75} />} onPress={() => void sessionRef.current?.create()} data-testid="terminal-new-empty">
              {t('term.new')}
            </Button>
          }
        />
      ) : null}

      {state?.notice && !failed ? (
        <Notice tone="fail" compact className="term-pane-note" data-testid="terminal-notice">
          {state.notice}
        </Notice>
      ) : null}

      <div className="term-pane-host" ref={hostRef} data-testid="terminal-host" hidden={!showHost} />
    </div>
  )
}
