import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import {
  displayedSessionOf,
  indexOfSession,
  isAuxTile,
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

export const SPLIT_RUNNER_LIMIT = 3

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

export function focusSplitSession(target: SplitSessionRef): void {
  const store = useStore.getState()
  store.requestComposerFocus(target)
  if (sameSplitSession(displayedSessionOf(store), target)) return
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
  view.apply(next)
  warnRunnerLimit(before, next)
  useUiV3.getState().navigate({ name: 'chat' })
  const shown = next.tiles[next.live]
  if (shown) focusSplitSession(shown)
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
  if (index === current.live) {
    const neighbor = current.tiles[nearestSessionOf(current.tiles, index)]
    if (neighbor && !isAuxTile(neighbor) && (neighbor.path || neighbor.sessionId)) focusSplitSession(neighbor)
  }
  view.remove(index)
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
