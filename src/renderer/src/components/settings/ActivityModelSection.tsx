import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { ACTIVITY_MODEL_SCOPE_NOTE, type ActivityModelRow } from '../../../../shared/activity-model'
import type { AgentActivity } from '../../../../shared/agent-profile'
import { SettingRow } from '../ui'

/**
 * 按活动用不同模型（实施-25 P18）。
 *
 * 界面只做两件事：把每个活动的模型填进去、把「为什么是这个模型」显示出来。
 * **不在这里切模型**（切模型仍走模型选择器）—— 所以这一块的位置在
 * 「接入」页：它管的是配置，不是当前会话用哪个。
 *
 * 顶部那句「不会新建会话 / 不改任务与学习状态」是这张卡的固定组成部分：
 * 不写清的话，用户会以为换模型等于换任务。
 */
export function ActivityModelSection(): React.JSX.Element {
  const t = useT()
  const session = useStore((s) => s.session)
  const [rows, setRows] = useState<ActivityModelRow[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [notice, setNotice] = useState('')
  const currentKey = session?.model ? `${session.model.provider}/${session.model.id}` : null

  const refresh = async (): Promise<void> => {
    const next = await window.yan.activity.rows({ current: currentKey })
    setRows(next)
  }

  useEffect(() => {
    void refresh().catch((error) => setNotice(error instanceof Error ? error.message : t('am.failed')))
    // currentKey 变化时重算「跟随会话」那一档，避免显示过期的解释
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey])

  const setOne = async (activity: AgentActivity, model: string): Promise<void> => {
    try {
      const res = await window.yan.activity.setModel({ activity, model: model.trim() || null })
      if (!res.ok) {
        setNotice(res.error ?? t('am.failed'))
        return
      }
      setNotice('')
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('am.failed'))
    }
  }

  const setDefault = async (model: string): Promise<void> => {
    try {
      const res = await window.yan.activity.setModel({ defaultModel: model.trim() || null })
      if (!res.ok) {
        setNotice(res.error ?? t('am.failed'))
        return
      }
      setNotice('')
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('am.failed'))
    }
  }

  return (
    <div className="ui-rows" data-testid="set-activity-models">
      {/* 只管配置：当前会话用哪个模型仍由输入框里的模型选择器决定（边界说明放在悬停提示里） */}
      <div className="ui-row-desc am-desc" title={ACTIVITY_MODEL_SCOPE_NOTE} data-testid="am-scope">
        {t('am.desc')}
      </div>
      <SettingRow name={t('am.default')}>
        <input
          className="ui-input"
          data-testid="am-default"
          value={defaultModel}
          placeholder={t('am.defaultPlaceholder')}
          aria-label={t('am.default')}
          onChange={(event) => setDefaultModel(event.target.value)}
          onBlur={() => void setDefault(defaultModel)}
        />
      </SettingRow>
      <div className="am-list" data-testid="am-list">
        {rows.map((row) => (
          <SettingRow
            key={row.activity}
            data-testid={`am-row-${row.activity}`}
            name={<span data-testid={`am-name-${row.activity}`}>{t(`agentProfile.${row.activity}`)}</span>}
            desc={row.resolution.fellBack ? (
              <span className="am-note fell-back" data-testid={`am-note-${row.activity}`}>{row.resolution.note}</span>
            ) : undefined}
          >
            <input
              className="ui-input"
              data-testid={`am-input-${row.activity}`}
              defaultValue={row.configured ?? ''}
              placeholder={t('am.followDefault')}
              title={row.resolution.note}
              aria-label={row.activity}
              onBlur={(event) => void setOne(row.activity, event.target.value)}
            />
          </SettingRow>
        ))}
      </div>

      {notice ? (
        <div className="ui-row-desc" data-testid="am-notice">
          {notice}
        </div>
      ) : null}
    </div>
  )
}
