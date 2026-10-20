import { PreviewSiteAccess, type SiteAccessStore, type SiteAddResult, type SiteDecision } from './preview-site-access'

export interface PreviewSiteGateDeps {
  confirm(origin: string, url: string): Promise<boolean>
  store?: SiteAccessStore
  limit?: number
}

export interface PreviewSiteGate {
  ready(): Promise<void>
  peek(sessionId: string, url: string): SiteDecision
  check(sessionId: string, url: string): Promise<SiteDecision>
  sites(): string[]
  addSite(value: string): { result: SiteAddResult; list: string[]; origin?: string }
  removeSite(value: string): { removed: boolean; list: string[] }
  clearSites(): string[]
  forgetSession(sessionId: string): void
}

export function createPreviewSiteGate(deps: PreviewSiteGateDeps, access?: PreviewSiteAccess): PreviewSiteGate {
  const sites = access ?? new PreviewSiteAccess(deps.store, deps.limit)
  const asking = new Map<string, Promise<SiteDecision>>()

  const ask = async (sessionId: string, url: string, origin: string): Promise<SiteDecision> => {
    let allowed = false
    try {
      allowed = await deps.confirm(origin, url)
    } catch {
      return 'deny'
    }
    return sites.record(sessionId, url, allowed)
  }

  return {
    ready: () => sites.ready(),
    peek(sessionId, url) {
      return sites.decide(sessionId, url).decision
    },
    async check(sessionId, url) {
      await sites.ready()
      const verdict = sites.decide(sessionId, url)
      if (verdict.decision !== 'ask' || !verdict.origin) return verdict.decision
      const key = `${sessionId}\u0000${verdict.origin}`
      const existing = asking.get(key)
      if (existing) return existing
      const pending = ask(sessionId, url, verdict.origin).finally(() => asking.delete(key))
      asking.set(key, pending)
      return pending
    },
    sites: () => sites.sites(),
    addSite: (value) => sites.add(value),
    removeSite: (value) => sites.remove(value),
    clearSites: () => sites.clear(),
    forgetSession(sessionId) {
      sites.forgetSession(sessionId)
    }
  }
}
