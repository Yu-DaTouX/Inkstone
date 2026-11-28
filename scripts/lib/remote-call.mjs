import { readFileSync } from 'node:fs'

const protocol = readFileSync(new URL('../../src/shared/remote-protocol.ts', import.meta.url), 'utf8')
export const REMOTE_VERSION = Number(/export const REMOTE_PROTOCOL_VERSION = (\d+)/.exec(protocol)[1])
export const VERSION_HEADERS = { 'x-yan-remote-version': String(REMOTE_VERSION) }

export const callPath = (action) => `/remote/v1/call/${action}`

export async function remoteCall(base, action, body = {}, { token, key, headers = {} } = {}) {
  const response = await fetch(base + callPath(action), {
    method: 'POST',
    headers: {
      ...VERSION_HEADERS,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      ...headers
    },
    body: JSON.stringify(body)
  })
  return { status: response.status, response, body: await response.json().catch(() => null) }
}
