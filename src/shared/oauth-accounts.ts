export const OAUTH_ACCOUNT_PROVIDERS = ['anthropic', 'github-copilot', 'xai', 'openrouter'] as const

export type OAuthAccountProvider = typeof OAUTH_ACCOUNT_PROVIDERS[number]

export interface OAuthAccountView {
  key: string
  email?: string
  label?: string
  active: boolean
}

export type OAuthAccountPools = Partial<Record<OAuthAccountProvider, OAuthAccountView[]>>

export function supportsOAuthAccounts(provider: string): provider is OAuthAccountProvider {
  return (OAUTH_ACCOUNT_PROVIDERS as readonly string[]).includes(provider)
}
