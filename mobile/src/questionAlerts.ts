import { NativeModules, PermissionsAndroid, Platform } from 'react-native'
import type { Connection } from './api/client'

interface QuestionAlertsNative {
  start(baseUrl: string, token: string): Promise<boolean>
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
        title: '开启待回答提醒',
        message: '电脑上的砚需要你回答时，在这台手机显示通知。开启后会有一条持续的连接状态通知。',
        buttonPositive: '开启',
        buttonNegative: '暂不开启'
      })
      if (result !== PermissionsAndroid.RESULTS.GRANTED) return false
    }
  }
  return alerts.start(connection.baseUrl, connection.token)
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
