/**
 * 模型接入的 IPC 适配：凭证、自定义 API 服务与应用内 ChatGPT（Codex）登录。
 *
 * 自定义服务的真源是 pi 的 models.json，只写 yan- 前缀条目；登录成功后重启 pi 让它重新读 auth.json。
 */
import type { IpcRegistrar } from './registrar'
import { getSettings } from '../settings'
import { resolvePi } from '../protocol'
import type { CustomProviderInput } from '../../shared/custom-provider'
import { discoverCustomProviderModels, listCustomProviders, removeCustomProvider, saveCustomProvider, testCustomProviderBillable, testCustomProviderEndpoint } from '../custom-providers'
import { authFileInfo, clearAuth, listAuthProviders, setApiKey } from '../credentials'
import { detectToolchain } from '../toolchain'
import { cancelCodexLogin, startCodexLogin } from '../oauth'
import { answerOAuthPrompt, cancelOAuthLogin, startOAuthLogin } from '../oauth-providers'
import type { OAuthLoginEvent } from '../../shared/ipc'

export interface AuthIpcDeps {
  /** 登录成功后重启 pi（等当前回合结束，不阻塞返回） */
  restartAgent(reason: string): Promise<void>
  /** 订阅登录过程事件 → 设置页（通道 yan:oauth） */
  sendOAuthEvent(event: OAuthLoginEvent): void
}

export function registerAuthIpc(ipc: IpcRegistrar, deps: AuthIpcDeps): void {
  const { handle } = ipc
  const { restartAgent, sendOAuthEvent } = deps
  /* ---- 模型接入（凭证） ---- */
  handle('yan:authProviders', async (deep?: boolean) => {
    const s = await getSettings()
    const probe = resolvePi({ override: s.piBin })
    return listAuthProviders({ cmd: probe.cmd, args: probe.args }, !!deep)
  })
  /*
   * pi 只在启动时读 auth.json / models.json：写入 key 或自定义服务后必须重启它，
   * 模型列表才会带上新的 provider（渲染端在连接恢复 ready 时会自动重拉）。
   */
  handle('yan:setApiKey', async (provider: string, key: string) => {
    const r = await setApiKey(provider, key)
    if (r.ok) void restartAgent('API key 已更新')
    return r
  })
  handle('yan:clearAuth', async (provider: string) => {
    const r = await clearAuth(provider)
    if (r.ok) void restartAgent('凭证已清除')
    return r
  })
  handle('yan:authFileInfo', async () => authFileInfo())
  handle('yan:toolchainStatus', async () => detectToolchain())
  /* 实施-23：自定义 API 服务。真源是 pi 的 models.json，只写 yan- 前缀条目。 */
  handle('yan:customProviders', async () => listCustomProviders())
  handle('yan:saveCustomProvider', async (input: CustomProviderInput) => {
    const r = await saveCustomProvider(input)
    if (r.ok) void restartAgent('自定义服务已更新')
    return r
  })
  handle('yan:discoverCustomModels', async (input: Partial<CustomProviderInput>) => discoverCustomProviderModels(input))
  handle('yan:removeCustomProvider', async (id: string) => {
    const r = await removeCustomProvider(id)
    if (r.ok) void restartAgent('自定义服务已移除')
    return r
  })
  /*
   * 连接测试（实施-23 M2）：endpoint 段是宿主自己的 HTTP 检查；billable 段交给
   * pi 的 --print 模式真实跑一条提示词 —— 两者分开返回，界面才能分别标成本。
   */
  handle('yan:testCustomProvider', async (id: string, mode: 'endpoint' | 'billable', modelId?: string) => {
    if (mode === 'endpoint') return await testCustomProviderEndpoint(id)
    const current = await getSettings()
    const probe = resolvePi(current.piBin ? { override: current.piBin } : {})
    return await testCustomProviderBillable({ id, modelId: modelId ?? '', piBin: probe.args.at(-1) ?? '' })
  })

  /*
   * 应用内登录 ChatGPT 订阅（Codex）。
   *
   * 为什么登录后要重启 agent：pi 在**启动时**读 auth.json，正在跑的那个子进程
   * 不会因为文件变了就重新读。不重启的话用户会看到「登录成功但模型还是旧的 /
   * 依然报没凭证」—— 这与语言切换需要重启是同一个原因，所以复用那条路。
   *
   * 重启是**非阻塞**的（fire and forget）：登录结果要立刻回给界面，而重启要等
   * 当前这一轮跑完（见 restartAgent 里的空闲等待），不能让设置页转圈等它。
   */
  handle('yan:codexLogin', async () => {
    const r = await startCodexLogin()
    if (r.ok) void restartAgent('ChatGPT 登录')
    return r
  })
  handle('yan:codexLoginCancel', async () => {
    cancelCodexLogin()
  })

  /*
   * 其余订阅（Claude Pro/Max、Copilot、xAI、OpenRouter）：驱动随包 pi 的登录模块，
   * 过程事件走 yan:oauth 推给设置页；成功后同样非阻塞地重启 pi。
   */
  handle('yan:oauthLogin', async (provider: string) => {
    const s = await getSettings()
    const probe = resolvePi({ override: s.piBin })
    const r = await startOAuthLogin({ provider: String(provider ?? ''), piEntry: probe.args.at(-1) ?? '', send: sendOAuthEvent })
    if (r.ok) void restartAgent('订阅登录')
    return r
  })
  handle('yan:oauthLoginAnswer', async (provider: string, promptId: number, value: string) =>
    answerOAuthPrompt(String(provider ?? ''), Number(promptId), String(value ?? ''))
  )
  handle('yan:oauthLoginCancel', async (provider: string) => {
    cancelOAuthLogin(String(provider ?? '') || undefined)
  })
}
