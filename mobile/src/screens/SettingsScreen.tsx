import { pick } from '../../../src/shared/ui-lang'
import { LIFE_ASSISTANT_ENABLED } from '../features'
import { useEffect, useState } from 'react'
import { Alert, Linking, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import type { Connection } from '../api/client'
import { openAlertSettings } from '../questionAlerts'
import { useRemote } from '../state'
import { font, mono, radius, space, usePalette } from '../theme'
import { Button, Header, IconButton, Input, Meta, SectionTitle, STATUS_TEXT, StatusDot } from '../ui'
import { deviceInfo } from '../device'
import { useBottomInset } from '../insets'
import { useLang, type LangChoice } from '../lang'

const GUIDE = 'https://github.com/Yu-DaTouX/Inkstone'
const LANG_TITLE = 'Language / 语言'
const LANG_OPTIONS: Array<{ value: LangChoice; label: () => string }> = [
  { value: 'system', label: () => pick('跟随系统', 'Follow system') },
  { value: 'zh-CN', label: () => '中文' },
  { value: 'en-US', label: () => 'English' }
]

export function SettingsScreen({ connection, alertsEnabled, onEnableAlerts, onDisableAlerts, onUnpair, onBack, onToggleSidebar, sidebarVisible, onOpenAssistantSettings, leftHanded, onLeftHandedChange }: {
  connection: Connection
  leftHanded: boolean
  onLeftHandedChange: (value: boolean) => void
  alertsEnabled: boolean
  onEnableAlerts: () => void
  onDisableAlerts: () => void
  onUnpair: () => void
  onBack: () => void
  onToggleSidebar?: () => void
  sidebarVisible?: boolean
  onOpenAssistantSettings?: () => void
}) {
  const p = usePalette()
  const bottomInset = useBottomInset()
  const lang = useLang()
  const { stream, info, client, refresh } = useRemote()
  const [name, setName] = useState(info?.device?.name ?? connection.deviceName ?? '')
  const [renaming, setRenaming] = useState(false)
  useEffect(() => {
    if (info?.device?.name && !['我的手机', '未命名设备'].includes(info.device.name)) setName(info.device.name)
    else void deviceInfo().then((device) => setName(device.name)).catch(() => undefined)
  }, [info?.device?.name])
  const rename = async () => {
    setRenaming(true)
    try { await client.renameDevice(name.trim()); await refresh() }
    catch (err) { Alert.alert(pick('保存失败', 'Save failed'), err instanceof Error ? err.message : pick('请重试', 'Try again')) }
    finally { setRenaming(false) }
  }
  const open = (url: string) => void Linking.openURL(url).catch(() => Alert.alert(pick('无法打开链接', 'Cannot open link'), pick('请稍后重试', 'Try again later')))
  return (
    <View style={{ flex: 1, backgroundColor: p.bg0 }}>
      <Header title={pick('设置', 'Settings')} left={<View style={{ flexDirection: 'row' }}>{onToggleSidebar ? <IconButton name="sidebar-left" label={sidebarVisible ? pick('收起项目和会话列表', 'Hide project and session list') : pick('展开项目和会话列表', 'Show project and session list')} onPress={onToggleSidebar} /> : null}<IconButton name="back" label={pick('返回工作台', 'Back to workspace')} onPress={onBack} /></View>} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: space[6] + bottomInset }]}>
        <SectionTitle>{pick('电脑', 'Desktop')}</SectionTitle>
        <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
          <Text style={{ color: p.fg, fontSize: font.body }}>{info?.computer?.name || connection.computerName || pick('已配对电脑', 'Paired desktop')}</Text>
          <Text style={{ color: p.fgDim, fontSize: font.sm, fontFamily: mono }} selectable>{connection.baseUrl.replace(/^https?:\/\//, '')}</Text>
          <View style={styles.row}><StatusDot color={stream === 'open' ? p.ok : p.warn} /><Meta color={stream === 'open' ? p.ok : p.warn} style={{ fontSize: font.sm, marginLeft: space[2] }}>{STATUS_TEXT[stream]}</Meta></View>
        </View>
        <SectionTitle>{pick('布局', 'Layout')}</SectionTitle>
        <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
          <View style={styles.row}>
            <Text style={{ flex: 1, color: p.fg, fontSize: font.base }}>{pick('左手习惯', 'Left-handed')}</Text>
            <Switch value={leftHanded} onValueChange={onLeftHandedChange} accessibilityLabel={pick('左手习惯', 'Left-handed')} trackColor={{ true: p.accentSoft, false: p.bg3 }} thumbColor={leftHanded ? p.accent : p.fgMute} />
          </View>
          <Text style={{ color: p.fgMute, fontSize: font.sm, lineHeight: 20 }}>{pick('展开分栏时，会话与输入框在左半屏，列表和详情在右半屏。', 'In split view the session and input sit on the left half; the list and details on the right.')}</Text>
        </View>
        <SectionTitle>{pick('待回答提醒', 'Question alerts')}</SectionTitle>
        <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
          <View style={styles.row}>
            <Text style={{ flex: 1, color: p.fg, fontSize: font.base }}>{pick('任务与问题通知', 'Task and question notifications')}</Text>
            <Switch value={alertsEnabled} onValueChange={(enabled) => enabled ? onEnableAlerts() : onDisableAlerts()} accessibilityLabel={pick('手机待回答通知', 'Phone question notifications')} trackColor={{ true: p.accentSoft, false: p.bg3 }} thumbColor={alertsEnabled ? p.accent : p.fgMute} />
          </View>
          <Text style={{ color: p.fgMute, fontSize: font.sm, lineHeight: 20 }}>{pick('同时提醒多 Agent 的待答复、待审阅和待核实事项。锁屏只显示数量。', 'Also alerts for multi-agent items to answer, review or verify. The lock screen shows counts only.')}</Text>
          <Button label={pick('系统通知设置', 'System notification settings')} onPress={() => void openAlertSettings()} />
        </View>
        {LIFE_ASSISTANT_ENABLED ? <>
          <SectionTitle>{pick('生活助手', 'Assistant')}</SectionTitle>
          <Button label={pick('模型与服务商', 'Models and providers')} icon="key" onPress={() => onOpenAssistantSettings?.()} />
          <Meta style={{ fontSize: font.sm }}>{pick('密钥存在系统钥匙串，只在本机；不配对电脑也能用。', 'Keys stay in the system keychain on this phone. Works without pairing.')}</Meta>
        </> : null}
        <SectionTitle>{LANG_TITLE}</SectionTitle>
        <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
          {LANG_OPTIONS.map((option) => <Button key={option.value} label={option.label()} compact variant={lang.choice === option.value ? 'primary' : 'secondary'} onPress={() => lang.setChoice(option.value)} />)}
        </View>
        <SectionTitle>{pick('帮助', 'Help')}</SectionTitle>
        <Button label={pick('使用说明', 'Guide')} icon="external" onPress={() => open(GUIDE)} />
        <Button label={pick('下载 Tailscale', 'Get Tailscale')} icon="external" onPress={() => open('https://tailscale.com/download/android')} />
        <SectionTitle>{pick('设备管理', 'Devices')}</SectionTitle>
        <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
          <Meta style={{ fontSize: font.sm }}>{pick('此手机', 'This phone')}</Meta>
          <View style={[styles.row, { gap: space[2] }]}><Input inset value={name} onChangeText={setName} maxLength={60} accessibilityLabel={pick('此手机设备名', 'This phone name')} style={{ flex: 1 }} />{info?.capabilities.includes('device-name') ? <IconButton name="check" label={pick('保存设备名', 'Save device name')} busy={renaming} disabled={!name.trim() || name.trim() === info.device?.name} onPress={() => void rename()} /> : null}</View>
        </View>
        <Button label={pick('解除配对', 'Unpair')} variant="danger" onPress={() => Alert.alert(pick('解除配对？', 'Unpair?'), pick('重新连接需要新的配对码。', 'Reconnecting needs a new pairing code.'), [
          { text: pick('取消', 'Cancel'), style: 'cancel' },
          { text: pick('解除配对', 'Unpair'), style: 'destructive', onPress: onUnpair }
        ])} />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { padding: space[4], gap: space[2], width: '100%', maxWidth: 640, alignSelf: 'center', paddingBottom: space[6] },
  card: { padding: space[4], borderWidth: 1, borderRadius: radius.lg, gap: space[3] },
  row: { flexDirection: 'row', alignItems: 'center' },
})
