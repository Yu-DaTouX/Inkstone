import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import type { CapabilitySettingsSnapshot, CapabilitySkillSettingView, ManagedSkillAction } from '../../../../../shared/ipc'
import { Badge, Button, Switch } from '../../../ui'
import { fillCapsText, useCapsText } from './text'
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
    setBusySkill(skill.id)
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

  const manage = async (action: ManagedSkillAction, skill: CapabilitySkillSettingView): Promise<void> => {
    if (!skill.manage) return
    if (action === 'trash') {
      const accepted = await confirm({
        title: text('skillTrash'),
        body: text('skillTrashConfirm'),
        detail: skill.title,
        confirmLabel: text('skillTrash'),
        tone: 'danger'
      })
      if (!accepted) return
    }
    setBusySkill(skill.id)
    setNotice(null)
    try {
      const result = await window.yan.capabilities.manageSkill(action, skill.manage.scope, skill.manage.dir)
      if (!result.ok && mounted.current) setNotice(result.error ?? t('cap.skillActionFailed'))
      await refresh()
    } catch (cause) {
      if (mounted.current) setNotice(cause instanceof Error ? cause.message : t('cap.skillActionFailed'))
    } finally {
      if (mounted.current) setBusySkill(null)
    }
  }

  const reveal = async (skill: CapabilitySkillSettingView): Promise<void> => {
    if (!skill.location) return
    try {
      const result = await window.yan.capabilities.revealSkill(skill.location)
      if (!result.ok && mounted.current) setNotice(result.error ?? t('cap.skillActionFailed'))
    } catch (cause) {
      if (mounted.current) setNotice(cause instanceof Error ? cause.message : t('cap.skillActionFailed'))
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
        settingId="caps-skills"
        actions={
          <Button variant="secondary" isPending={loading} onPress={() => void refresh()} data-testid="caps-skills-reload">
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
                        <Badge>{t('cap.skillAcquired')}</Badge>
                      ) : null}
                      {skill.enabled === false && !skill.manage ? <StatusBadge tone="neutral">{text('skillDisabled')}</StatusBadge> : null}
                      <span className="caps-spacer" />
                      {group.origin === 'session' ? (
                        <Actions>
                          <Button
                            variant="secondary"
                            isDisabled={busySkill === skill.id}
                            onPress={() => void act('promote', skill)}
                            data-testid="caps-skill-promote"
                          >
                            {t('cap.skillPromote')}
                          </Button>
                          <Button
                            variant="danger"
                            isDisabled={busySkill === skill.id}
                            onPress={() => void act('remove', skill)}
                            data-testid="caps-skill-remove"
                          >
                            {t('cap.skillRemove')}
                          </Button>
                        </Actions>
                      ) : (
                        <Actions>
                          {skill.location ? (
                            <Button variant="secondary" onPress={() => void reveal(skill)} data-testid="caps-skill-reveal">
                              {text('skillReveal')}
                            </Button>
                          ) : null}
                          {skill.manage ? (
                            <Button
                              variant="danger"
                              isDisabled={busySkill === skill.id}
                              onPress={() => void manage('trash', skill)}
                              data-testid="caps-skill-trash"
                            >
                              {text('skillTrash')}
                            </Button>
                          ) : null}
                          {skill.manage ? (
                            <Switch
                              aria-label={fillCapsText(text('skillToggleLabel'), { name: skill.title })}
                              isSelected={skill.enabled !== false}
                              isDisabled={busySkill === skill.id}
                              onChange={(next) => void manage(next ? 'enable' : 'disable', skill)}
                              data-testid="caps-skill-toggle"
                            />
                          ) : null}
                        </Actions>
                      )}
                    </ItemHead>
                    {skill.description ? (
                      <Meta title={skill.description} clamp>
                        {skill.description}
                      </Meta>
                    ) : null}
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
