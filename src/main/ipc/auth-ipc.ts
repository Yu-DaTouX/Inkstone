import type { IpcRegistrar } from './registrar'
import { getSettings } from '../settings'
import { resolvePi } from '../protocol'
import type { CustomProviderInput } from '../../shared/custom-provider'
import { discoverCustomProviderModels, listCustomProviders, removeCustomProvider, saveCustomProvider, testCustomProviderBillable, testCustomProviderEndpoint } from '../custom-providers'
import { authFileInfo, clearAuth, listAuthProviders, setApiKey } from '../credentials'
import { addApiKey, clearApiKeys, listApiKeyPools, removeApiKey, renameApiKey, switchApiKey } from '../api-key-pool'
import { detectToolchain } from '../toolchain'
import { detectLocalModelServers } from '../local-models'
import { cancelCodexLogin, startCodexLogin } from '../oauth'
import { answerOAuthPrompt, cancelOAuthLogin, startOAuthLogin } from '../oauth-providers'
import type { OAuthLoginEvent } from '../../shared/ipc'
import { accountQuotaReport } from '../account-quota'
import { captureActiveCodexAccount, switchCodexAccount } from '../codex-accounts'

export interface AuthIpcDeps {
  restartAgent(reason: string): Promise<void>
  sendOAuthEvent(event: OAuthLoginEvent): void
}

export function registerAuthIpc(ipc: IpcRegistrar, deps: AuthIpcDeps): void {
  const { handle } = ipc
  const { restartAgent, sendOAuthEvent } = deps
  handle('yan:authProviders', async (deep?: boolean) => {
    const s = await getSettings()
    const probe = resolvePi({ override: s.piBin })
    return listAuthProviders({ cmd: probe.cmd, args: probe.args }, !!deep)
  })
  handle('yan:setApiKey', async (provider: string, key: string) => {
    const r = await setApiKey(provider, key)
    if (r.ok) void restartAgent('API key 已更新').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
    return r
  })
  handle('yan:clearAuth', async (provider: string) => {
    const r = await clearAuth(provider)
    if (r.ok) {
      await clearApiKeys(String(provider ?? ''))
      void restartAgent('凭证已清除').catch((error) => console.error('[auth] 凭证清除后刷新失败', error))
    }
    return r
  })
  handle('yan:apiKeys', async () => listApiKeyPools())
  handle('yan:addApiKey', async (provider: unknown, key: unknown, label?: unknown) => {
    const r = await addApiKey(String(provider ?? ''), String(key ?? ''), typeof label === 'string' ? label : undefined)
    if (r.ok) void restartAgent('API key 已更新').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
    return r
  })
  handle('yan:switchApiKey', async (provider: unknown, id: unknown) => {
    const r = await switchApiKey(String(provider ?? ''), String(id ?? ''))
    if (r.ok) void restartAgent('API key 已切换').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
    return r
  })
  handle('yan:renameApiKey', async (provider: unknown, id: unknown, label: unknown) => renameApiKey(String(provider ?? ''), String(id ?? ''), String(label ?? '')))
  handle('yan:removeApiKey', async (provider: unknown, id: unknown) => removeApiKey(String(provider ?? ''), String(id ?? '')))
  handle('yan:authFileInfo', async () => authFileInfo())
  handle('yan:toolchainStatus', async () => detectToolchain())
  handle('yan:customProviders', async () => listCustomProviders())
  handle('yan:saveCustomProvider', async (input: CustomProviderInput) => {
    const r = await saveCustomProvider(input)
    if (r.ok) void restartAgent('自定义服务已更新').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
    return r
  })
  handle('yan:discoverCustomModels', async (input: Partial<CustomProviderInput>) => discoverCustomProviderModels(input))
  handle('yan:detectLocalModels', async () => detectLocalModelServers())
  handle('yan:removeCustomProvider', async (id: string) => {
    const r = await removeCustomProvider(id)
    if (r.ok) void restartAgent('自定义服务已移除').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
    return r
  })
  handle('yan:testCustomProvider', async (id: string, mode: 'endpoint' | 'billable', modelId?: string) => {
    if (mode === 'endpoint') return await testCustomProviderEndpoint(id)
    const current = await getSettings()
    const probe = resolvePi(current.piBin ? { override: current.piBin } : {})
    return await testCustomProviderBillable({ id, modelId: modelId ?? '', piBin: probe.args.at(-1) ?? '' })
  })

  handle('yan:codexLogin', async () => {
    try {
      await captureActiveCodexAccount()
    } catch (error) {
      return { ok: false, error: `无法安全保存当前 ChatGPT 账号，已取消登录：${error instanceof Error ? error.message : String(error)}` }
    }
    const r = await startCodexLogin()
    if (r.ok) {
      await captureActiveCodexAccount().catch(() => undefined)
      void restartAgent('ChatGPT 登录').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
    }
    return r
  })
  handle('yan:codexLoginCancel', async () => {
    cancelCodexLogin()
  })

  handle('yan:oauthLogin', async (provider: string) => {
    const s = await getSettings()
    const probe = resolvePi({ override: s.piBin })
    const r = await startOAuthLogin({ provider: String(provider ?? ''), piEntry: probe.args.at(-1) ?? '', send: sendOAuthEvent })
    if (r.ok) void restartAgent('订阅登录').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
    return r
  })
  handle('yan:oauthLoginAnswer', async (provider: string, promptId: number, value: string) =>
    answerOAuthPrompt(String(provider ?? ''), Number(promptId), String(value ?? ''))
  )
  handle('yan:oauthLoginCancel', async (provider: string) => {
    cancelOAuthLogin(String(provider ?? '') || undefined)
  })

  handle('yan:accountQuota', async () => accountQuotaReport())
  handle('yan:codexAccountSwitch', async (key: unknown) => {
    return switchCodexAccount(String(key ?? ''))
  })
}
