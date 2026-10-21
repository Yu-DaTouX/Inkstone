import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { resourceOwner, claimResource, releaseResource } from '../../state/resource-owners'
import { installImeFallback, installTerminalRenderer, terminalFontReady } from './terminal-appearance'
import { observeTerminalEnvironment, readTerminalTheme, terminalFontFamily } from './terminal-theme'
import {
  findTerminalMatches,
  lastTerminalMatchIndex,
  stepTerminalMatchIndex,
  type TerminalFindDirection,
  type TerminalFindMatch
} from './terminal-find'
import {
  TerminalSession,
  type TerminalAdopt,
  type TerminalPushMessage,
  type TerminalRuntimeText,
  type TerminalViewState
} from './terminal-session'
import { terminalXtermOptions, type TerminalViewSettings } from './terminal-view'
import type { WorkspaceOwner } from '../workbench/types'

export interface TerminalTabHandle {
  session(): TerminalSession | null
  focus(): void
  fit(): void
  find(query: string, direction: TerminalFindDirection, reset: boolean): boolean
  resetFind(): void
  selection(): string
  copySelection(): boolean
  paste(text: string): void
  selectAll(): void
  clear(): void
}

export interface TerminalTabViewProps {
  tabKey: string
  adopt: TerminalAdopt
  owner: WorkspaceOwner
  visible: boolean
  active: boolean
  view: TerminalViewSettings
  text: TerminalRuntimeText
  onState: (key: string, state: TerminalViewState) => void
  onBell: (key: string) => void
  onFindRequest: (key: string) => void
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void
}

function bufferLines(term: Terminal): string[] {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
  return lines
}

function revealMatch(term: Terminal, match: TerminalFindMatch): void {
  const top = term.buffer.active.viewportY
  const bottom = top + term.rows - 1
  if (match.line < top || match.line > bottom) term.scrollToLine(Math.max(0, match.line - Math.floor(term.rows / 3)))
  term.select(match.column, match.line, match.length)
}

function writeClipboard(text: string): void {
  if (!text) return
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

function readClipboard(paste: (text: string) => void): void {
  void navigator.clipboard
    .readText()
    .then((value) => {
      if (value) paste(value)
    })
    .catch(() => undefined)
}

export const TerminalTabView = forwardRef<TerminalTabHandle, TerminalTabViewProps>(function TerminalTabView(
  { tabKey, adopt, owner, visible, active, view, text, onState, onBell, onFindRequest, onContextMenu },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<TerminalSession | null>(null)
  const fitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const findCursor = useRef<TerminalFindMatch | null>(null)

  const latest = useRef({ owner, visible, active, view, text, onState, onBell, onFindRequest, adopt, tabKey })
  latest.current = { owner, visible, active, view, text, onState, onBell, onFindRequest, adopt, tabKey }

  const scheduleFit = useCallback((delay = 90): void => {
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
    }, delay)
  }, [])

  const applyView = useCallback(
    (term: Terminal, next: TerminalViewSettings): void => {
      const options = terminalXtermOptions(next)
      if (term.options.fontSize !== options.fontSize) term.options.fontSize = options.fontSize
      if (term.options.lineHeight !== options.lineHeight) term.options.lineHeight = options.lineHeight
      if (term.options.cursorStyle !== options.cursorStyle) term.options.cursorStyle = options.cursorStyle
      if (term.options.cursorBlink !== options.cursorBlink) term.options.cursorBlink = options.cursorBlink
      if (term.options.scrollback !== options.scrollback) term.options.scrollback = options.scrollback
    },
    []
  )

  useImperativeHandle(
    ref,
    () => ({
      session: () => sessionRef.current,
      focus: () => termRef.current?.focus(),
      fit: () => scheduleFit(0),
      find(query, direction, reset) {
        const term = termRef.current
        if (!term) return false
        const matches = findTerminalMatches(bufferLines(term), query)
        if (matches.length === 0) {
          findCursor.current = null
          return false
        }
        let index: number
        if (reset) {
          term.clearSelection()
          index = lastTerminalMatchIndex(matches)
        } else {
          index = stepTerminalMatchIndex(matches, findCursor.current, direction)
        }
        if (index < 0) return false
        findCursor.current = matches[index]
        revealMatch(term, matches[index])
        return true
      },
      resetFind() {
        findCursor.current = null
        termRef.current?.clearSelection()
      },
      selection: () => termRef.current?.getSelection() ?? '',
      copySelection() {
        const term = termRef.current
        const selection = term?.getSelection() ?? ''
        if (!selection) return false
        writeClipboard(selection)
        return true
      },
      paste(text) {
        const term = termRef.current
        if (!term || !text) return
        term.focus()
        term.paste(text)
      },
      selectAll() {
        const term = termRef.current
        if (!term) return
        term.focus()
        term.selectAll()
      },
      clear() {
        const term = termRef.current
        const session = sessionRef.current
        if (!term) return
        term.clearSelection()
        term.clear()
        findCursor.current = null
        void session?.clear()
      }
    }),
    [scheduleFit]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let release = (): void => {}

    const current = latest.current
    const options = {
      fontFamily: terminalFontFamily(),
      ...terminalXtermOptions(current.view),
      letterSpacing: 0,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      screenReaderMode: true,
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
        adopt: current.adopt,
        text: { startFailed: current.text.startFailed, attachFailed: current.text.attachFailed, bufferOverflow: current.text.bufferOverflow }
      })
      controller.setSink({
        reset: () => term.reset(),
        write: (data) => term.write(data)
      })
      sessionRef.current = controller
      const unsubscribe = controller.subscribe((next) => latest.current.onState(latest.current.tabKey, next))
      term.onData((data) => controller.input(data))
      term.onBell(() => latest.current.onBell(latest.current.tabKey))
      controller.setOwner(current.owner, current.visible)
      if (current.visible && current.active) scheduleFit()

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true
        const mod = event.ctrlKey || event.metaKey
        if (mod && !event.shiftKey && !event.altKey && (event.code === 'KeyF' || event.key.toLowerCase() === 'f')) {
          latest.current.onFindRequest(latest.current.tabKey)
          return false
        }
        if (mod && event.shiftKey && event.code === 'KeyC') {
          const selection = term.getSelection()
          if (selection) writeClipboard(selection)
          return false
        }
        if (mod && event.shiftKey && event.code === 'KeyV') {
          readClipboard((value) => term.paste(value))
          return false
        }
        if (event.ctrlKey && event.code === 'Insert') {
          const selection = term.getSelection()
          if (selection) writeClipboard(selection)
          return false
        }
        if (event.shiftKey && event.code === 'Insert') {
          readClipboard((value) => term.paste(value))
          return false
        }
        return true
      })

      const observer = new ResizeObserver(() => scheduleFit())
      observer.observe(host)

      const releaseEnv = observeTerminalEnvironment((change) => {
        if (change !== 'resize') {
          term.options.theme = readTerminalTheme()
          term.options.fontFamily = terminalFontFamily()
        }
        scheduleFit()
      })

      release = () => {
        clearTimeout(fitTimer.current)
        imeOff()
        unsubscribe()
        observer.disconnect()
        releaseEnv()
        controller.setSink(null)
        controller.dispose()
        sessionRef.current = null
        requestAnimationFrame(() => {
          try {
            term.dispose()
          } catch {
          }
        })
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
    controller.setOwner(owner, visible)
    if (visible) scheduleFit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.key, owner.generation, owner.active, owner.cwd, visible, scheduleFit])

  useEffect(() => {
    if (!active || !visible) return
    scheduleFit(0)
    const term = termRef.current
    const host = hostRef.current
    const focused = typeof document === 'undefined' ? null : document.activeElement
    if (!term || !host || !focused) return
    const owner = focused.closest?.('.term-pane-host') ?? null
    if (owner && owner !== host) term.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, visible])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    applyView(term, view)
    scheduleFit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.fontSize, view.lineHeight, view.cursorStyle, view.cursorBlink, view.scrollback])

  return (
    <div
      className="term-pane-host"
      ref={hostRef}
      data-testid={`terminal-host-${tabKey}`}
      data-active={active ? '1' : '0'}
      onContextMenu={onContextMenu}
    />
  )
})
