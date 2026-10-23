export const TRANSCRIPT_VIEWS = ['concise', 'side', 'thinking'] as const

export type TranscriptView = (typeof TRANSCRIPT_VIEWS)[number]

export const DEFAULT_TRANSCRIPT_VIEW: TranscriptView = 'concise'
const SESSION_VIEW_LIMIT = 100

export type SessionViews = Readonly<Record<string, TranscriptView>>

export interface TranscriptViewPrefs {
  defaultView: TranscriptView
  sessions: SessionViews
}

const LEGACY_VIEWS: Readonly<Record<string, TranscriptView>> = { verbose: 'thinking' }

function isTranscriptView(value: unknown): value is TranscriptView {
  return typeof value === 'string' && (TRANSCRIPT_VIEWS as readonly string[]).includes(value)
}

function readView(value: unknown): TranscriptView | undefined {
  if (isTranscriptView(value)) return value
  return typeof value === 'string' ? LEGACY_VIEWS[value] : undefined
}

export function showsThinkingInline(view: TranscriptView): boolean {
  return view === 'thinking'
}

export function showsThinkingAside(view: TranscriptView): boolean {
  return view === 'side'
}

export function effectiveView(prefs: TranscriptViewPrefs, sessionId: string | null | undefined): TranscriptView {
  const own = sessionId ? prefs.sessions[sessionId] : undefined
  return isTranscriptView(own) ? own : prefs.defaultView
}

export function nextTranscriptView(current: TranscriptView): TranscriptView {
  return TRANSCRIPT_VIEWS[(TRANSCRIPT_VIEWS.indexOf(current) + 1) % TRANSCRIPT_VIEWS.length]
}

function normalizeSessionViews(value: unknown, limit = SESSION_VIEW_LIMIT): Record<string, TranscriptView> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([id, raw]): [string, TranscriptView][] => {
    const view = readView(raw)
    return id !== '' && view ? [[id, view]] : []
  })
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - limit)))
}

export function withSessionView(
  prefs: TranscriptViewPrefs,
  sessionId: string,
  view: TranscriptView,
  limit = SESSION_VIEW_LIMIT
): TranscriptViewPrefs {
  const { [sessionId]: _dropped, ...rest } = prefs.sessions
  const sessions = view === prefs.defaultView ? rest : { ...rest, [sessionId]: view }
  return { ...prefs, sessions: normalizeSessionViews(sessions, limit) }
}

export function withDefaultView(prefs: TranscriptViewPrefs, view: TranscriptView): TranscriptViewPrefs {
  const sessions = Object.fromEntries(Object.entries(prefs.sessions).filter(([, own]) => own !== view))
  return { defaultView: view, sessions }
}

export function parseTranscriptViewPrefs(raw: string | null): TranscriptViewPrefs {
  try {
    const value = JSON.parse(raw ?? 'null') as { defaultView?: unknown; sessions?: unknown } | null
    return {
      defaultView: readView(value?.defaultView) ?? DEFAULT_TRANSCRIPT_VIEW,
      sessions: normalizeSessionViews(value?.sessions)
    }
  } catch {
    return { defaultView: DEFAULT_TRANSCRIPT_VIEW, sessions: {} }
  }
}
