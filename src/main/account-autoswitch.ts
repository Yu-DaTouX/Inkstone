import type { AccountQuotaCard } from '../shared/account-quota'
import { supportsOAuthAccounts } from '../shared/oauth-accounts'
import { blockedQuotaWindows } from '../shared/quota-resume'
import { accountQuotaReport, invalidateAccountQuotaReport } from './account-quota'
import { captureActiveApiKey } from './api-key-pool'
import { switchCodexAccount } from './codex-accounts'
import { switchOAuthAccount } from './oauth-accounts'

const usable = (card: AccountQuotaCard): boolean => card.status === 'ok' && !card.staleError && card.windows.length > 0 && blockedQuotaWindows(card.windows).length === 0

export function pickSpareAccount(cards: readonly AccountQuotaCard[], provider: string): AccountQuotaCard | null {
  const usage = (card: AccountQuotaCard): number => Math.max(0, ...card.windows.filter((w) => !w.informational && w.total > 0).map((w) => w.used / w.total))
  const own = cards.filter((card) => card.source === 'yan' && card.provider === provider && card.switchable)
  const active = own.find((card) => card.active)
  if (active && usable(active)) return active
  return own.filter((card) => !card.active && usable(card)).sort((a, b) => usage(a) - usage(b))[0] ?? null
}

let chain: Promise<unknown> = Promise.resolve()

export function switchToSpareAccount(provider: string): Promise<{ key: string; label: string; switched: boolean } | null> {
  const next = chain.then(() => switchNow(provider), () => switchNow(provider))
  chain = next.catch(() => undefined)
  return next
}

async function switchNow(provider: string): Promise<{ key: string; label: string; switched: boolean } | null> {
  if (provider !== 'openai-codex' && !supportsOAuthAccounts(provider)) return null
  invalidateAccountQuotaReport()
  const target = pickSpareAccount((await accountQuotaReport()).cards, provider)
  if (!target) return null
  const label = target.label || target.email || target.name
  if (target.active) return { key: target.key, label, switched: false }
  if (provider === 'openai-codex') {
    if (!(await switchCodexAccount(target.key)).ok) return null
  } else {
    if (!(await captureActiveApiKey(provider)).ok) return null
    if (!(await switchOAuthAccount(provider, target.key)).ok) return null
  }
  invalidateAccountQuotaReport()
  return { key: target.key, label, switched: true }
}
