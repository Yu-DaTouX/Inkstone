import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { ArrowLeft, Minus, PanelLeft, PanelRight, Pin, Settings, Square, SquarePen, X } from 'lucide-react'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { IconButton } from '../ui'
import type { V3RouteName } from '../state/ui-v3'
import { IconTip } from './IconTip'
import { v3Text } from './v3-text'

interface Props {
  narrow: boolean
  sidebarOpen: boolean
  route: V3RouteName
  onToggleSidebar: () => void
  /** 悬停在侧栏开关上时临时预览侧栏（收起态） */
  onPreviewSidebar?: () => void
  onSettings: () => void
  onBack: () => void
  /** 右侧工作区是否展开 */
  workspaceOpen: boolean
  onToggleWorkspace: () => void
}

/** 路径最后一段；拿不到路径就用空串，由调用方给兜底文案。 */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * 会话头，同时是窗口的拖动区（48px）。
 *
 * 左侧：侧栏开关（收起时）/ 返回（独立页面）；中间：标题 + 项目名（都可被拖动）；
 * 右侧：最多 3 个操作 + Win11 窗口按钮。
 *
 * 拖动靠 `-webkit-app-region`，由 `ShellV3.css` 的 `features` 层负责；所有可点元素
 * 都显式 `no-drag`（否则按钮会被系统当成拖动区，点不动）。
 */
export function Header({ narrow, sidebarOpen, route, onToggleSidebar, onPreviewSidebar, onSettings, onBack, workspaceOpen, onToggleWorkspace }: Props): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  /* v3 未定稿，工作区按钮的读屏名先本地给，不写进共享 i18n */
  const workspaceLabel = lang === 'en-US' ? 'Workspace' : '工作区'
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const firstUserTitle = useStore((s) => s.messages.find((message) => message.role === 'user')?.text.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '')
  const manualTitles = useStore((s) => s.manualTitles)
  const titles = useStore((s) => s.titles)
  const settings = useStore((s) => s.settings)
  const runners = useStore((s) => s.runners)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const sessions = useStore((s) => s.sessions)
  const maximized = useStore((s) => s.maximized)
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const win = window.yan.win

  /* 悬停侧栏开关稍等片刻才预览，路过不触发；移开即取消 */
  const previewTimer = useRef<number | null>(null)
  const cancelPreview = (): void => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current)
    previewTimer.current = null
  }
  useEffect(() => cancelPreview, [])

  const activeRunner = runners.find((r) => r.id === activeRunnerId || r.runId === activeRunnerId)

  const title = useMemo(() => {
    if (route === 'settings') return text.settingsTitle
    if (route === 'runs') return text.runs
    if (route === 'usage') return t('usage.title')
    if (route === 'schedule') return t('sched.title')
    const id = peekedSessionId ?? session?.conversationId ?? session?.sessionId
    if (id && manualTitles[id]) return manualTitles[id]
    if (id && titles[id]) return titles[id]
    const summary = sessions.find((item) => item.id === id)
    if (summary?.title) return summary.title
    if (!peekedSessionId && session?.sessionName) return session.sessionName
    // 没有标题时用当前视图的首条用户消息，不把内部 jsonl 文件名放在会话头。
    return firstUserTitle || t('rail.untitled')
  }, [route, peekedSessionId, session?.conversationId, session?.sessionId, session?.sessionName, sessions, firstUserTitle, manualTitles, titles, t, text.settingsTitle, text.runs])

  const projectName = useMemo(() => {
    const record = activeRunner?.projectId ? settings?.projects?.find((p) => p.id === activeRunner.projectId) : undefined
    const cwd = activeRunner?.cwd || session?.cwd || settings?.cwd || ''
    if (record?.name) return record.name
    if (cwd && settings?.projectNames?.[cwd]) return settings.projectNames[cwd]
    return cwd ? lastSegment(cwd) : ''
  }, [activeRunner?.projectId, activeRunner?.cwd, session?.cwd, settings?.cwd, settings?.projects, settings?.projectNames])

  return (
    <header className="v3-head">
      <div className="v3-head-left">
        {route === 'chat' ? (
          !sidebarOpen || narrow ? (
            <IconTip label={text.toggleSidebar}>
              <IconButton aria-label={text.toggleSidebar} onPress={onToggleSidebar} onHoverStart={sidebarOpen ? undefined : () => { cancelPreview(); previewTimer.current = window.setTimeout(() => onPreviewSidebar?.(), 280) }} onHoverEnd={cancelPreview} data-testid="v3-rail-toggle">
                <PanelLeft size={16} />
              </IconButton>
            </IconTip>
          ) : null
        ) : (
          <IconTip label={text.back}>
            <IconButton aria-label={text.back} onPress={onBack} data-testid="v3-back">
              <ArrowLeft size={16} />
            </IconButton>
          </IconTip>
        )}
        {route === 'chat' && !sidebarOpen ? (
          <IconTip label={text.newChatShortcut}>
            <IconButton
              aria-label={text.newChatShortcut}
              onPress={() => void useStore.getState().newSession({ scope: 'global' })}
              data-testid="v3-head-new-chat"
            >
              <SquarePen size={16} />
            </IconButton>
          </IconTip>
        ) : null}
        <h1 className="v3-head-title" title={title}>
          {title}
        </h1>
        {projectName ? <span className="v3-head-proj">{projectName}</span> : null}
      </div>

      <div className="v3-head-actions">
        {route === 'chat' ? (
          <IconTip label={workspaceLabel}>
            <IconButton
              aria-label={workspaceLabel}
              aria-pressed={workspaceOpen}
              onPress={onToggleWorkspace}
              data-testid="v3-header-workspace"
              data-active={workspaceOpen ? '1' : '0'}
            >
              <PanelRight size={16} />
            </IconButton>
          </IconTip>
        ) : null}
        <IconTip label={text.settingsEntryHint}>
          <IconButton
            aria-label={text.settings}
            onPress={onSettings}
            data-testid="v3-header-settings"
            data-active={route === 'settings' ? '1' : '0'}
          >
            <Settings size={16} />
          </IconButton>
        </IconTip>

        <IconTip label={lang === 'en-US' ? 'Keep window on top' : '窗口置顶'}>
          <IconButton aria-label={lang === 'en-US' ? 'Keep window on top' : '窗口置顶'} aria-pressed={alwaysOnTop} onPress={() => void toggleAlwaysOnTop()} data-testid="v3-always-on-top"><Pin size={16} /></IconButton>
        </IconTip>
        <div className="v3-win">
          <button type="button" className="v3-winbtn v3-winbtn-min" aria-label={t('tb.minimize')} title={t('tb.minimize')} onClick={() => win.minimize()} data-testid="v3-min">
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="v3-winbtn v3-winbtn-max"
            aria-label={maximized ? t('tb.restore') : t('tb.maximize')}
            title={maximized ? t('tb.restore') : t('tb.maximize')}
            onClick={() => win.maximize()}
            data-testid="v3-max"
          >
            <Square size={maximized ? 12 : 13} />
          </button>
          <button type="button" className="v3-winbtn v3-winbtn-close" aria-label={t('tb.hide')} title={t('tb.hide')} onClick={() => win.close()} data-testid="v3-close">
            <X size={14} />
          </button>
        </div>
      </div>
    </header>
  )
}
