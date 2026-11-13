import type { ReactElement } from 'react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Switch } from '../../ui'
import { SettingsRow } from '../settings/root/controls'

const TEXT = {
  'zh-CN': {
    label: '记录界面问题',
    desc: '按 Ctrl+Alt+F 存下刚才一分钟的界面；跳动、卡顿、连点和报错也会自动存。只存本机，7 天后清理。',
    open: '打开文件夹'
  },
  'en-US': {
    label: 'Record UI friction',
    desc: 'Ctrl+Alt+F saves the last minute of the interface; jumps, stalls, repeated clicks and errors save on their own. Local only, cleared after 7 days.',
    open: 'Open folder'
  }
} as const

export function FrictionSetting(): ReactElement {
  const { lang } = useI18n()
  const text = TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  const enabled = useStore((s) => s.settings?.frictionRecorder === true)
  const patchSettings = useStore((s) => s.patchSettings)
  return (
    <SettingsRow settingId="about-friction" label={text.label} description={text.desc}>
      {enabled ? (
        <Button variant="secondary" data-testid="v3-friction-open" onPress={() => void window.yan.friction.openFolder().catch(() => undefined)}>
          {text.open}
        </Button>
      ) : null}
      <Switch
        aria-label={text.label}
        isSelected={enabled}
        onChange={(on) => void patchSettings({ frictionRecorder: on }).catch(() => undefined)}
        data-testid="v3-friction-toggle"
      />
    </SettingsRow>
  )
}
