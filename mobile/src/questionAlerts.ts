import { pick } from '../../src/shared/ui-lang'
import { NativeModules, PermissionsAndroid, Platform } from 'react-native'
import type { Connection } from './api/client'
import { relayClientPublicKey } from './api/relay'

interface QuestionAlertsNative {
  start(baseUrl: string, token: string, relay: { join: string; hostKey: string; clientKey: string; clientPub: string } | null): Promise<boolean>
  stop(): Promise<boolean>
  status(): Promise<{ enabled: boolean; wanted: boolean; active: boolean }>
  openSettings(): Promise<boolean>
}

function native(): QuestionAlertsNative | null {
  return Platform.OS === 'android'
    ? (NativeModules.InkstoneQuestionAlerts as QuestionAlertsNative | undefined) ?? null
    : null
}

export async function startQuestionAlerts(connection: Connection, requestPermission = false): Promise<boolean> {
  const alerts = native()
  if (!alerts) return false
  if (Number(Platform.Version) >= 33) {
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    if (!await PermissionsAndroid.check(permission)) {
      if (!requestPermission) return false
      const result = await PermissionsAndroid.request(permission, {
        title: pick('开启待回答提醒', 'Enable question alerts'),
        message: pick('电脑上的砚需要你回答时，在这台手机显示通知。开启后会有一条持续的连接状态通知。', 'Show a notification when Inkstone on the desktop needs an answer. A persistent connection notice will appear.'),
        buttonPositive: pick('开启', 'Enable'),
        buttonNegative: pick('暂不开启', 'Not now')
      })
      if (result !== PermissionsAndroid.RESULTS.GRANTED) return false
    }
  }
  const relay = connection.relay ? { ...connection.relay, clientPub: relayClientPublicKey(connection.relay.clientKey) } : null
  return alerts.start(connection.baseUrl, connection.token, relay)
}

export async function restoreQuestionAlerts(connection: Connection): Promise<boolean> {
  const status = await native()?.status()
  return !!status?.wanted && !!status.enabled && await startQuestionAlerts(connection)
}

export async function stopQuestionAlerts(): Promise<void> {
  await native()?.stop()
}

export async function openAlertSettings(): Promise<void> {
  await native()?.openSettings()
}
