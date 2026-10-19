import { PreviewSiteAccess, type SiteDecision } from './preview-site-access'

export interface PreviewSiteGateDeps {
  confirm(origin: string): Promise<boolean>
}

export interface PreviewSiteGate {
  check(sessionId: string, url: string): Promise<SiteDecision>
  forgetSession(sessionId: string): void
}

export function createPreviewSiteGate(deps: PreviewSiteGateDeps, access = new PreviewSiteAccess()): PreviewSiteGate {
  const asking = new Map<string, Promise<SiteDecision>>()

  const ask = async (sessionId: string, url: string, origin: string): Promise<SiteDecision> => {
    let allowed = false
    try {
      allowed = await deps.confirm(origin)
    } catch {
      return 'deny'
    }
    return access.record(sessionId, url, allowed)
  }

  return {
    async check(sessionId, url) {
      const verdict = access.decide(sessionId, url)
      if (verdict.decision !== 'ask' || !verdict.origin) return verdict.decision
      const key = `${sessionId}\u0000${verdict.origin}`
      const existing = asking.get(key)
      if (existing) return existing
      const pending = ask(sessionId, url, verdict.origin).finally(() => asking.delete(key))
      asking.set(key, pending)
      return pending
    },
    forgetSession(sessionId) {
      access.forgetSession(sessionId)
    }
  }
}
