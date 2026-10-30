import type { ProjectRecord } from '../../../../../shared/ipc'
import { useStore } from '../../../state/store'
import { translate } from '../../../i18n'
import { currentLang } from '../../../i18n/lang'
import { deleteSessionWithUndo } from '../../../features/sidebar/session-undo-toast'
import { leaveSessionAfter, openSidebarSession } from '../../../features/sidebar/session-advance'
import { ensureProjectForCwd, setProjectArchived } from '../../../features/sidebar/ProjectHeader'
import type { ThreadRef } from './types'

function sessionOf(ref: ThreadRef) {
  return useStore.getState().sessions.find((item) => item.id === ref.threadId) ?? null
}

function titleOf(ref: ThreadRef): string {
  const state = useStore.getState()
  const item = sessionOf(ref)
  if (!item) return ''
  return state.manualTitles[item.id] ?? state.titles[item.id] ?? item.title
}

async function copyText(text: string): Promise<void> {
  if (!text) return
  await navigator.clipboard.writeText(text).catch(() => undefined)
}

export interface SidebarActions {
  open(ref: ThreadRef): void
  rename(ref: ThreadRef, title: string): Promise<void>
  archive(ref: ThreadRef): Promise<boolean>
  unarchive(ref: ThreadRef): Promise<boolean>
  pin(ref: ThreadRef): Promise<boolean>
  unpin(ref: ThreadRef): Promise<boolean>
  snooze(ref: ThreadRef, until: number | null): Promise<boolean>
  unsnooze(ref: ThreadRef): Promise<boolean>
  markUnread(ref: ThreadRef): Promise<boolean>
  markRead(ref: ThreadRef): Promise<boolean>
  move(ref: ThreadRef, projectId: string | null, cwd?: string): Promise<boolean>
  remove(ref: ThreadRef): Promise<void>
  discardDraft(ref: ThreadRef): void
  copyPath(ref: ThreadRef): Promise<void>
  copyBranch(ref: ThreadRef): Promise<void>
  copyThreadRef(ref: ThreadRef): Promise<void>
  copyThreadId(ref: ThreadRef): Promise<void>
  regenerateTitle(ref: ThreadRef): Promise<boolean>
  archiveProject(project: ProjectRecord): Promise<boolean>
  restoreProject(project: ProjectRecord): Promise<boolean>
  ensureProject(cwd: string): Promise<ProjectRecord | undefined>
  newThreadIn(project: ProjectRecord): Promise<void>
}

export const sidebarActions: SidebarActions = {
  open(ref) {
    const item = sessionOf(ref)
    if (item) void openSidebarSession({ id: item.id, path: item.path })
  },
  async rename(ref, title) {
    await useStore.getState().setManualTitle(ref.threadId, title)
  },
  async archive(ref) {
    const item = sessionOf(ref)
    if (!item) return false
    return leaveSessionAfter(item.path, () => useStore.getState().setSessionArchived(ref.threadId, true))
  },
  async unarchive(ref) {
    return useStore.getState().setSessionArchived(ref.threadId, false)
  },
  async pin(ref) {
    return useStore.getState().setSessionPinned(ref.threadId, true)
  },
  async unpin(ref) {
    return useStore.getState().setSessionPinned(ref.threadId, false)
  },
  async snooze(ref, until) {
    const item = sessionOf(ref)
    if (!item) return false
    if (until === null) return useStore.getState().setSessionSnoozed(ref.threadId, null)
    return leaveSessionAfter(item.path, () => useStore.getState().setSessionSnoozed(ref.threadId, until))
  },
  async unsnooze(ref) {
    return useStore.getState().setSessionSnoozed(ref.threadId, null)
  },
  async markUnread(ref) {
    return useStore.getState().setSessionMarkedUnread(ref.threadId, true)
  },
  async markRead(ref) {
    return useStore.getState().setSessionMarkedUnread(ref.threadId, false)
  },
  async move(ref, projectId, cwd) {
    return useStore.getState().moveSession(ref.threadId, projectId, cwd)
  },
  async remove(ref) {
    const item = sessionOf(ref)
    if (!item) return
    const lang = currentLang()
    await deleteSessionWithUndo(item.path, titleOf(ref), (key, vars) => translate(lang, key, vars))
  },
  discardDraft(ref) {
    useStore.getState().setSessionDraft('', ref.threadId)
  },
  async copyPath(ref) {
    await copyText(sessionOf(ref)?.cwd ?? '')
  },
  async copyBranch() {
    await copyText('')
  },
  async copyThreadRef(ref) {
    const item = sessionOf(ref)
    if (item) await copyText(item.path)
  },
  async copyThreadId(ref) {
    await copyText(ref.threadId)
  },
  async regenerateTitle(ref) {
    await useStore.getState().regenerateTitle(ref.threadId)
    return true
  },
  async archiveProject(project) {
    return setProjectArchived(project.id, true)
  },
  async restoreProject(project) {
    return setProjectArchived(project.id, false)
  },
  async ensureProject(cwd) {
    return ensureProjectForCwd(cwd)
  },
  async newThreadIn(project) {
    const created = await useStore.getState().newSession({ cwd: project.cwd, projectId: project.id, scope: 'project' })
    if (created.ok) await useStore.getState().refreshSessions()
  }
}

export function useSidebarActions(): SidebarActions {
  return sidebarActions
}
