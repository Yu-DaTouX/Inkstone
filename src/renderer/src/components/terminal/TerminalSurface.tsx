import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceKey } from '../workbench/Workspace'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useStore } from '../../state/store'
import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { Button } from '../ui'
import { installImeFallback, installTerminalRenderer, terminalAppearance, terminalFontReady } from './terminal-appearance'
import { APPEARANCE_EVENT } from '../../lib/appearance'
import { boundedPending } from '../settings/review2-settings-guards'

function currentTheme(): {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
} {
  if (typeof window === 'undefined') {
    return { background: '#151515', foreground: '#ecece8', cursor: '#93a4f4', selectionBackground: 'rgba(147,164,244,0.28)' }
  }
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim()
    return value || fallback
  }
  return {
    background: read('--bg-0', '#151515'),
    foreground: read('--fg', '#ecece8'),
    cursor: read('--accent', '#93a4f4'),
    selectionBackground: read('--accent-soft', 'rgba(147,164,244,0.28)')
  }
}

export function TerminalSurface({ terminalId, bare = false }: { terminalId?: string; bare?: boolean } = {}) {
  const t = useT()
  const terminals = useStore((s) => s.terminals)
  const selectedId = useStore((s) => s.activeTerminalId)
  const activeId = terminalId ?? selectedId
  const available = useStore((s) => s.terminalAvailable)
  const error = useStore((s) => s.terminalError)
  const refresh = useStore((s) => s.refreshTerminals)
  const startTerminal = useStore((s) => s.startTerminal)
  const workspaceKey = useWorkspaceKey()
  const closeTerminal = useStore((s) => s.closeTerminal)
  const setActiveTerminal = useStore((s) => s.setActiveTerminal)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const fitCallbackRef = useRef<() => void>(() => {})
  const seqRef = useRef(0)
  const activeIdRef = useRef<string | null>(activeId)
  const [attachError, setAttachError] = useState('')
  const [exited, setExited] = useState<number | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const active = terminals.find((item) => item.id === activeId) ?? null

  const fit = useCallback(() => {
    const term = termRef.current
    const fitAddon = fitRef.current
    const host = hostRef.current
    if (!term || !fitAddon || !host || host.clientWidth < 16 || host.clientHeight < 16) return
    try {
      fitAddon.fit()
    } catch {
    }
    if (activeId) void window.yan.terminal.resize(activeId, term.cols, term.rows)
  }, [activeId])
  useEffect(() => { fitCallbackRef.current = fit }, [fit])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let release = () => {}
    const appearance = terminalAppearance()
    void terminalFontReady(appearance).then(() => {
      if (disposed) return
      const term = new Terminal({
        ...appearance,
        convertEol: false,
        scrollback: 5000,
        theme: currentTheme()
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(host)
      installTerminalRenderer(term, host)
      const imeOff = installImeFallback(term)
      termRef.current = term
      fitRef.current = fitAddon
      setReady(true)

      const dataSub = term.onData((data) => {
        const id = activeIdRef.current
        if (id) void window.yan.terminal.write(id, data)
      })

      let fitTimer: ReturnType<typeof setTimeout> | undefined
      const observer = new ResizeObserver(() => {
        clearTimeout(fitTimer)
        fitTimer = setTimeout(() => fitCallbackRef.current(), 90)
      })
      observer.observe(host)
      const syncAppearance = (): void => {
        term.options.theme = currentTheme()
        const family = terminalAppearance().fontFamily
        if (family && family !== term.options.fontFamily) {
          void terminalFontReady({ ...appearance, fontFamily: family }).then(() => {
            if (disposed) return
            term.options.fontFamily = family
            fitCallbackRef.current()
          })
        }
      }
      const themeObserver = new MutationObserver(syncAppearance)
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      window.addEventListener(APPEARANCE_EVENT, syncAppearance)

      release = () => {
        imeOff()
        dataSub.dispose()
        clearTimeout(fitTimer)
        observer.disconnect()
        themeObserver.disconnect()
        window.removeEventListener(APPEARANCE_EVENT, syncAppearance)
        term.dispose()
        termRef.current = null
        fitRef.current = null
        setReady(false)
      }
    })
    return () => { disposed = true; release() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available])

  const pendingRef = useRef<{ seq: number; data: string }[]>([])
  const attachedRef = useRef(false)

  useEffect(() => {
    const off = window.yan.onPush((msg) => {
      if (msg.ch !== 'terminal') return
      const payload = msg.payload
      if (payload.kind === 'data') {
        if (payload.id !== activeIdRef.current) return
        const seq = payload.seq ?? 0
        const data = payload.data ?? ''
        if (!attachedRef.current) {
          const queued = boundedPending(pendingRef.current, { seq, data }, 512, 2 * 1024 * 1024)
          if (!queued) {
            pendingRef.current = []
            setAttachError('终端连接缓冲超限，请重新连接')
          } else pendingRef.current = queued
          return
        }
        if (seq <= seqRef.current) return
        seqRef.current = seq
        termRef.current?.write(data)
      } else if (payload.id === activeIdRef.current) {
        setExited(payload.exitCode ?? null)
      }
    })
    return off
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term || !ready) return
    setExited(null)
    term.reset()
    seqRef.current = 0
    pendingRef.current = []
    attachedRef.current = false
    if (!activeId) {
      attachedRef.current = true
      return
    }
    let alive = true
    setAttachError('')
    void window.yan.terminal.attach(activeId).then((snapshot) => {
      if (!alive) return
      if (snapshot) {
        if (snapshot.buffer) term.write(snapshot.buffer)
        seqRef.current = snapshot.seq
        if (!snapshot.alive) setExited(snapshot.exitCode ?? null)
      }
      const queued = pendingRef.current
      pendingRef.current = []
      attachedRef.current = true
      for (const chunk of queued) {
        if (chunk.seq <= seqRef.current) continue
        seqRef.current = chunk.seq
        term.write(chunk.data)
      }
      void window.yan.terminal.resize(activeId, term.cols, term.rows)
      term.focus()
      fit()
    }).catch((cause) => {
      if (!alive) return
      attachedRef.current = true
      pendingRef.current = []
      setAttachError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      alive = false
    }
  }, [activeId, ready, fit])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const newTerminal = useCallback(async () => {
    const cols = termRef.current?.cols ?? 80
    const rows = termRef.current?.rows ?? 24
    const snapshot = await startTerminal({ cols, rows, owner: workspaceKey })
    if (snapshot) {
      setExited(null)
      setActiveTerminal(snapshot.id)
    }
  }, [startTerminal, setActiveTerminal, workspaceKey])

  const closeActive = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) return
    await closeTerminal(id)
    const next = useStore.getState().terminals[0]
    setActiveTerminal(next?.id ?? null)
  }, [closeTerminal, setActiveTerminal])

  if (!available) {
    return (
      <div className="term-unavailable" data-testid="terminal-unavailable">
        <Icon name="terminal" size={16} />
        <div className="term-unavailable-text">
          <div>{t('term.unavailable')}</div>
          {error ? <code data-testid="terminal-error">{error}</code> : null}
        </div>
        <Button size="sm" className="rp-btn" type="button" onClick={() => void refresh()} data-testid="terminal-retry">
          {t('term.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="term-surface" data-testid="terminal-surface">
      {bare ? (active && !active.alive ? (
        <div className="term-bar" data-testid="terminal-bar">
          <span className="term-bar-exited" data-testid="terminal-exited">
            {t('term.exited', { code: exited === null ? '—' : String(exited) })}
          </span>
        </div>
      ) : null) : <div className="term-bar" data-testid="terminal-bar">
        <span className="term-bar-title" title={active?.cwd}>
          {active ? active.title : t('term.none')}
        </span>
        {active && !active.alive ? (
          <span className="term-bar-exited" data-testid="terminal-exited">
            {t('term.exited', { code: exited === null ? '—' : String(exited) })}
          </span>
        ) : null}
        <span className="spacer" />
        <Button size="sm" icon="plus" className="rp-btn" type="button" onClick={() => void newTerminal()} data-testid="terminal-new">{t('term.new')}
        </Button>
        {active ? (
          <Button size="sm" className="rp-btn" type="button" onClick={() => void closeActive()} data-testid="terminal-close">
            {t('term.close')}
          </Button>
        ) : null}
      </div>}
      {attachError ? <div className="term-unavailable-text" role="alert" data-testid="terminal-attach-error">{attachError}</div> : null}
      <div className="term-host" ref={hostRef} data-testid="terminal-host" />
    </div>
  )
}
