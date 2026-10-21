import type { SiteDecision } from '../preview-site-access'

export type NavigationGuardOutcome = 'pass' | 'ask' | 'block'

export function decideNavigationGuard(agentLoading: boolean, siteVerdict: () => SiteDecision): NavigationGuardOutcome {
  if (agentLoading) return 'pass'
  const verdict = siteVerdict()
  if (verdict === 'allow') return 'pass'
  return verdict === 'ask' ? 'ask' : 'block'
}
