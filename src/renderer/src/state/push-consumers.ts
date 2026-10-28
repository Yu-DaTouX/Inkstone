import type { AppSettings, MainPush, SoundEvent, SubagentRun } from '../../../shared/ipc'
import type { MessageKey, TVars } from '../i18n'
import type { Notice, Store } from './store'
import { releaseResource } from './resource-owners'
import { isNativeMcpActionResult, isNativeMcpSignInPrompt, isNativeMcpStatus } from '../lib/native-mcp-status'

export interface PushContext {
  get(): Store
  set(patch: Partial<Store>): void
  alertAttention(settings: AppSettings | null, event: SoundEvent, body?: string): void
  pushNotice(list: Notice[], type: Notice['type'], text: string, id?: string): Notice[]
  applyBrowserVisibility(): void
  revealBrowser(): void
  t(key: MessageKey, vars?: TVars): string
}

const RESTORE_NOTICE_PREFIX = 'session-restore'

function isRestoreNoticeId(id?: string): boolean {
  return !!id && id.startsWith(RESTORE_NOTICE_PREFIX)
}

export function consumeShellPush(m: MainPush, s: Store, ctx: PushContext): boolean {
  const { set } = ctx
  switch (m.ch) {
    case 'session-moved': {
      const p = m.payload
      if (!p.ok) {
        set({ notices: ctx.pushNotice(s.notices, 'error', ctx.t('state.move.failed', { error: p.error ?? ctx.t('state.error.unknownReason') })) })
        break
      }
      const view = ctx.get()
      const showing = (state: Store) => state.peekedPath === p.sessionFile || state.session?.sessionFile === p.sessionFile || state.session?.sessionId === p.sessionId
      const wasShowing = showing(view)
      const note = p.continued
        ? ctx.t('state.move.continuedSuffix')
        : p.continuationError
          ? ctx.t('state.move.continuationErrorSuffix', { error: p.continuationError })
          : ''
      set({ notices: ctx.pushNotice(view.notices, 'info', ctx.t('state.move.moved', { cwd: p.cwd, note })) })
      void view.refreshSessions().then(() => {
        if (wasShowing && showing(ctx.get())) void ctx.get().switchSession(p.sessionFile)
      })
      break
    }
    case 'win-state':
      set({ maximized: m.payload.maximized, alwaysOnTop: m.payload.alwaysOnTop })
      break
    case 'ui-scale':
      set({
        zoom: m.payload,
        ...(s.settings ? { settings: { ...s.settings, uiScale: m.payload.uiScale } } : {})
      })
      break
    case 'browser-state': {
      const browserStates = m.payload.sessionId ? { ...s.browserStates, [m.payload.sessionId]: m.payload } : s.browserStates
      if (m.payload.sessionId && m.payload.sessionId !== (s.peekedSessionId ?? s.session?.sessionId ?? 'workspace')) { set({ browserStates }); break }
      if (!m.payload.open) releaseResource('browser')
      const viewSessionId = s.peekedSessionId ?? s.session?.sessionId
      const agentArrived = m.payload.open && !!m.payload.agentSessionId && m.payload.agentSessionId === viewSessionId && (!s.browserState.open || s.browserState.agentSessionId !== m.payload.agentSessionId)
      set({ browserState: m.payload, browserStates })
      if (agentArrived) ctx.revealBrowser()
      ctx.applyBrowserVisibility()
      break
    }
    case 'terminal':
      if (m.payload.kind === 'exit') {
        set({
          terminals: s.terminals.map((term) =>
            term.id === m.payload.id ? {
              ...term, alive: false, exitCode: m.payload.exitCode ?? null,
              status: term.status?.state === 'working' || term.status?.state === 'blocked' ? undefined : term.status
            } : term
          )
        })
      }
      else if (m.payload.kind === 'status') {
        const report = m.payload
        set({ terminals: s.terminals.map(term => term.id === report.id ? { ...term, status: report.status } : term) })
      }
      break
    case 'log':
      set({ logs: [...s.logs, m.payload.text].slice(-200) })
      break
    case 'search-api-hint':
      set({
        notices: [
          ...s.notices.filter((n) => n.id !== 'search-api-hint'),
          { id: 'search-api-hint', type: 'info', text: 'search-api-hint', at: Date.now(), action: 'search-api-hint' }
        ]
      })
      break
    case 'pi-info':
      set({ piInfo: m.payload })
      break
    case 'editor-text':
      set({ editorInject: { text: m.payload, mode: 'replace' } })
      break
    case 'proc':
      if (m.payload.state === 'ready') {
        const becameReady = ctx.get().conn !== 'ready'
        set({ conn: 'ready', connDetail: '' })
        if (becameReady) {
          const current = ctx.get()
          void current.reloadModels()
          void current.reloadCommands()
          void current.refreshSessions()
        }
      }
      else if (m.payload.state === 'starting') set({ conn: 'starting' })
      else if (m.payload.state === 'exited') {
        set({
          conn: 'exited',
          connDetail: m.payload.detail || ctx.t('state.conn.kernelExited', { code: m.payload.code ?? 'null' }),
          ...(s.session ? { session: { ...s.session, isAgentRunning: false } } : {})
        })
      } else if (m.payload.state === 'error') {
        const detail = m.payload.detail ?? ctx.t('state.error.unknownError')
        set({
          conn: 'error',
          connDetail: detail,
          logs: [...s.logs, ctx.t('state.log.piError', { detail })].slice(-200),
          ...(s.session ? { session: { ...s.session, isAgentRunning: false } } : {})
        })
        ctx.alertAttention(s.settings, 'error', detail)
      } else if (m.payload.state === 'stderr' && m.payload.detail) {
        set({ logs: [...s.logs, m.payload.detail].slice(-200) })
      }
      break
    default:
      return false
  }
  return true
}

export function consumeQuestionPush(m: MainPush, s: Store, ctx: PushContext): boolean {
  const { set } = ctx
  switch (m.ch) {
    case 'question-log':
      set({ questionLog: m.payload.entries, questionLogSession: m.payload.sessionId })
      break
    case 'approval-log':
      set({ approvalLog: m.payload.entries, approvalLogSession: m.payload.sessionId })
      break
    case 'ui-request': {
      const duplicate = s.uiRequests.some((request) => request.id === m.payload.id)
      set({
        uiRequests: duplicate
          ? s.uiRequests.map((request) => request.id === m.payload.id ? m.payload : request)
          : [...s.uiRequests, m.payload],
        ...(!duplicate ? { uiCollapsed: false } : {})
      })
      if (!duplicate) ctx.alertAttention(s.settings, 'question', m.payload.message ?? m.payload.title)
      break
    }
    case 'ui-resolved':
      set({ uiRequests: s.uiRequests.filter((r) => r.id !== m.payload.id) })
      break
    case 'ui-deadline':
      set({
        uiRequests: s.uiRequests.map((r) =>
          r.id === m.payload.id ? { ...r, timeout: m.payload.timeout, deadline: m.payload.deadline } : r
        )
      })
      break
    case 'notify': {
      const text = m.payload.message ?? ''
      const query = s.nativeMcpStatus
      if (query?.pending && m.runtime?.sessionId === query.sessionId && (query.action ? isNativeMcpActionResult(text) : isNativeMcpStatus(text))) {
        set({ nativeMcpStatus: { ...query, pending: query.action === 'login' && isNativeMcpSignInPrompt(text), text } })
        break
      }

      if (s.startupPhase && !isRestoreNoticeId(m.payload.id) && (m.payload.notifyType ?? 'info') !== 'error') {
        set({ logs: [...s.logs, ctx.t('state.log.extension', { text })].slice(-200) })
        break
      }

      set({
        notices: ctx.pushNotice(
          s.notices,
          m.payload.notifyType ?? 'info',
          text,
          m.payload.id
        )
      })
      if ((m.payload.notifyType ?? 'info') === 'error') ctx.alertAttention(s.settings, 'error', text)
      break
    }
    case 'status': {
      const next = { ...s.statuses }
      if (m.payload.text === undefined) delete next[m.payload.key]
      else next[m.payload.key] = m.payload.text
      set({ statuses: next })
      break
    }
    case 'widget': {
      const next = { ...s.widgets }
      if (!m.payload.lines?.length) delete next[m.payload.key]
      else next[m.payload.key] = m.payload.lines
      set({ widgets: next })
      break
    }
    default:
      return false
  }
  return true
}

export function consumeSubagentPush(m: MainPush, s: Store, ctx: PushContext): boolean {
  const { set } = ctx
  switch (m.ch) {
    case 'subagent': {
      const run = m.payload
      const idx = s.subagents.findIndex((r) => r.id === run.id)
      set({
        subagents:
          idx >= 0
            ? s.subagents.map((r) => (r.id === run.id ? run : r))
            : [...s.subagents, run]
      })
      break
    }
    case 'subagent-patch': {
      const { id, run, transcriptFrom } = m.payload
      const previous = s.subagents.find((r) => r.id === id)
      if (!previous) break
      const merged: SubagentRun = {
        ...run,
        transcript: [...previous.transcript.slice(0, transcriptFrom), ...run.transcript]
      }
      set({ subagents: s.subagents.map((r) => (r.id === id ? merged : r)) })
      break
    }
    case 'subagent-remove':
      set({ subagents: s.subagents.filter((r) => r.id !== m.payload) })
      break
    default:
      return false
  }
  return true
}

export function consumeTaskStatePush(m: MainPush, _s: Store, ctx: PushContext): boolean {
  const { set } = ctx
  switch (m.ch) {
    case 'todos':
      set({ todos: m.payload })
      break
    case 'todo-history':
      set({ todoHistory: m.payload })
      break
    case 'approval':
      if (!_s.approvals.some((item) => item.id === m.payload.id)) set({ approvals: [..._s.approvals, m.payload] })
      break
    case 'git-install':
      set({ gitInstall: m.payload })
      if (m.payload.phase === 'done') set({ notices: _s.notices.filter((n) => n.id !== 'git-install') })
      break
    case 'approval-close':
      set({ approvals: _s.approvals.filter((item) => item.id !== m.payload.id) })
      break
    case 'title':
      document.title = m.payload.trim() || ctx.t('state.appName')
      break
    default:
      return false
  }
  return true
}
