import { useEffect, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { RefreshCw, Terminal as TerminalIcon, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { installImeFallback, installTerminalRenderer, terminalFontReady } from '../src/features/terminal/terminal-appearance'
import { observeTerminalEnvironment, readTerminalTheme, terminalFontFamily } from '../src/features/terminal/terminal-theme'
import {
  PaneTerminalStream,
  type PaneTerminalBridge,
  type PaneTerminalLeaseView,
  type PaneTerminalPushEvent
} from '../../shared/pane-terminal'
import './pane-terminal.css'

export { paneTerminalBridge } from './pane-bridge'

interface Dict {
  unsupported: string
  waiting: string
  invalid: string
  invalidHint: string
  exited: string
  close: string
  reconnect: string
  readOnly: string
}

const DICT: Record<'zh-CN' | 'en-US', Dict> = {
  'zh-CN': {
    unsupported: '本窗口没有可用的终端连接',
    waiting: '等待主窗口绑定终端…',
    invalid: '归属已失效',
    invalidHint: '打开时的会话已切换或结束，终端已释放；PTY 仍在主窗口。',
    exited: '进程已退出',
    close: '关闭',
    reconnect: '重新连接',
    readOnly: '只读（进程已退出）'
  },
  'en-US': {
    unsupported: 'No terminal connection is available in this window',
    waiting: 'Waiting for the main window to bind a terminal…',
    invalid: 'Ownership expired',
    invalidHint: 'The session this window was opened for changed or ended; the terminal was released. The PTY stays in the main window.',
    exited: 'Process exited',
    close: 'Close',
    reconnect: 'Reconnect',
    readOnly: 'Read-only (process exited)'
  }
}

type Phase = 'unsupported' | 'waiting' | 'ready' | 'exited' | 'invalidated'

export interface PaneTerminalViewProps {
  bridge: PaneTerminalBridge | null
  onRequestClose?: () => void
}

export function PaneTerminalView({ bridge, onRequestClose }: PaneTerminalViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const streamRef = useRef<PaneTerminalStream | null>(null)
  const leaseRef = useRef<PaneTerminalLeaseView | null>(null)
  const earlyRef = useRef<PaneTerminalPushEvent[]>([])
  const fitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>(bridge ? 'waiting' : 'unsupported')
  const [lease, setLease] = useState<PaneTerminalLeaseView | null>(null)
  const dict = DICT[lease?.locale ?? 'zh-CN']

  const scheduleFit = (): void => {
    clearTimeout(fitTimer.current)
    fitTimer.current = setTimeout(() => {
      const term = termRef.current
      const fit = fitRef.current
      const host = hostRef.current
      const current = leaseRef.current
      if (!term || !fit || !host || !current) return
      if (host.clientWidth < 24 || host.clientHeight < 24) return
      try {
        fit.fit()
      } catch {
      }
      void bridge?.resize(current.leaseId, term.cols, term.rows)
    }, 90)
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host || !bridge) return
    let disposed = false
    let teardown: (() => void) | undefined

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

    const handleInvalidated = (reason?: string): void => {
      leaseRef.current = leaseRef.current ? { ...leaseRef.current, invalidated: true, writable: false, snapshot: null, ...(reason ? { invalidReason: reason } : {}) } : null
      setLease(leaseRef.current)
      setPhase('invalidated')
      streamRef.current = null
    }

    const offPush = bridge.onPush((event) => {
      const stream = streamRef.current
      if (!stream) {
        if (earlyRef.current.length < 256) earlyRef.current.push(event)
        return
      }
      const output = stream.push(event)
      if (!output) return
      if (output.data) termRef.current?.write(output.data)
      if (output.invalidated) handleInvalidated(output.invalidReason)
      if (output.exit) setPhase('exited')
    })

    void bridge.state().then((view) => {
      if (disposed) return
      if (!view) {
        setPhase('unsupported')
        return
      }
      leaseRef.current = view
      setLease(view)
      if (view.invalidated) {
        setPhase('invalidated')
        return
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

        const stream = new PaneTerminalStream({ leaseId: view.leaseId, epoch: view.epoch, terminalId: view.terminalId })
        streamRef.current = stream
        for (const event of earlyRef.current) stream.push(event)
        earlyRef.current = []
        if (view.snapshot?.buffer) term.write(view.snapshot.buffer)
        const merged = stream.attachSnapshot(view.snapshot?.seq ?? 0)
        if (merged.data) term.write(merged.data)

        term.onData((data) => {
          const current = leaseRef.current
          if (current?.writable) void bridge.input(current.leaseId, data)
        })
        const observer = new ResizeObserver(() => scheduleFit())
        observer.observe(host)
        const releaseEnv = observeTerminalEnvironment(() => {
          term.options.theme = readTerminalTheme()
          term.options.fontFamily = terminalFontFamily()
          scheduleFit()
        })
        setPhase(view.snapshot && !view.snapshot.alive ? 'exited' : 'ready')
        scheduleFit()

        teardown = () => {
          clearTimeout(fitTimer.current)
          imeOff()
          observer.disconnect()
          releaseEnv()
          term.dispose()
          termRef.current = null
          fitRef.current = null
          streamRef.current = null
        }
      })
    })

    return () => {
      disposed = true
      offPush()
      teardown?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge])

  const close = (): void => {
    if (onRequestClose) onRequestClose()
    else bridge?.closeSelf()
  }

  const retry = (): void => {
    if (!bridge) return
    setPhase('waiting')
    void bridge.state().then((view) => {
      if (!view) {
        setPhase('unsupported')
        return
      }
      leaseRef.current = view
      setLease(view)
      setPhase(view.invalidated ? 'invalidated' : view.snapshot && !view.snapshot.alive ? 'exited' : 'ready')
      if (view.snapshot?.buffer && termRef.current) {
        termRef.current.reset()
        termRef.current.write(view.snapshot.buffer)
        streamRef.current?.attachSnapshot(view.snapshot.seq)
      }
    })
  }

  const title = lease?.snapshot?.title || lease?.cwd || ''

  return (
    <div className="pane-term" data-phase={phase}>
      <header className="pane-term__head">
        <TerminalIcon size={14} strokeWidth={1.75} aria-hidden />
        <span className="pane-term__title" title={lease?.cwd || title}>
          {title || dict.waiting}
        </span>
        {lease && !lease.writable && phase !== 'invalidated' ? <span className="pane-term__readonly">{dict.readOnly}</span> : null}
        <button type="button" className="pane-term__btn" aria-label={dict.reconnect} title={dict.reconnect} onClick={retry} disabled={!lease}>
          <RefreshCw size={14} aria-hidden />
        </button>
        <button type="button" className="pane-term__btn" aria-label={dict.close} title={dict.close} onClick={close}>
          <X size={14} aria-hidden />
        </button>
      </header>

      {phase === 'unsupported' ? <p className="pane-term__note">{dict.unsupported}</p> : null}
      {phase === 'waiting' ? <p className="pane-term__note">{dict.waiting}</p> : null}
      {phase === 'exited' ? <p className="pane-term__note">{dict.exited}</p> : null}
      {phase === 'invalidated' ? (
        <div className="pane-term__invalid" role="status">
          <p className="pane-term__invalid-title">{dict.invalid}</p>
          <p className="pane-term__invalid-hint">{lease?.invalidReason || dict.invalidHint}</p>
          <button type="button" className="pane-term__btn pane-term__btn--text" onClick={close}>
            {dict.close}
          </button>
        </div>
      ) : null}

      <div className="pane-term__host" ref={hostRef} hidden={phase !== 'ready' && phase !== 'exited'} />
    </div>
  )
}

export default PaneTerminalView
