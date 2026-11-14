import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import {
  displayedSessionOf,
  indexOfSession,
  nearestSessionOf,
  sameSplitSession,
  splitColumns,
  useSplitView,
  type SplitLayout,
  type SplitSessionRef
} from '../../state/split-view'
import { sideBySideCandidate } from '../../app/SideBySideLayout'
import { applySessionDrop, defaultDropTarget, dropContextFor, type SplitDropTarget } from './split-drop-model'
import { neighbourSplitPane, nextSplitPane, sessionPaneCount, type SplitDirection } from './split-nav'
import { splitText } from './split-text'
import { runWithLayoutTransitionFlag } from './layout-transition-flag'
import { domAnchor, domMetrics, saveScrollSnapshot } from '../session/scroll-position'
import { distanceFromBottom } from '../session/scroll-follow'

export const SPLIT_STICK_SLACK_PX = 48

export const SPLIT_RUNNER_LIMIT = 5

export type SplitCommand =
  | 'focus-next'
  | 'focus-previous'
  | 'focus-left'
  | 'focus-right'
  | 'focus-up'
  | 'focus-down'
  | 'new-right'
  | 'new-below'
  | 'close'

function lang(): 'zh-CN' | 'en-US' {
  return useStore.getState().settings?.lang === 'en-US' ? 'en-US' : 'zh-CN'
}

function hostWidth(): number {
  if (typeof document === 'undefined') return 0
  const host = document.querySelector<HTMLElement>('.v3-split') ?? document.querySelector<HTMLElement>('.v3-chat')
  return host ? host.clientWidth : 0
}

const SWITCH_SETTLE_MAX_MS = 400

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void>) => unknown }

function prefersReducedMotion(): boolean {
  if (useStore.getState().settings?.reduceMotion === true) return true
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function splitSwitchSettled(target: SplitSessionRef): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now()
    const check = (): void => {
      const state = useStore.getState()
      const ready = sameSplitSession(displayedSessionOf(state), target) && !state.switchLoading
      if (ready) {
        window.setTimeout(resolve, 32)
        return
      }
      if (performance.now() - started > SWITCH_SETTLE_MAX_MS) {
        resolve()
        return
      }
      window.setTimeout(check, 16)
    }
    check()
  })
}

export function focusSplitSession(target: SplitSessionRef, options: { composer?: boolean } = {}): void {
  const store = useStore.getState()
  if (options.composer !== false) store.requestComposerFocus(target)
  if (sameSplitSession(displayedSessionOf(store), target)) return
  switchSplitFocus(target)
}

function transitionSplitLayout(update: () => void, settleOn: SplitSessionRef | null): void {
  const doc = typeof document !== 'undefined' ? (document as ViewTransitionDocument) : null
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    update()
    return
  }
  const root = doc.documentElement
  runWithLayoutTransitionFlag(root, () => doc.startViewTransition!(async () => {
    update()
    if (settleOn) await splitSwitchSettled(settleOn)
    else await new Promise<void>((resolve) => window.setTimeout(resolve, 32))
  }) as { finished?: Promise<unknown> } | undefined)
}

function switchSplitFocus(target: SplitSessionRef): void {
  const store = useStore.getState()
  if (typeof document !== 'undefined') {
    for (const pane of document.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
      const stream = [...pane.querySelectorAll<HTMLElement>('.v3-stream')].find((element) => element.clientHeight > 0)
      if (!stream) continue
      const bottom = distanceFromBottom(domMetrics(stream)) <= SPLIT_STICK_SLACK_PX
      saveScrollSnapshot(pane.dataset.scrollKey ?? '', { top: stream.scrollTop, bottom, anchor: bottom ? null : domAnchor(stream) })
    }
  }
  if (target.path) {
    void store.switchSession(target.path)
    return
  }
  if (!target.sessionId) return
  const runner = store.runners.find((item) => item.sessionId === target.sessionId)
  store.applyPush({
    ch: 'tray-select-session',
    payload: {
      sessionId: target.sessionId,
      projectId: runner?.projectId,
      cwd: runner?.cwd ?? store.settings?.cwd ?? ''
    }
  })
}

function warnRunnerLimit(before: SplitLayout | null, after: SplitLayout): void {
  const was = before ? sessionPaneCount(before.tiles) : 1
  const now = sessionPaneCount(after.tiles)
  if (now > SPLIT_RUNNER_LIMIT && was <= SPLIT_RUNNER_LIMIT) {
    useStore.getState().notify('info', splitText(lang()).runnerLimit(SPLIT_RUNNER_LIMIT))
  }
}

export function dropSessionInSplit(item: { id?: string; path?: string }, target: SplitDropTarget): boolean {
  const store = useStore.getState()
  const current = displayedSessionOf(store)
  const view = useSplitView.getState()
  const before = view.split
  const ref: SplitSessionRef = { sessionId: item.id, path: item.path }
  const next = applySessionDrop(before, target, ref, current)
  if (!next) return false
  const shown = next.tiles[next.live]
  transitionSplitLayout(() => {
    view.apply(next)
    warnRunnerLimit(before, next)
    useUiV3.getState().navigate({ name: 'chat' })
    if (shown) focusSplitSession(shown)
  }, shown ?? null)
  return true
}

export function openSessionInSplit(item: { id?: string; path?: string }, placement: 'default' | 'below' = 'default'): boolean {
  const store = useStore.getState()
  const current = displayedSessionOf(store)
  const view = useSplitView.getState()
  const ref: SplitSessionRef = { sessionId: item.id, path: item.path }
  const ctx = dropContextFor(view.split, current, ref, hostWidth())
  if (!ctx) return false
  const shown = indexOfSession(ctx.tiles, ref)
  if (shown >= 0) {
    if (view.split) focusSplitSession(ctx.tiles[shown])
    return view.split !== null
  }
  let target = defaultDropTarget(ctx)
  if (placement === 'below' && ctx.canGrow) {
    const columns = splitColumns(ctx.tiles)
    const live = view.split?.live ?? 0
    const col = columns.findIndex((column) => column.includes(live))
    if (col >= 0 && columns[col].length === 1) target = { kind: 'below', col }
  }
  if (!target) {
    store.notify('info', splitText(lang()).noRoom)
    return false
  }
  return dropSessionInSplit(item, target)
}

export function closeSplitPane(index: number): void {
  const view = useSplitView.getState()
  const current = view.split
  if (!current) return
  const neighbor = index === current.live ? current.tiles[nearestSessionOf(current.tiles, index)] : null
  const focus = neighbor && (neighbor.path || neighbor.sessionId) ? neighbor : null
  transitionSplitLayout(() => {
    if (focus) focusSplitSession(focus)
    view.remove(index)
  }, focus)
}

function candidateFor(split: SplitLayout | null): SplitSessionRef | null {
  const store = useStore.getState()
  const current = displayedSessionOf(store)
  const candidate = sideBySideCandidate(store.sessions, current, split?.tiles ?? [])
  return candidate ? { sessionId: candidate.id, path: candidate.path } : null
}

export function runSplitCommand(command: SplitCommand): boolean {
  const view = useSplitView.getState()
  const split = view.split
  if (command === 'new-right' || command === 'new-below') {
    const candidate = candidateFor(split)
    if (!candidate) return false
    return openSessionInSplit({ id: candidate.sessionId, path: candidate.path }, command === 'new-below' ? 'below' : 'default')
  }
  if (!split) return false
  if (command === 'close') {
    closeSplitPane(split.live)
    return true
  }
  let index: number | null = null
  if (command === 'focus-next' || command === 'focus-previous') index = nextSplitPane(split.tiles, split.live, command === 'focus-next' ? 1 : -1)
  else index = neighbourSplitPane(split.tiles, split.live, command.slice('focus-'.length) as SplitDirection)
  if (index === null) return false
  focusSplitSession(split.tiles[index])
  return true
}
