/**
 * 配对结果的保存：设备令牌放进系统钥匙串（Android Keystore），不写普通存储。
 * 只保存一台电脑的连接（首版：一部手机对一台砚）。
 */
import * as Keychain from 'react-native-keychain'
import type { Connection } from './api/client'

const SERVICE = 'inkstone.remote.connection'

export async function loadConnection(): Promise<Connection | null> {
  try {
    const entry = await Keychain.getGenericPassword({ service: SERVICE })
    if (!entry) return null
    const parsed = JSON.parse(entry.password) as Partial<Connection>
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.token !== 'string' || typeof parsed.deviceId !== 'string') return null
    const relay = parsed.relay && typeof parsed.relay.join === 'string' && typeof parsed.relay.hostKey === 'string' && typeof parsed.relay.clientKey === 'string'
      ? { join: parsed.relay.join, hostKey: parsed.relay.hostKey, clientKey: parsed.relay.clientKey }
      : undefined
    return { baseUrl: parsed.baseUrl, token: parsed.token, deviceId: parsed.deviceId, computerName: typeof parsed.computerName === 'string' ? parsed.computerName : undefined, deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : undefined, ...(relay ? { relay } : {}) }
  } catch {
    return null
  }
}

export async function saveConnection(connection: Connection): Promise<void> {
  await Keychain.setGenericPassword(connection.deviceId, JSON.stringify(connection), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  })
}

export async function clearConnection(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE })
}
