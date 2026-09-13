import type { CdpChannel } from './CdpChannel'

interface ProtocolCookie {
  name: string; value: string; domain: string; path: string;
  secure: boolean; httpOnly: boolean; session: boolean; expires: number;
  sameSite?: string; partitionKey?: unknown; partitionKeyOpaque?: boolean;
}

/** Explicit one-way copy. Never log values or replace a live profile database.
 * Host-only scope and session lifetime must survive the transfer unchanged. */
export async function transferCookies(source: CdpChannel, target: CdpChannel): Promise<{ copied: number; failed: number }> {
  const { cookies } = await source.send<{ cookies: ProtocolCookie[] }>('Storage.getCookies')
  let copied = 0
  let failed = 0
  for (const cookie of cookies) {
    if (cookie.partitionKeyOpaque) { failed++; continue }
    const host = cookie.domain.replace(/^\./, '')
    const param: Record<string, unknown> = {
      name: cookie.name, value: cookie.value, path: cookie.path,
      url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`,
      secure: cookie.secure, httpOnly: cookie.httpOnly
    }
    if (cookie.domain.startsWith('.')) param.domain = cookie.domain
    if (!cookie.session && cookie.expires > 0) param.expires = cookie.expires
    if (cookie.sameSite) param.sameSite = cookie.sameSite
    if (cookie.partitionKey) param.partitionKey = cookie.partitionKey
    try {
      await target.send('Storage.setCookies', { cookies: [param] })
      copied++
    } catch { failed++ }
  }
  return { copied, failed }
}
