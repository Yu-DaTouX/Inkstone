import { useEffect, useState } from 'react'
import { Alert, Linking, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import type { Connection } from '../api/client'
import { openAlertSettings } from '../questionAlerts'
import { useRemote } from '../state'
import { font, radius, space, usePalette } from '../theme'
import { Button, Header, IconButton, SectionTitle } from '../ui'
import { deviceInfo } from '../device'

const GUIDE = 'https://github.com/Yu-DaTouX/Inkstone/blob/main/docs/MOBILE_ACCESS.md'

export function SettingsScreen({ connection, alertsEnabled, onEnableAlerts, onDisableAlerts, onUnpair, onBack, onToggleSidebar, sidebarVisible }: {
  connection: Connection
  alertsEnabled: boolean
  onEnableAlerts: () => void
  onDisableAlerts: () => void
  onUnpair: () => void
  onBack: () => void
  onToggleSidebar?: () => void
  sidebarVisible?: boolean
}) {
  const p = usePalette()
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
    catch (err) { Alert.alert('保存失败', err instanceof Error ? err.message : '请重试') }
    finally { setRenaming(false) }
  }
  const open = (url: string) => void Linking.openURL(url).catch(() => Alert.alert('无法打开链接', '请稍后重试'))
  return (
    <View style={{ flex: 1, backgroundColor: p.bg0 }}>
      <Header title="设置" left={<IconButton name="back" label="返回工作台" onPress={onBack} />} right={onToggleSidebar ? <IconButton name="sidebar-left" label={sidebarVisible ? '收起项目和会话列表' : '展开项目和会话列表'} onPress={onToggleSidebar} /> : undefined} />
      <ScrollView contentContainerStyle={styles.content}>
        <SectionTitle>电脑</SectionTitle>
        <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
          <Text style={{ color: p.fg, fontSize: font.body }}>{info?.computer?.name || connection.computerName || '已配对电脑'}</Text>
          <Text style={{ color: p.fg, fontSize: font.body }} selectable>{connection.baseUrl.replace(/^https?:\/\//, '')}</Text>
          <Text style={{ color: stream === 'open' ? p.ok : p.warn, fontSize: font.sm }}>{stream === 'open' ? '已连接' : '等待电脑连接'}</Text>
        </View>
        <SectionTitle>待回答提醒</SectionTitle>
        <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
          <View style={styles.row}>
            <Text style={{ flex: 1, color: p.fg, fontSize: font.base }}>任务与问题通知</Text>
            <Switch value={alertsEnabled} onValueChange={(enabled) => enabled ? onEnableAlerts() : onDisableAlerts()} accessibilityLabel="手机待回答通知" trackColor={{ true: p.accentSoft, false: p.bg3 }} thumbColor={alertsEnabled ? p.accent : p.fgMute} />
          </View>
          <Text style={{ color: p.fgMute, fontSize: font.sm, lineHeight: 20 }}>锁屏仅显示问题数量</Text>
          <Button label="系统通知设置" onPress={() => void openAlertSettings()} />
        </View>
        <SectionTitle>帮助</SectionTitle>
        <Button label="使用说明" icon="external" onPress={() => open(GUIDE)} />
        <Button label="下载 Tailscale" icon="external" onPress={() => open('https://tailscale.com/download/android')} />
        <SectionTitle>设备管理</SectionTitle>
        <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
          <Text style={{ color: p.fgDim, fontSize: font.sm }}>此手机</Text>
          <View style={styles.row}><TextInput disableFullscreenUI value={name} onChangeText={setName} maxLength={60} accessibilityLabel="此手机设备名" style={{ flex: 1, color: p.fg, minHeight: 44, padding: 8, backgroundColor: p.bg0, borderRadius: radius.md }} />{info?.capabilities.includes('device-name') ? <IconButton name="check" label="保存设备名" busy={renaming} disabled={!name.trim() || name.trim() === info.device?.name} onPress={() => void rename()} /> : null}</View>
        </View>
        <Button label="解除配对" variant="danger" onPress={() => Alert.alert('解除配对？', '提醒将停止，重新连接需要新配对码。', [
          { text: '取消', style: 'cancel' },
          { text: '解除配对', style: 'destructive', onPress: onUnpair }
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
