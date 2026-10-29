import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useStore } from '../../state/store'
import { showPreview, usePreviewBindings } from '../workbench/preview-bindings'
import { currentTurnHtmlCalls, resolveAgainst, thinkingHtmlDraft, type HtmlToolCall } from './live-html-calls'

export interface LiveHtmlTarget {
  sessionId: string
  path: string
  generating: boolean
  revision: number
  draft: string | null
  drafting: boolean
  focus: LiveHtmlFocus | null
}

export interface LiveHtmlFocus {
  text: string | null
}

const renderedHtml = new Set<string>()
const ARTIFACT_DIR = /[\\/]artifacts[\\/]/i

function htmlKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

export function prefersRenderedHtml(path: string | null | undefined): boolean {
  if (!path) return false
  return ARTIFACT_DIR.test(path) || renderedHtml.has(htmlKey(path))
}

const RECENT_RESULT_MS = 30 * 60_000
const THINKING_DRAFT_MS = 600
const THINKING_DRAFT_PATH = 'artifacts/draft.html'

export const useLiveHtml = create<{ target: LiveHtmlTarget | null }>(() => ({ target: null }))

export function useLiveHtmlFollow(ownerKey: string | null): void {
  const ownerRef = useRef(ownerKey)
  ownerRef.current = ownerKey
  useEffect(() => {
    const opened = new Set<string>()
    const live = new Set<string>()
    const historical = new Set<string>()
    const finished = new Set<string>()
    let lastSession: string | null = null
    let returning = false
    let thinkingDraft: string | null = null
    let thinkingDraftAt = 0
    let draftPreview: { owner: string | null; sessionId: string; path: string } | null = null
    const closeDraftPreview = (): void => {
      if (!draftPreview) return
      const { owner, sessionId, path } = draftPreview
      draftPreview = null
      usePreviewBindings.getState().close(owner, path)
      opened.delete(`${sessionId}|${path.toLowerCase()}`)
      const target = useLiveHtml.getState().target
      if (target?.sessionId === sessionId && target.path === path) useLiveHtml.setState({ target: null })
    }
    return useStore.subscribe((state) => {
      const sessionId = state.session?.sessionId ?? null
      const cwd = state.session?.cwd ?? ''
      if (sessionId !== lastSession) {
        closeDraftPreview()
        lastSession = sessionId
        live.clear()
        historical.clear()
        finished.clear()
        returning = true
        thinkingDraft = null
        if (useLiveHtml.getState().target?.sessionId !== sessionId) useLiveHtml.setState({ target: null })
      }
      if (!sessionId || !cwd) return
      const running = !!(state.session?.isStreaming || state.session?.isAgentRunning)
      const turnCalls = currentTurnHtmlCalls(state.messages)
      if (returning && state.messages.length) {
        returning = false
        const recent = running ? undefined : turnCalls[turnCalls.length - 1]
        if (recent?.done && recent.endedAt && Date.now() - recent.endedAt < RECENT_RESULT_MS) {
          const recentPath = resolveAgainst(cwd, recent.path)
          const recentKey = `${sessionId}|${recentPath.toLowerCase()}`
          renderedHtml.add(htmlKey(recentPath))
          if (!opened.has(recentKey)) {
            opened.add(recentKey)
            showPreview(ownerRef.current, recentPath, { preview: true })
          }
        }
      }
      const calls = turnCalls.filter((call) => {
        if (live.has(call.id)) return true
        if (historical.has(call.id)) return false
        if (running) {
          live.add(call.id)
          return true
        }
        historical.add(call.id)
        return false
      })
      let current = useLiveHtml.getState().target
      const fromThinking = running ? thinkingHtmlDraft(state.messages) : null
      if (!fromThinking) thinkingDraft = null
      else if (fromThinking !== thinkingDraft && Date.now() - thinkingDraftAt >= THINKING_DRAFT_MS) {
        thinkingDraft = fromThinking
        thinkingDraftAt = Date.now()
      }
      const lastCall = calls[calls.length - 1]
      const latest: HtmlToolCall | undefined =
        thinkingDraft !== null
          ? { id: 'thinking', path: lastCall?.path ?? THINKING_DRAFT_PATH, done: false, draft: thinkingDraft, focusText: null }
          : lastCall
      if (draftPreview && (!latest || resolveAgainst(cwd, latest.path) !== draftPreview.path)) {
        closeDraftPreview()
        current = useLiveHtml.getState().target
      }
      if (!latest) {
        if (current?.sessionId === sessionId && current.generating && !running) {
          useLiveHtml.setState({ target: { ...current, generating: false, drafting: false, revision: current.revision + 1 } })
        }
        return
      }
      const path = resolveAgainst(cwd, latest.path)
      let revision = current?.sessionId === sessionId && current.path === path ? current.revision : 0
      for (const call of calls) {
        if (resolveAgainst(cwd, call.path) !== path) continue
        if (call.done && !finished.has(call.id)) {
          finished.add(call.id)
          revision++
        }
      }
      const generating = running && !latest.done
      const draft = latest.draft
      const drafting = !latest.done && draft !== null
      const previousFocus = current?.sessionId === sessionId && current.path === path ? current.focus : null
      const focus: LiveHtmlFocus | null = latest.focusText ? { text: latest.focusText } : draft !== null ? { text: null } : previousFocus
      renderedHtml.add(htmlKey(path))
      if (
        !current ||
        current.sessionId !== sessionId ||
        current.path !== path ||
        current.generating !== generating ||
        current.revision !== revision ||
        current.draft !== draft ||
        current.drafting !== drafting ||
        current.focus?.text !== focus?.text ||
        !current.focus !== !focus
      ) {
        useLiveHtml.setState({ target: { sessionId, path, generating, revision, draft, drafting, focus } })
      }
      const openKey = `${sessionId}|${path.toLowerCase()}`
      if (!opened.has(openKey)) {
        opened.add(openKey)
        showPreview(ownerRef.current, path, { preview: latest.id === 'thinking' })
        if (latest.id === 'thinking' && !lastCall) draftPreview = { owner: ownerRef.current, sessionId, path }
      }
    })
  }, [])
}
