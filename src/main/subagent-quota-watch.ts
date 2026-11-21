import { supportsOAuthAccounts } from '../shared/oauth-accounts'
import { buildSubagentQuotaNotice } from '../shared/subagent-notice'
import { subagentQuotaProvider, type SubagentRun } from '../shared/subagent-run'
import { listCodexAccounts } from './codex-accounts'
import { oauthAccountTargets } from './oauth-accounts'
import { providerQuota } from './quota'
import type { SpareAccountOptions } from './account-autoswitch'
import type { SubagentQuotaWatch } from './subagents'

export interface SubagentQuotaWatchDeps {
  notifyParent(run: SubagentRun, text: string): void
  activeAccount?(provider: string): Promise<string | undefined>
  switchAccount?(provider: string, options: SpareAccountOptions): Promise<{ label: string; switched: boolean } | null>
}

async function accountCount(provider: string): Promise<number> {
  try {
    if (provider === 'openai-codex') return Math.max(1, (await listCodexAccounts()).length)
    if (supportsOAuthAccounts(provider)) return Math.max(1, (await oauthAccountTargets(provider)).length)
  } catch {
  }
  return 1
}

export function createSubagentQuotaWatch(deps: SubagentQuotaWatchDeps): SubagentQuotaWatch {
  return {
    activeAccount: deps.activeAccount,
    ...(deps.switchAccount ? {
      async switchAccount(run, failedKey) {
        const provider = subagentQuotaProvider(run.model)
        if (!provider) return null
        const result = await deps.switchAccount!(provider, { quotaExhausted: true, failedKey }).catch(() => null)
        return result?.label ?? null
      }
    } : {}),
    async check(model) {
      const provider = subagentQuotaProvider(model)
      if (!provider) return null
      const [quota, accounts] = await Promise.all([providerQuota(provider).catch(() => null), accountCount(provider)])
      const windows = quota?.windows ?? []
      return windows.length || accounts > 1 ? { windows, accounts } : null
    },
    waiting(run) {
      deps.notifyParent(run, buildSubagentQuotaNotice(run))
    }
  }
}
