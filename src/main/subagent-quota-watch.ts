import type { SubagentRun } from '../shared/ipc'
import { supportsOAuthAccounts } from '../shared/oauth-accounts'
import { buildSubagentQuotaNotice } from '../shared/subagent-notice'
import { codexAccountTargets } from './codex-accounts'
import { oauthAccountTargets } from './oauth-accounts'
import { providerQuotaWithFallback } from './quota'
import type { SubagentQuotaWatch } from './subagents'

export interface SubagentQuotaWatchDeps {
  notifyUser(input: { run: SubagentRun; title: string; body: string }): void
  notifyParent(run: SubagentRun, text: string): void
}

async function accountCount(provider: string): Promise<number> {
  try {
    if (provider === 'openai-codex') return Math.max(1, (await codexAccountTargets()).length)
    if (supportsOAuthAccounts(provider)) return Math.max(1, (await oauthAccountTargets(provider)).length)
  } catch {
  }
  return 1
}

function subagentName(run: SubagentRun): string {
  const name = (run.brief?.title || run.followUp || run.task).replace(/\s+/g, ' ').trim()
  return name.length > 40 ? `${name.slice(0, 40)}…` : name
}

export function createSubagentQuotaWatch(deps: SubagentQuotaWatchDeps): SubagentQuotaWatch {
  return {
    async check(model) {
      const provider = model.slice(0, Math.max(0, model.indexOf('/'))).trim().toLowerCase()
      if (!provider) return null
      const [quota, accounts] = await Promise.all([providerQuotaWithFallback(provider), accountCount(provider)])
      if (!quota.windows?.length || quota.staleError) return null
      return { windows: quota.windows, accounts }
    },
    waiting(run) {
      const accounts = run.quotaWait?.accounts ?? 1
      const name = subagentName(run)
      if (accounts > 1) {
        deps.notifyUser({ run, title: '子代理撞上额度上限，可以换号', body: `「${name}」用的账号额度用完了。在额度页换一个账号后它会自动继续；不换就等额度恢复。` })
        return
      }
      deps.notifyUser({ run, title: '子代理在等额度', body: `「${name}」的额度用完了，额度恢复后会自动继续。` })
      deps.notifyParent(run, buildSubagentQuotaNotice(run))
    }
  }
}
