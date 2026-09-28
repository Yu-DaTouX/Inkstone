import { useEffect, useMemo } from 'react'
import { Icon, type IconName } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { samePath } from '../../../../shared/session-path'
import { SPACE_VIEWS, type SpaceView } from '../../state/space-view'
import { SpaceOverview } from './SpaceOverview'
import { LibraryView } from './LibraryView'
import { ArtifactView } from './ArtifactView'

/**
 * 空间工作台（实施-25 P04）—— 日常模式的四个稳定入口。
 *
 * 中栏的第三态：对话 / 会话地图 / 空间工作台。与地图一样是**纯视图**，
 * 不进设置、不落业务数据。
 *
 * ⚠️ 当前展示哪个空间是**派生**出来的（T04-8）：「导航只是投影」。
 *   来源只有一个 —— 当前会话记录里的 `spaceId`。这里不存第二个副本，
 *   否则「左栏高亮 A、右侧显示 B」的分叉早晚会出现。
 *   唯一的例外是用户手动挑空间：那只在**当前会话没有归属**时生效，
 *   而且一旦换了会话就会被会话自己的归属覆盖（因为它是派生的）。
 */
interface Props {
  view: SpaceView
  onView: (view: SpaceView) => void
  onClose: () => void
  onOpenSession: (path: string) => void
}

export function SpaceWorkbench({ view, onView, onClose, onOpenSession }: Props): React.JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  const spaces = useStore((s) => s.spaces)
  const refreshSpaces = useStore((s) => s.refreshSpaces)
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const libraryLoaded = useStore((s) => s.libraryLoaded)

  const currentSpaceId = useMemo(
    /*
     * 路径比较走 samePath：`===` 在 Windows 的大小写 / 斜杠差异下会漏判，
     * 漏判的后果是「明明归档了却显示未归档」（P02 修过同一个坑）。
     */
    () =>
      sessions.find((s) => s.id === session?.sessionId || samePath(s.path, session?.sessionFile))?.spaceId,
    [sessions, session?.sessionFile]
  )
  const space = useMemo(() => spaces.find((s) => s.id === currentSpaceId), [spaces, currentSpaceId])

  /* 打开时补一次数据：左栏可能还没拉过（比如刚启动就点概览） */
  useEffect(() => {
    void refreshSpaces()
  }, [refreshSpaces])
  useEffect(() => {
    if (!libraryLoaded) void refreshLibrary()
  }, [libraryLoaded, refreshLibrary])

  const tabs: { id: SpaceView; icon: IconName; label: string }[] = SPACE_VIEWS.map((id) => ({
    id,
    icon: id === 'overview' ? 'sparkles' : id === 'library' ? 'folder-open' : 'file',
    label: t(`space.tab.${id}`)
  }))

  return (
    <div className="wb-space" data-testid="space-workbench">
      <header className="wb-space-head">
        <div className="wb-space-title">
          <Icon name="layers" size={14} />
          <span data-testid="space-workbench-name">
            {space ? space.name : currentSpaceId ? t('space.unknown') : t('space.unfiled')}
          </span>
          {space?.archived ? <span className="wb-space-badge">{t('space.archived')}</span> : null}
        </div>
        <nav className="wb-space-tabs" data-testid="space-workbench-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`wb-space-tab ${view === tab.id ? 'on' : ''}`}
              data-testid={`space-tab-${tab.id}`}
              onClick={() => onView(tab.id)}
            >
              <Icon name={tab.icon} size={12} />
              {tab.label}
            </button>
          ))}
        </nav>
        <button className="wb-space-close" data-testid="space-close" onClick={onClose} title={t('space.close')}>
          ×
        </button>
      </header>

      <div className="wb-space-body">
        {view === 'overview' ? (
          <SpaceOverview space={space} spaceId={currentSpaceId} onView={onView} onOpenSession={onOpenSession} />
        ) : view === 'library' ? (
          <LibraryView space={space} spaceId={currentSpaceId} />
        ) : (
          /* 成果：列表 + 编辑器；数据在 ArtifactDocStore，版本推进是纯函数 */
          <ArtifactView spaceId={currentSpaceId} />
        )}
      </div>
    </div>
  )
}
