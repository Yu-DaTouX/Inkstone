/**
 * 「技能」分页（S2）。
 *
 * 只读快照 + 会话技能的两种操作（保留到「我的技能」/ 从会话移除）。
 * 快照里的技能是**当前运行实例已加载**的，因此新装 / 改动的技能要等 pi
 * 下次加载才出现在这里 —— 界面用一句明确的说明交代，不把「已安装」当「已加载」。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import type { CapabilitySettingsSnapshot, CapabilitySkillSettingView } from '../../../../../shared/ipc'
import { Button } from '../../../ui'
import { useCapsText } from './text'
import { useConfirm } from './confirm'
import { runConfirmedOperation } from './operation-state'
import { Actions, Empty, Group, Item, ItemHead, ListSkeleton, Meta, Note, Panel, StatusBadge, Warn } from './parts'
import { groupSkills } from './model'

export function SkillsSection(): ReactElement {
  const t = useT()
  const text = useCapsText()
  const confirm = useConfirm()
  const [snapshot, setSnapshot] = useState<CapabilitySettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busySkill, setBusySkill] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.yan.capabilities.snapshot()
      if (!mounted.current) return
      setSnapshot(next)
      setError(null)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  const act = async (action: 'promote' | 'remove', skill: CapabilitySkillSettingView): Promise<void> => {
    setBusySkill(skill.title)
    setNotice(null)
    try {
      if (action === 'promote') {
        const result = await window.yan.capabilities.sessionSkill('promote', skill.title)
        if (!result.ok) {
          setNotice(result.error ?? t('cap.skillActionFailed'))
        } else {
          setNotice(t('cap.skillPromoted'))
        }
        await refresh()
        return
      }
      /*
       * 移除是破坏性的（主进程递归删除本次会话的技能目录，无撤销）：必须先确认。
       * 确认期间切换会话时，目标会话已变，旧确认不得落到新会话的同名技能上，
       * 所以确认前后各取一次 sessionId 比对；不一致就不调 IPC。
       */
      const outcome = await runConfirmedOperation({
        captureScope: () => useStore.getState().session?.sessionId ?? '',
        isMounted: () => mounted.current,
        confirm: () =>
          confirm({
            title: t('cap.skillRemove'),
            body: text('skillRemoveConfirm'),
            detail: skill.title,
            confirmLabel: t('cap.skillRemove'),
            tone: 'danger'
          }),
        run: async () => {
          const result = await window.yan.capabilities.sessionSkill('remove', skill.title)
          if (!result.ok) setNotice(result.error ?? t('cap.skillActionFailed'))
        }
      })
      if (outcome.phase === 'scope-changed' && mounted.current) {
        setNotice(text('skillRemoveScopeChanged'))
      }
      if (outcome.phase === 'done') await refresh()
    } catch (cause) {
      if (mounted.current) setNotice(cause instanceof Error ? cause.message : t('cap.skillActionFailed'))
    } finally {
      if (mounted.current) setBusySkill(null)
    }
  }

  const groups = groupSkills(snapshot?.skills ?? [])

  return (
    <Panel label={t('cap.skillsTitle')}>
      <Note>{text('skillsLoadedNote')}</Note>
      {error ? <Warn>{`${text('loadFailed')}: ${error}`}</Warn> : null}
      {notice ? (
        <p className="caps-result" role="status" data-testid="caps-skill-notice">
          {notice}
        </p>
      ) : null}

      <Group
        title={t('cap.skillsTitle')}
        desc={t('cap.skillsDesc')}
        actions={
          <Button size="sm" variant="ghost" isPending={loading} onPress={() => void refresh()} data-testid="caps-skills-reload">
            {text('sectionReload')}
          </Button>
        }
      >
        {loading && !snapshot ? (
          <ListSkeleton />
        ) : groups.length === 0 ? (
          <Empty>{t('cap.emptySkills')}</Empty>
        ) : (
          groups.map((group) => (
            <section className="caps-subgroup" key={group.origin} data-testid={`caps-skills-${group.origin}`}>
              <h4 className="caps-subgroup-title">{t(`cap.skillOrigin.${group.origin}` as 'cap.skillOrigin.other')}</h4>
              <div className="caps-list">
                {group.skills.map((skill) => (
                  <Item key={skill.id} testId="caps-skill">
                    <ItemHead>
                      <span className="caps-name" title={skill.title}>
                        {skill.title}
                      </span>
                      {skill.origin === 'session' ? (
                        <StatusBadge tone="accent">{t('cap.skillOrigin.session')}</StatusBadge>
                      ) : null}
                      {skill.acquired && group.origin === 'user' ? (
                        <span className="caps-tag">{t('cap.skillAcquired')}</span>
                      ) : null}
                      <span className="caps-spacer" />
                      {group.origin === 'session' ? (
                        <Actions>
                          <Button
                            size="sm"
                            variant="secondary"
                            isDisabled={busySkill === skill.title}
                            onPress={() => void act('promote', skill)}
                            data-testid="caps-skill-promote"
                          >
                            {t('cap.skillPromote')}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            isDisabled={busySkill === skill.title}
                            onPress={() => void act('remove', skill)}
                            data-testid="caps-skill-remove"
                          >
                            {t('cap.skillRemove')}
                          </Button>
                        </Actions>
                      ) : (
                        <StatusBadge tone="neutral">{t('cap.ready')}</StatusBadge>
                      )}
                    </ItemHead>
                    {skill.description ? <Meta>{skill.description}</Meta> : null}
                    {skill.sourceUrl ? (
                      <Meta title={skill.sourceUrl}>{skill.sourceUrl.replace(/^https?:\/\//, '')}</Meta>
                    ) : null}
                  </Item>
                ))}
              </div>
            </section>
          ))
        )}
      </Group>
    </Panel>
  )
}
