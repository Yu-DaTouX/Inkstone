/**
 * 宿主动作的运行时（把纯动作表接到 store / 宿主事件上）。
 *
 * 命令面板与全局按键分发共用这一个 hook：
 *   · 动作执行只调用各入口的正式动作（store action、`yan:theme`、工作区启动事件），
 *     不新建 IPC 或状态副本；
 *   · 可用性从当前 store 快照推导，面板据此把不可用动作整行禁用。
 */
import { useMemo } from 'react'
import { useStore } from '../state/store'
import type { HostActionAvailability, HostActionRuntime } from './host-actions'
import { normalizePermissionMode } from '../../../shared/approval'

export interface HostActions {
  runtime: HostActionRuntime
  availability: HostActionAvailability
}

/** 当前会话所属项目：运行实例优先，其次按 cwd 找项目记录（与输入区 @ 补全同一口径）。 */
function currentProject(): { cwd: string; projectId?: string } {
  const s = useStore.getState()
  const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
  const cwd = s.session?.cwd ?? s.settings?.cwd ?? ''
  if (runner?.projectId) return { cwd, projectId: runner.projectId }
  const summary = s.sessions.find(
    (item) => item.id === s.session?.sessionId || item.path === s.session?.sessionFile
  )
  if (summary?.scope === 'global') return { cwd }
  const projectId =
    summary?.projectId ??
    s.settings?.projects.find((project) => {
      const a = project.cwd.replace(/[\\/]+$/, '').toLowerCase()
      const b = cwd.replace(/[\\/]+$/, '').toLowerCase()
      return a === b
    })?.id
  return { cwd, projectId }
}

export function useHostActionRuntime(openShortcutSheet: () => void): HostActions {
  const theme = useStore((s) => s.settings?.theme) ?? 'dark'
  const permission = normalizePermissionMode(useStore((s) => s.settings?.permissionMode))
  const running = useStore((s) => !!s.session?.isAgentRunning || !!s.session?.isStreaming)
  const hasLastReply = useStore((s) =>
    s.messages.some((m) => m.role === 'assistant' && !!m.text?.trim())
  )
  const hasProject = useStore((s) => {
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    if (runner?.projectId) return true
    const cwd = s.session?.cwd ?? s.settings?.cwd ?? ''
    const summary = s.sessions.find(
      (item) => item.id === s.session?.sessionId || item.path === s.session?.sessionFile
    )
    if (summary?.scope === 'global') return false
    if (summary?.projectId) return true
    return !!s.settings?.projects.find((project) => {
      const a = project.cwd.replace(/[\\/]+$/, '').toLowerCase()
      const b = cwd.replace(/[\\/]+$/, '').toLowerCase()
      return a === b
    })
  })
  const browserOpen = useStore((s) => s.browserState.open)

  const runtime = useMemo<HostActionRuntime>(
    () => ({
      openSettings: (tab) => useStore.getState().openSettings(tab),
      newSession: () => useStore.getState().newSession({ scope: 'global' }),
      newSessionProject: () => {
        const { cwd, projectId } = currentProject()
        if (!projectId) {
          useStore.getState().notify('info', '当前会话不在项目里，先打开或新建一个项目')
          return Promise.resolve()
        }
        return useStore.getState().newSession({ cwd, projectId, scope: 'project' })
      },
      setPermission: async (mode) => {
        try {
          await useStore.getState().patchSettings({ permissionMode: mode })
        } catch (error) {
          useStore.getState().notify('error', String(error))
        }
      },
      setTheme: async (next) => {
        try {
          localStorage.setItem('yan.theme', next)
        } catch {
          /* 存不了就只在本次会话生效 */
        }
        await useStore.getState().patchSettings({ theme: next })
        /* 与设置页同一入口：App 监听它并跑主题过渡 */
        window.dispatchEvent(new CustomEvent('yan:theme', { detail: { theme: next } }))
      },
      toggleRail: () => useStore.getState().setRailPinned(!useStore.getState().railPinned),
      launchTool: (kind) => window.dispatchEvent(new CustomEvent('inkstone-workspace-launch', { detail: kind })),
      copyLastReply: () => useStore.getState().copyLastReply(),
      stopRun: () => useStore.getState().abort(),
      openShortcutSheet
    }),
    [openShortcutSheet]
  )

  const availability = useMemo<HostActionAvailability>(
    () => ({ running, hasLastReply, hasProject, permission, theme, browserOpen }),
    [running, hasLastReply, hasProject, permission, theme, browserOpen]
  )

  return { runtime, availability }
}

/** 输入框的正式焦点入口（Ctrl+L）：分屏只渲染焦点那一列，选择器唯一。 */
export function focusComposerInput(): void {
  const el = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')
  el?.focus()
}
