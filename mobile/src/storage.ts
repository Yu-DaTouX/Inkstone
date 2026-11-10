import * as Keychain from 'react-native-keychain'
import type { Connection } from './api/client'
import { DIRECT_URL } from './api/relay'

const SERVICE = 'inkstone.remote.connection'

export async function loadConnection(): Promise<Connection | null> {
  try {
    const entry = await Keychain.getGenericPassword({ service: SERVICE })
    if (!entry) return null
    const parsed = JSON.parse(entry.password) as Partial<Connection>
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.token !== 'string' || typeof parsed.deviceId !== 'string') return null
    const saved = parsed.relay
    const direct = Array.isArray(saved?.direct) ? saved.direct.filter((url): url is string => typeof url === 'string' && DIRECT_URL.test(url)) : []
    const join = typeof saved?.join === 'string' ? saved.join : undefined
    const relay = saved && (join || direct.length) && typeof saved.hostKey === 'string' && typeof saved.clientKey === 'string'
      ? { ...(join ? { join } : {}), ...(direct.length ? { direct } : {}), hostKey: saved.hostKey, clientKey: saved.clientKey }
      : undefined
    return { baseUrl: parsed.baseUrl, token: parsed.token, deviceId: parsed.deviceId, computerName: typeof parsed.computerName === 'string' ? parsed.computerName : undefined, deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : undefined, ...(typeof parsed.clientKey === 'string' ? { clientKey: parsed.clientKey } : {}), ...(relay ? { relay } : {}) }
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
