import { pick } from '../../shared/ui-lang'
import { existsSync } from 'node:fs'
import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import type { IpcRegistrar } from './registrar'
import { getSettings } from '../settings'
import { resolvePi } from '../protocol'
import type { CustomProviderInput } from '../../shared/custom-provider'
import { discoverCustomProviderModels, listCustomProviders, removeCustomProvider, saveCustomProvider, testCustomProviderBillable, testCustomProviderEndpoint } from '../custom-providers'
import { authFileInfo, clearAuth, listAuthProviders } from '../credentials'
import { addApiKey, captureActiveApiKey, clearApiKeys, listApiKeyPools, removeApiKey, renameApiKey, switchApiKey } from '../api-key-pool'
import { detectToolchain } from '../toolchain'
import { detectLocalModelServers } from '../local-models'
import { detectLocalLauncher, listLocalLaunchers, renameLocalModel, saveLocalLauncher } from '../local-model-launch'
import { cancelCodexLogin, startCodexLogin } from '../oauth'
import { answerOAuthPrompt, cancelOAuthLogin, startOAuthLogin } from '../oauth-providers'
import type { OAuthLoginEvent } from '../../shared/ipc'
import { accountQuotaReport, consumeResetCredit, invalidateAccountQuotaReport } from '../account-quota'
import { captureActiveCodexAccount, clearCodexAccounts, listCodexAccounts, removeCodexAccount, switchCodexAccount } from '../codex-accounts'
import { captureActiveOAuthAccount, clearOAuthAccounts, listOAuthAccounts, removeOAuthAccount, renameOAuthAccount, switchOAuthAccount } from '../oauth-accounts'
import { supportsOAuthAccounts } from '../../shared/oauth-accounts'

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
  const saveKey = async (provider: string, key: string, label?: string): Promise<{ ok: boolean; error?: string }> => {
    const saved = await captureActiveOAuthAccount(provider)
    const r = await addApiKey(provider, key, label, saved?.credential)
    if (r.ok) {
      invalidateAccountQuotaReport()
      void restartAgent('API key 已更新').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
    }
    return r
  }
  handle('yan:setApiKey', saveKey)
  handle('yan:clearAuth', async (provider: string) => {
    const r = provider === 'openai-codex' ? await clearCodexAccounts()
      : supportsOAuthAccounts(provider) ? await clearOAuthAccounts(provider) : await clearAuth(provider)
    if (r.ok) {
      invalidateAccountQuotaReport()
      const keys = provider !== 'openai-codex' ? await clearApiKeys(String(provider ?? '')) : { ok: true }
      void restartAgent('凭证已清除').catch((error) => console.error('[auth] 凭证清除后刷新失败', error))
      if (!keys.ok) return keys
    }
    return r
  })
  handle('yan:apiKeys', async () => listApiKeyPools())
  handle('yan:addApiKey', async (provider: unknown, key: unknown, label?: unknown) =>
    saveKey(String(provider ?? ''), String(key ?? ''), typeof label === 'string' ? label : undefined)
  )
  handle('yan:switchApiKey', async (provider: unknown, id: unknown) => {
    const saved = await captureActiveOAuthAccount(String(provider ?? ''))
    const r = await switchApiKey(String(provider ?? ''), String(id ?? ''), saved?.credential)
    if (r.ok) {
      invalidateAccountQuotaReport()
      void restartAgent('API key 已切换').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
    }
    return r
  })
  handle('yan:renameApiKey', async (provider: unknown, id: unknown, label: unknown) => renameApiKey(String(provider ?? ''), String(id ?? ''), String(label ?? '')))
  handle('yan:removeApiKey', async (provider: unknown, id: unknown) => {
    const r = await removeApiKey(String(provider ?? ''), String(id ?? ''))
    if (r.ok) {
      invalidateAccountQuotaReport()
      if (r.wasActive) void restartAgent('API key 已移除').catch((error) => console.error('[auth] 移除 key 后刷新失败', error))
    }
    return r
  })
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
  handle('yan:localLaunchers', async () => listLocalLaunchers())
  handle('yan:saveLocalLauncher', async (provider: string, command: string) => saveLocalLauncher(String(provider ?? ''), String(command ?? '')))
  handle('yan:renameLocalModel', async (provider: string, modelId: string, name: string) => {
    const next = await renameLocalModel(String(provider ?? ''), String(modelId ?? ''), String(name ?? ''))
    void restartAgent('local model renamed').catch((error) => console.error('[auth] refresh after model rename failed', error))
    return next
  })
  handle('yan:pickLocalLauncher', async (current?: string) => {
    const bare = String(current ?? '').trim().replace(/^"(.*)"$/, '$1')
    const near = bare && existsSync(bare) ? bare : undefined
    const options: OpenDialogOptions = {
      title: pick('选择本地模型的启动脚本或程序', 'Choose the start script or program for the local model'),
      properties: ['openFile'],
      filters: [
        { name: pick('启动脚本或程序', 'Start scripts or programs'), extensions: ['bat', 'cmd', 'ps1', 'exe'] },
        { name: pick('所有文件', 'All files'), extensions: ['*'] }
      ],
      ...(near ? { defaultPath: near } : {})
    }
    const parent = BrowserWindow.getFocusedWindow()
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    return picked.canceled ? null : picked.filePaths[0] ?? null
  })
  handle('yan:detectLocalLauncher', async (provider: string) => detectLocalLauncher(String(provider ?? '')))
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
      return { ok: false, error: pick(`无法安全保存当前 ChatGPT 账号，已取消登录：${error instanceof Error ? error.message : String(error)}`, `Could not safely save the current ChatGPT account; sign-in canceled: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const r = await startCodexLogin()
    if (r.ok) {
      invalidateAccountQuotaReport()
      void restartAgent('ChatGPT 登录').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
      try {
        await captureActiveCodexAccount()
      } catch (error) {
        return { ok: false, error: pick(`ChatGPT 已登录，但保存账号列表失败：${error instanceof Error ? error.message : String(error)}`, `Signed in to ChatGPT, but saving the account list failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    return r
  })
  handle('yan:codexLoginCancel', async () => {
    cancelCodexLogin()
  })

  handle('yan:oauthLogin', async (provider: string) => {
    if (!supportsOAuthAccounts(provider)) return { ok: false, error: pick('这个服务不支持应用内登录', 'This service does not support in-app sign-in') }
    try {
      const savedKey = await captureActiveApiKey(provider)
      if (!savedKey.ok) return savedKey
      await captureActiveOAuthAccount(provider)
    } catch (error) {
      return { ok: false, error: pick(`无法安全保存当前凭证，已取消登录：${error instanceof Error ? error.message : String(error)}`, `Could not safely save the current credentials; sign-in canceled: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const s = await getSettings()
    const probe = resolvePi({ override: s.piBin })
    const r = await startOAuthLogin({ provider, piEntry: probe.args.at(-1) ?? '', send: sendOAuthEvent })
    if (r.ok) {
      invalidateAccountQuotaReport()
      void restartAgent('订阅登录').catch((error) => console.error('[auth] 凭证更新后刷新失败', error))
      try {
        await captureActiveOAuthAccount(provider)
      } catch (error) {
        return { ok: false, error: pick(`已登录，但保存账号列表失败：${error instanceof Error ? error.message : String(error)}`, `Signed in, but saving the account list failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    return r
  })
  handle('yan:oauthLoginAnswer', async (provider: string, promptId: number, value: string) =>
    answerOAuthPrompt(String(provider ?? ''), Number(promptId), String(value ?? ''))
  )
  handle('yan:oauthLoginCancel', async (provider: string) => {
    cancelOAuthLogin(String(provider ?? '') || undefined)
  })

  handle('yan:oauthAccounts', async () => listOAuthAccounts())
  handle('yan:oauthAccountSwitch', async (provider: string, key: string) => {
    if (!supportsOAuthAccounts(provider)) return { ok: false, error: pick('这个服务不支持订阅账号管理', 'This service does not support subscription account management') }
    const saved = await captureActiveApiKey(provider)
    if (!saved.ok) return saved
    const r = await switchOAuthAccount(provider, key)
    if (r.ok) {
      invalidateAccountQuotaReport()
      void restartAgent('订阅账号已切换').catch((error) => console.error('[auth] 换号后刷新失败', error))
    }
    return r
  })
  handle('yan:oauthAccountRemove', async (provider: string, key: string) => {
    const r = await removeOAuthAccount(provider, key)
    if (r.ok) {
      invalidateAccountQuotaReport()
      if (r.wasActive) void restartAgent('订阅账号已移除').catch((error) => console.error('[auth] 移除账号后刷新失败', error))
    }
    return r
  })
  handle('yan:oauthAccountRename', async (provider: string, key: string, label: string) => renameOAuthAccount(provider, key, label))

  handle('yan:accountQuota', async () => accountQuotaReport())
  handle('yan:accountResetCredit', async (provider: unknown, key: unknown, creditId: unknown) => consumeResetCredit(String(provider ?? ''), String(key ?? ''), String(creditId ?? '')))
  handle('yan:codexAccounts', async () => listCodexAccounts())
  handle('yan:codexAccountSwitch', async (key: unknown) => {
    const r = await switchCodexAccount(String(key ?? ''))
    if (r.ok) {
      invalidateAccountQuotaReport()
      void restartAgent('ChatGPT 账号已切换').catch((error) => console.error('[auth] 换号后刷新失败', error))
    }
    return r
  })
  handle('yan:codexAccountRemove', async (key: unknown) => {
    const r = await removeCodexAccount(String(key ?? ''))
    if (r.ok) {
      invalidateAccountQuotaReport()
      if (r.wasActive) void restartAgent('ChatGPT 账号已移除').catch((error) => console.error('[auth] 移除账号后刷新失败', error))
    }
    return r
  })
}
