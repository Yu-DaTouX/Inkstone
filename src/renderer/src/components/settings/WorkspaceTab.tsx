import { useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { WORK_MODES, type WorkMode } from '../../../../shared/work-mode'

/** 活动档案的选项：与输入区原来的选择器同源（实施-25 P01 的七档） */
const AGENT_PROFILES = [
  { key: 'auto', profile: 'auto', activity: null },
  { key: 'coding', profile: 'coding', activity: null },
  { key: 'answer', profile: 'daily', activity: 'answer' },
  { key: 'research', profile: 'daily', activity: 'research' },
  { key: 'compose', profile: 'daily', activity: 'compose' },
  { key: 'organize', profile: 'daily', activity: 'organize' },
  { key: 'learn', profile: 'daily', activity: 'learn' }
] as const

/**
 * 「工作区」设置页（实施-27 B3）。
 *
 * 承接两件从主界面撤下来的事：
 *   ① 工作区模式（编码 / 日常）—— 原本是左栏顶部的拨杆；
 *   ② 空间管理 —— 原本是左栏的一个导航分区。
 *
 * 主界面只留对话与结果：空间不再是「左栏里的一层目录」，而是会话/产物的标签，
 * 需要改名、归档、批量整理时到这里来。会话归属仍在会话菜单里改（那里知道
 * 用户点的是哪条会话）。
 */
export function WorkspaceTab() {
  const t = useT()
  const workspaceMode = useStore((s) => s.workspaceMode)
  const setWorkspaceMode = useStore((s) => s.setWorkspaceMode)
  const spaces = useStore((s) => s.spaces)
  const sessions = useStore((s) => s.sessions)
  const refreshSpaces = useStore((s) => s.refreshSpaces)
  const createSpace = useStore((s) => s.createSpace)
  const updateSpace = useStore((s) => s.updateSpace)

  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  /* 当前会话的两项设定：工作模式与活动档案（原在输入区，实施-27 B3 搬来） */
  const storedWorkMode = useStore((s) => s.workMode)
  const defaultWorkMode = useStore((s) => s.settings?.defaultWorkMode ?? 'standard')
  const setWorkMode = useStore((s) => s.setWorkMode)
  const storedProfile = useStore((s) => s.agentProfile)
  const setAgentProfile = useStore((s) => s.setAgentProfile)
  /* 学习管理：课程建在空间里，所以这里只给一个「去学习页」的入口（实施-27 B3） */
  const openSpaceView = useStore((s) => s.openSpaceView)
  const workMode: WorkMode = storedWorkMode?.mode ?? defaultWorkMode
  const profile = storedProfile?.profile ?? 'auto'
  const activity = storedProfile?.activity ?? 'answer'
  const profileKey = profile === 'daily' ? activity : profile

  useEffect(() => {
    void refreshSpaces()
  }, [refreshSpaces])

  const active = spaces.filter((s) => !s.archived)
  const archived = spaces.filter((s) => s.archived)
  const countOf = (id: string): number => sessions.filter((s) => s.spaceId === id).length

  const modeOpts = [
    { id: 'coding' as const, icon: 'terminal' as const, label: t('set.workspaceCoding') },
    { id: 'daily' as const, icon: 'dashboard' as const, label: t('set.workspaceDaily') }
  ]

  return (
    <>
      <div className="set-group">
        <div className="set-row">
          <div className="set-label">
            <div className="set-name">{t('set.sessionHead')}</div>
            <div className="set-desc">{t('set.sessionHeadDesc')}</div>
          </div>
        </div>

        <div className="set-row">
          <div className="set-label">
            <div className="set-name">{t('set.workModeNow')}</div>
            <div className="set-desc">{t('set.workModeNowDesc')}</div>
          </div>
          <div className="set-ctl seg" data-testid="set-work-mode">
            {WORK_MODES.map((mode) => (
              <button
                key={mode}
                className={`seg-btn ${workMode === mode ? 'sel' : ''}`}
                data-mode={mode}
                onClick={() => {
                  if (workMode !== mode) void setWorkMode(mode)
                }}
              >
                {t(`workMode.label.${mode}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="set-row">
          <div className="set-label">
            <div className="set-name"><Icon name="agent" size={12} /> {t('set.agentProfileNow')}</div>
            <div className="set-desc">{t('set.agentProfileNowDesc')}</div>
          </div>
          <div className="set-ctl seg" data-testid="set-agent-profile">
            {AGENT_PROFILES.map((item) => (
              <button
                key={item.key}
                className={`seg-btn ${profileKey === item.key ? 'sel' : ''}`}
                data-profile={item.key}
                onClick={() => {
                  if (profileKey === item.key) return
                  void setAgentProfile(
                    item.profile === 'daily'
                      ? { profile: 'daily', activity: item.activity ?? undefined }
                      : { profile: item.profile }
                  )
                }}
              >
                <span>{t(`agentProfile.${item.key}`)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set-group">
        <div className="set-row">
          <div className="set-label">
            <div className="set-name">{t('set.workspaceMode')}</div>
            <div className="set-desc">{t('set.workspaceModeDesc')}</div>
          </div>
          <div className="set-ctl seg" data-testid="set-workspace-mode">
            {modeOpts.map((o) => (
              <button
                key={o.id}
                className={`seg-btn ${workspaceMode === o.id ? 'sel' : ''}`}
                data-workspace={o.id}
                onClick={() => {
                  if (workspaceMode !== o.id) void setWorkspaceMode(o.id)
                }}
              >
                <Icon name={o.icon} size={12} />
                <span>{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set-group">
        <div className="set-row">
          <div className="set-label">
            <div className="set-name">{t('set.learnManage')}</div>
            <div className="set-desc">{t('set.learnManageDesc')}</div>
          </div>
          <div className="set-ctl">
            <button
              className="set-btn"
              data-testid="set-open-learning"
              onClick={() => openSpaceView('learning')}
            >
              {t('set.learnManageOpen')}
            </button>
          </div>
        </div>
      </div>

      <div className="set-group">
        <div className="set-row">
          <div className="set-label">
            <div className="set-name">{t('set.spaceManage')}</div>
            <div className="set-desc">{t('set.spaceManageDesc')}</div>
          </div>
          <div className="set-ctl">
            <input
              className="set-input"
              value={newName}
              placeholder={t('rail.spaceName')}
              data-testid="set-space-new-name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const name = newName.trim()
                if (!name) return
                void createSpace(name).then((space) => {
                  if (space) setNewName('')
                })
              }}
            />
            <button
              className="set-btn"
              data-testid="set-space-create"
              disabled={!newName.trim()}
              onClick={() => {
                const name = newName.trim()
                if (!name) return
                void createSpace(name).then((space) => {
                  if (space) setNewName('')
                })
              }}
            >
              {t('set.spaceCreate')}
            </button>
          </div>
        </div>

        {active.length === 0 ? (
          <div className="set-row">
            <div className="set-desc" data-testid="set-space-empty">
              {t('rail.noSpaces')}
            </div>
          </div>
        ) : null}

        {active.map((space) => (
          <div className="set-row" key={space.id} data-testid="set-space-row" data-space-id={space.id}>
            <div className="set-label">
              {editing?.id === space.id ? (
                <input
                  className="set-input"
                  autoFocus
                  value={editing.name}
                  data-testid="set-space-rename-input"
                  onChange={(e) => setEditing({ id: space.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setEditing(null)
                      return
                    }
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    const name = editing.name.trim()
                    if (!name) {
                      setEditing(null)
                      return
                    }
                    void updateSpace(space.id, { name }).then((ok) => {
                      if (ok) setEditing(null)
                    })
                  }}
                />
              ) : (
                <div className="set-name" data-testid="set-space-name">
                  {space.name}
                </div>
              )}
              <div className="set-desc">{space.description ?? t('set.spaceSessions', { n: countOf(space.id) })}</div>
            </div>
            <div className="set-ctl">
              {editing?.id === space.id ? (
                <>
                  <button
                    className="set-btn"
                    data-testid="set-space-rename-save"
                    onClick={() => {
                      const name = editing.name.trim()
                      if (!name) {
                        setEditing(null)
                        return
                      }
                      void updateSpace(space.id, { name }).then((ok) => {
                        if (ok) setEditing(null)
                      })
                    }}
                  >
                    {t('set.spaceSave')}
                  </button>
                  <button className="set-btn" onClick={() => setEditing(null)}>
                    {t('set.spaceCancel')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="set-btn"
                    data-testid="set-space-rename"
                    onClick={() => setEditing({ id: space.id, name: space.name })}
                  >
                    {t('set.spaceRename')}
                  </button>
                  <button
                    className="set-btn"
                    data-testid="set-space-archive"
                    title={t('rail.spaceArchive')}
                    onClick={() => void updateSpace(space.id, { archived: true })}
                  >
                    {t('set.spaceArchive')}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}

        {archived.length > 0 ? (
          <>
            <div className="set-row">
              <button
                className="set-btn"
                data-testid="set-space-archived-toggle"
                onClick={() => setShowArchived((v) => !v)}
              >
                <Icon name="chevron-right" size={12} className={`chev ${showArchived ? 'on' : ''}`} />
                <span>{t('set.spaceArchivedHead', { n: archived.length })}</span>
              </button>
            </div>
            {showArchived
              ? archived.map((space) => (
                  <div className="set-row" key={space.id} data-testid="set-space-archived-row" data-space-id={space.id}>
                    <div className="set-label">
                      <div className="set-name">{space.name}</div>
                      <div className="set-desc">{t('set.spaceSessions', { n: countOf(space.id) })}</div>
                    </div>
                    <div className="set-ctl">
                      <button
                        className="set-btn"
                        data-testid="set-space-restore"
                        onClick={() => void updateSpace(space.id, { archived: false })}
                      >
                        {t('set.spaceRestore')}
                      </button>
                    </div>
                  </div>
                ))
              : null}
          </>
        ) : null}
      </div>
    </>
  )
}
