import { isAuthRejected, isOAuthRefreshFailure } from '../shared/model-errors'
import { readAuthEntry } from './credentials'

export const AUTH_BLIP_RETRY_MS = 5000

export function isAuthBlip(errorText: unknown, state: { retried: boolean; continued: boolean }): boolean {
  return !state.retried && !state.continued && isAuthRejected(errorText)
}

export function isAuthBlipRecoverable(errorText: unknown): boolean {
  return !isOAuthRefreshFailure(errorText)
}

export async function providerUsesOAuth(provider: string): Promise<boolean> {
  const entry = await readAuthEntry(provider).catch(() => undefined) as { type?: unknown } | undefined
  return entry?.type === 'oauth'
}

export function providerOfModelLabel(model: string | undefined): string | undefined {
  const cut = model?.indexOf('/') ?? -1
  return model && cut > 0 ? model.slice(0, cut) : undefined
}

export function waitAuthBlip(ms: number = AUTH_BLIP_RETRY_MS): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}
