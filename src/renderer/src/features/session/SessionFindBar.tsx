import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n'
import { isModalOpen } from '../../lib/modalLayer'
import { useStore } from '../../state/store'
import { FindBar } from '../../ui'
import { stepFindIndex } from '../preview/code-find'
import {
  FIND_ACTIVE_HIGHLIGHT,
  FIND_HIGHLIGHT,
  FIND_INPUT_DEBOUNCE_MS,
  FIND_MUTATION_DEBOUNCE_MS,
  clampActiveIndex,
  centeringOffset,
  findStepQuery,
  matchFind,
  sessionFindAction,
  sessionFindAllowed,
  type FindRange
} from './session-find'
import './session-find.css'

const FIND_Z = 9000
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

type PaintedMatch = FindRange & { range: Range }

type HighlightLike = { priority: number }
type HighlightRegistryLike = { set(name: string, highlight: unknown): unknown; delete(name: string): unknown }

function highlightApi(): { registry: HighlightRegistryLike; create: (ranges: AbstractRange[]) => HighlightLike } | null {
  const scope = globalThis as unknown as { CSS?: { highlights?: HighlightRegistryLike }; Highlight?: new (...ranges: AbstractRange[]) => HighlightLike }
  const registry = scope.CSS?.highlights
  const create = scope.Highlight
  return registry && typeof create === 'function' ? { registry, create: (ranges) => new create(...ranges) } : null
}

function elementOf(node: Node | null): HTMLElement | null {
  if (!node) return null
  return node.nodeType === 1 ? (node as HTMLElement) : node.parentElement
}

function toRange(match: FindRange): Range | null {
  try {
    const range = document.createRange()
    range.setStart(match.startNode as unknown as Node, match.startOffset)
    range.setEnd(match.endNode as unknown as Node, match.endOffset)
    return range
  } catch {
    return null
  }
}

function rendered(range: Range): boolean {
  const element = elementOf(range.startContainer)
  if (!element) return false
  if (element.ownerDocument.defaultView?.getComputedStyle(element).visibility !== 'visible') return false
  return range.getBoundingClientRect().height > 0
}

function scrollable(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight) return false
  return /auto|scroll|overlay/.test(element.ownerDocument.defaultView?.getComputedStyle(element).overflowY ?? '')
}

export function SessionFindBar({
  enabled,
  sessionKey,
  getScope
}: {
  enabled: boolean
  sessionKey: string
  getScope: () => HTMLElement | null
}): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState({ current: 0, total: 0 })
  const found = useRef<{ query: string; matches: PaintedMatch[]; index: number }>({ query: '', matches: [], index: -1 })
  const inputRef = useRef<HTMLInputElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const debounceRef = useRef<number | null>(null)
  const streamDeferredRef = useRef(false)
  const streaming = useStore((s) => !!s.session?.isStreaming)
  const composingRef = useRef(false)
  const closingRef = useRef(false)

  const paint = (matches: PaintedMatch[], index: number): void => {
    const api = highlightApi()
    if (!api) return
    if (!matches.length) {
      api.registry.delete(FIND_HIGHLIGHT)
      api.registry.delete(FIND_ACTIVE_HIGHLIGHT)
      return
    }
    const all = api.create(matches.map((match) => match.range))
    all.priority = 0
    const active = api.create(index >= 0 ? [matches[index].range] : [])
    active.priority = 1
    api.registry.set(FIND_HIGHLIGHT, all)
    api.registry.set(FIND_ACTIVE_HIGHLIGHT, active)
  }

  const reveal = (range: Range): void => {
    const scope = getScope()
    if (!scope) return
    let box = range.getBoundingClientRect()
    if (box.height === 0) return
    const start = elementOf(range.startContainer)
    for (let element = start; element; element = element.parentElement) {
      if (!scrollable(element)) continue
      const offset = centeringOffset(box, element.getBoundingClientRect())
      if (offset === null) continue
      element.scrollTop += offset
      box = range.getBoundingClientRect()
    }
  }

  const run = (value: string, mode: 'new' | 'step' | 'keep', forward = true): void => {
    if (!value) {
      found.current = { query: '', matches: [], index: -1 }
      paint([], -1)
      setStatus({ current: 0, total: 0 })
      return
    }
    const scope = getScope()
    const matches: PaintedMatch[] = []
    for (const match of scope ? matchFind(scope, value) : []) {
      const range = toRange(match)
      if (!range || !rendered(range)) continue
      matches.push({ ...match, range })
    }
    const previous = found.current
    const index =
      mode === 'keep'
        ? clampActiveIndex(previous.index, matches.length)
        : mode === 'step'
          ? stepFindIndex(previous.query === value ? previous.index : -1, forward ? 1 : -1, matches.length)
          : matches.length
            ? 0
            : -1
    found.current = { query: value, matches, index }
    paint(matches, index)
    setStatus({ current: index >= 0 ? index + 1 : 0, total: matches.length })
    if (mode !== 'keep' && index >= 0) reveal(matches[index].range)
  }

  const runRef = useRef(run)
  runRef.current = run

  const cancelDebounce = (): void => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = null
  }

  const openBar = useCallback((): void => {
    if (!open) {
      const active = document.activeElement as HTMLElement | null
      restoreRef.current = active && active !== document.body ? active : null
      setOpen(true)
    }
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open])

  const closeBar = useCallback((via: 'escape' | 'button' | 'auto'): void => {
    closingRef.current = true
    cancelDebounce()
    setOpen(false)
    setQuery('')
    setStatus({ current: 0, total: 0 })
    found.current = { query: '', matches: [], index: -1 }
    paint([], -1)
    const target = via === 'auto' ? null : restoreRef.current
    restoreRef.current = null
    if (target && document.contains(target)) {
      try {
        target.focus({ preventScroll: true })
      } catch {
      }
    }
    closingRef.current = false
  }, [])

  const step = useCallback(
    (forward: boolean): void => {
      cancelDebounce()
      runRef.current(findStepQuery(inputRef.current?.value, found.current.query), 'step', forward)
    },
    []
  )

  useEffect(() => {
    if (!enabled || !open) return undefined
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [enabled, open])

  useEffect(() => {
    if (!open) return undefined
    const input = inputRef.current
    if (!input) return undefined
    const onStart = (): void => {
      composingRef.current = true
    }
    const onEnd = (): void => {
      composingRef.current = false
      cancelDebounce()
      const value = input.value
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null
        runRef.current(value, 'new')
      }, FIND_INPUT_DEBOUNCE_MS)
    }
    input.spellcheck = false
    input.autocomplete = 'off'
    input.addEventListener('compositionstart', onStart)
    input.addEventListener('compositionend', onEnd)
    return () => {
      input.removeEventListener('compositionstart', onStart)
      input.removeEventListener('compositionend', onEnd)
    }
  }, [open])

  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const own = target === inputRef.current
      const scope = getScope()
      const root = scope?.closest('.v3-session') ?? scope
      const active = document.activeElement as HTMLElement | null
      const inConversation = !!active && !!root && root.contains(active)
      const inComposer = !!active?.closest('.v3-composer')
      const idle = !active || active === document.body
      const action = sessionFindAction(
        {
          key: event.key,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          alt: event.altKey,
          shift: event.shiftKey,
          composing: event.isComposing,
          open,
          defaultPrevented: event.defaultPrevented
        },
        MAC
      )
      if (!action) return
      const allowed = sessionFindAllowed(action, { own, inConversation, inComposer, idle, open, modalOpen: isModalOpen() })
      if (!allowed) return
      event.preventDefault()
      event.stopPropagation()
      if (action === 'open') openBar()
      else if (action === 'close') closeBar('escape')
      else step(action === 'next')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, open, getScope, openBar, closeBar, step])

  useEffect(() => {
    if (open && !enabled) closeBar('auto')
  }, [open, enabled, closeBar])

  useEffect(() => {
    if (!open) return undefined
    const scope = getScope()
    if (!scope) return undefined
    let timer = 0
    const observer = new MutationObserver(() => {
      if (timer || !found.current.query) return
      timer = window.setTimeout(() => {
        timer = 0
        if (!found.current.query) return
        if (useStore.getState().session?.isStreaming) {
          streamDeferredRef.current = true
          return
        }
        streamDeferredRef.current = false
        runRef.current(found.current.query, 'keep')
      }, FIND_MUTATION_DEBOUNCE_MS)
    })
    observer.observe(scope, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (timer) window.clearTimeout(timer)
    }
  }, [open, sessionKey, getScope])

  useEffect(() => {
    if (streaming || !streamDeferredRef.current) return
    streamDeferredRef.current = false
    if (open && found.current.query) runRef.current(found.current.query, 'keep')
  }, [open, streaming])

  const previousSession = useRef(sessionKey)
  useEffect(() => {
    if (previousSession.current === sessionKey) return
    previousSession.current = sessionKey
    if (open && found.current.query) {
      cancelDebounce()
      runRef.current(found.current.query, 'new')
    }
  }, [sessionKey, open])

  useEffect(() => () => {
    cancelDebounce()
    paint([], -1)
  }, [])

  if (!open) return null
  return createPortal(
    <div className="v3-find" style={{ zIndex: FIND_Z }} data-testid="v3-session-findbar">
      <FindBar
        value={query}
        matchIndex={status.total ? status.current - 1 : null}
        matchCount={query ? status.total : null}
        inputRef={inputRef}
        labels={{ input: t('chat.find'), previous: t('chat.findPrev'), next: t('chat.findNext'), close: t('chat.findClose') }}
        placeholder={t('chat.findPlaceholder')}
        data-testid="v3-session-find"
        onChange={(value) => {
          if (closingRef.current) return
          setQuery(value)
          cancelDebounce()
          if (!composingRef.current) {
            debounceRef.current = window.setTimeout(() => {
              debounceRef.current = null
              runRef.current(value, 'new')
            }, FIND_INPUT_DEBOUNCE_MS)
          }
        }}
        onNext={() => step(true)}
        onPrevious={() => step(false)}
        onClose={() => closeBar('escape')}
      />
    </div>,
    document.body
  )
}
