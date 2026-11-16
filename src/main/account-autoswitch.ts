import type { AccountQuotaCard } from '../shared/account-quota'
import { supportsOAuthAccounts } from '../shared/oauth-accounts'
import { blockedQuotaWindows } from '../shared/quota-resume'
import { accountQuotaReport, invalidateAccountQuotaReport } from './account-quota'
import { getSettings } from './settings'
import { captureActiveApiKey } from './api-key-pool'
import { switchCodexAccount } from './codex-accounts'
import { switchOAuthAccount } from './oauth-accounts'

const known = (card: AccountQuotaCard): boolean => card.status === 'ok' && !card.staleError && card.windows.length > 0 && blockedQuotaWindows(card.windows).length === 0
const refreshFailed = new Set<string>()

export function pickSpareAccount(cards: readonly AccountQuotaCard[], provider: string, failed: ReadonlySet<string> = refreshFailed): AccountQuotaCard | null {
  const usable = (card: AccountQuotaCard): boolean => known(card) || (card.status === 'expired' && card.refreshable === true && !failed.has(card.key))
  const usage = (card: AccountQuotaCard): number => known(card) ? Math.max(0, ...card.windows.filter((w) => !w.informational && w.total > 0).map((w) => w.used / w.total)) : 2
  const own = cards.filter((card) => card.source === 'yan' && card.provider === provider && card.switchable)
  const active = own.find((card) => card.active)
  if (active && usable(active)) return active
  return own.filter((card) => !card.active && usable(card)).sort((a, b) => usage(a) - usage(b))[0] ?? null
}

export function markRefreshFailed(cards: readonly AccountQuotaCard[], provider: string, failed: Set<string> = refreshFailed): string | null {
  const active = cards.find((card) => card.source === 'yan' && card.provider === provider && card.switchable && card.active)
  if (!active || active.status === 'ok') return null
  failed.add(active.key)
  return active.key
}

let chain: Promise<unknown> = Promise.resolve()

export function switchToSpareAccount(provider: string, opts: { refreshFailed?: boolean } = {}): Promise<{ key: string; label: string; switched: boolean } | null> {
  const next = chain.then(() => switchNow(provider, opts), () => switchNow(provider, opts))
  chain = next.catch(() => undefined)
  return next
}

async function switchNow(provider: string, opts: { refreshFailed?: boolean }): Promise<{ key: string; label: string; switched: boolean } | null> {
  if (provider !== 'openai-codex' && !supportsOAuthAccounts(provider)) return null
  if ((await getSettings()).accountFailover !== true) return null
  invalidateAccountQuotaReport()
  const cards = (await accountQuotaReport()).cards
  for (const card of cards) if (card.status === 'ok') refreshFailed.delete(card.key)
  if (opts.refreshFailed) markRefreshFailed(cards, provider)
  const target = pickSpareAccount(cards, provider)
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
