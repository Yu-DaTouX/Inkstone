export interface PromptHistoryNav {
  index: number
  total: number
  hasDraft: boolean
}

export interface PromptHistoryState {
  resetKey: string
  index: number | null
  draft: string
  injected: string | null
  length: number
  nav: PromptHistoryNav | null
}

export const INITIAL_PROMPT_HISTORY: PromptHistoryState = {
  resetKey: '',
  index: null,
  draft: '',
  injected: null,
  length: -1,
  nav: null
}

export type PromptHistoryAction = 'none' | 'exit' | 'swallow' | 'recall' | 'restore'

export interface PromptHistoryInput {
  resetKey: string
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  composing?: boolean
  empty: boolean
  caretAtStart: boolean
  caretAtEnd: boolean
  text: string
  prompts: readonly string[]
}

export interface PromptHistoryStep {
  state: PromptHistoryState
  action: PromptHistoryAction
  text?: string
  nav: PromptHistoryNav | null
}

export interface HistoryMessage {
  role: string
  text: string
  note?: unknown
  question?: boolean
}

export function humanPrompts(messages: readonly HistoryMessage[] | undefined): string[] {
  const out: string[] = []
  for (const message of messages ?? []) {
    if (message?.role !== 'user' || message.note || message.question) continue
    if (typeof message.text !== 'string' || !message.text) continue
    out.push(message.text)
  }
  return out
}

export function isEmptyComposerText(text: string): boolean {
  return !/[^\n]/.test(text ?? '')
}

const ENDS_NAVIGATION = new Set(['Backspace', 'Delete', 'Enter'])

export function promptHistoryStep(
  previous: PromptHistoryState = INITIAL_PROMPT_HISTORY,
  input: PromptHistoryInput
): PromptHistoryStep {
  const done = (state: PromptHistoryState, action: PromptHistoryAction = 'none', text?: string): PromptHistoryStep => ({
    state,
    action,
    text,
    nav: state.nav
  })

  let state = previous
  if (state.resetKey !== input.resetKey) state = { ...INITIAL_PROMPT_HISTORY, resetKey: input.resetKey }

  if (input.key !== 'ArrowUp' && input.key !== 'ArrowDown') {
    const typing =
      !input.composing &&
      !input.metaKey &&
      !input.ctrlKey &&
      !input.altKey &&
      (input.key.length === 1 || ENDS_NAVIGATION.has(input.key))
    if (state.index !== null && typing) return done(state.nav === null ? state : { ...state, nav: null }, 'exit')
    return done(state)
  }

  if (input.shiftKey || input.metaKey || input.ctrlKey || input.altKey || input.composing) return done(state)
  if (state.index === null && !input.empty) return done(state)
  if (state.nav === null && (input.key === 'ArrowUp' ? !input.caretAtStart : !input.caretAtEnd)) return done(state)

  const prompts = input.prompts
  if (prompts.length === 0) return done(state)

  if (prompts.length !== state.length) state = { ...state, length: prompts.length, index: null, draft: '', injected: null, nav: null }
  if (state.index !== null && state.injected !== null && input.text !== state.injected) {
    state = { ...state, index: null, draft: '', injected: null, nav: null }
  }

  const up = input.key === 'ArrowUp'
  let target: number
  let hasDraft: boolean
  if (state.index === null) {
    if (up) {
      if (!input.empty) return done(state)
      state = { ...state, draft: input.text }
      hasDraft = !isEmptyComposerText(input.text)
      target = prompts.length - 1
    } else {
      return done(state)
    }
  } else {
    hasDraft = !isEmptyComposerText(state.draft)
    target = up ? Math.max(0, state.index - 1) : state.index + 1
  }

  if (target === state.index) return done(state, 'swallow')

  if (target >= prompts.length) {
    const draft = state.draft ?? ''
    return done({ ...state, index: null, draft: '', injected: draft, nav: null }, 'restore', draft)
  }

  const value = prompts[target]
  return done(
    { ...state, index: target, injected: value, nav: { index: target + 1, total: prompts.length, hasDraft } },
    'recall',
    value
  )
}

export interface QueueRecallCandidate {
  id: string
}

export interface QueueRecallInput {
  followUp?: readonly QueueRecallCandidate[]
  pending?: readonly QueueRecallCandidate[]
}

export type QueueRecallTarget = { kind: 'queued'; id: string } | { kind: 'pending'; id: string }

export function queueRecallTarget(input: QueueRecallInput): QueueRecallTarget | null {
  const queued = input.followUp ?? []
  const lastQueued = queued[queued.length - 1]
  if (lastQueued) return { kind: 'queued', id: lastQueued.id }
  const pending = input.pending ?? []
  const lastPending = pending[pending.length - 1]
  if (lastPending) return { kind: 'pending', id: lastPending.id }
  return null
}
