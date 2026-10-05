/**
 * 应用内订阅登录（Claude Pro/Max、GitHub Copilot、xAI、OpenRouter）。
 *
 * 不自己抄各家的 OAuth 参数：直接加载随包 pi 里的登录模块（`chunks/<provider>.js`，
 * pi 自己的 `/login` 也是加载这几个文件），由宿主实现它要的交互接口：
 *   · notify(auth_url)    → 用系统浏览器打开授权页，同时把地址给界面（打不开时可手动复制）
 *   · notify(device_code) → 界面显示验证码与验证地址
 *   · notify(progress)    → 界面显示进度
 *   · prompt(manual_code / text / select) → 界面弹输入框或选项，等用户回答
 * 登录模块返回的凭证原样合并进 pi 的 auth.json（与 `/login` 写入的形状一致），
 * 调用方随后重启 pi 让它重新读凭证。
 *
 * ChatGPT（Codex）仍走 src/main/oauth.ts 的既有流程，界面入口不变。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { shell } from 'electron'
import { mergeAuthEntry } from './credentials'
import { openableAuthUrl } from './external-url'
import type { OAuthLoginEvent, OAuthLoginResult } from '../shared/ipc'

/** 界面上的 provider id → pi 登录模块的文件名与导出名（auth.json 的键与 id 相同） */
const MODULES: Record<string, { file: string; exportName: string }> = {
  anthropic: { file: 'anthropic.js', exportName: 'anthropicOAuth' },
  'github-copilot': { file: 'github-copilot.js', exportName: 'githubCopilotOAuth' },
  xai: { file: 'xai.js', exportName: 'xaiOAuth' },
  openrouter: { file: 'openrouter.js', exportName: 'openRouterOAuth' }
}

export function supportsInAppOAuth(provider: string): boolean {
  return provider in MODULES
}

interface PiOAuthPrompt {
  type: 'manual_code' | 'text' | 'select'
  message?: string
  placeholder?: string
  options?: { id: string; label: string }[]
  signal?: AbortSignal
}

interface PiOAuthModule {
  login(interaction: {
    signal: AbortSignal
    notify(event: Record<string, unknown>): void
    prompt(prompt: PiOAuthPrompt): Promise<string>
  }): Promise<Record<string, unknown>>
}

interface Running {
  provider: string
  abort: AbortController
  /** 正在等界面回答的那个提问 */
  pending: { id: number; resolve(value: string): void; reject(error: Error): void } | null
  seq: number
}

let running: Running | null = null

export async function startOAuthLogin(opts: {
  provider: string
  /** pi 入口脚本的绝对路径（登录模块在它旁边的 chunks/ 里） */
  piEntry: string
  send(event: OAuthLoginEvent): void
}): Promise<OAuthLoginResult> {
  const { provider, send } = opts
  const spec = MODULES[provider]
  if (!spec) return { ok: false, error: '这个服务还不支持在应用内登录' }
  if (running) return { ok: false, error: '已有一个登录正在进行，请先完成或取消它' }

  const file = join(dirname(opts.piEntry), 'chunks', spec.file)
  if (!existsSync(file)) {
    return { ok: false, error: '当前 pi 版本里找不到这个服务的登录模块；可以在终端运行 pi，再输入 /login' }
  }
  let mod: PiOAuthModule | undefined
  try {
    const loaded = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    mod = loaded[spec.exportName] as PiOAuthModule | undefined
  } catch (error) {
    return { ok: false, error: `加载登录模块失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!mod || typeof mod.login !== 'function') {
    return { ok: false, error: '当前 pi 版本的登录模块接口已变化；可以在终端运行 pi，再输入 /login' }
  }

  const state: Running = { provider, abort: new AbortController(), pending: null, seq: 0 }
  running = state
  try {
    const credential = await mod.login({
      signal: state.abort.signal,
      notify(event) {
        const type = String(event.type ?? '')
        const authUrl = type === 'auth_url' ? openableAuthUrl(event.url) : null
        if (authUrl) {
          void shell.openExternal(authUrl).catch(() => undefined)
          send({ provider, type: 'auth_url', url: authUrl, message: typeof event.instructions === 'string' ? event.instructions : undefined })
        } else if (type === 'device_code') {
          send({
            provider,
            type: 'device_code',
            userCode: String(event.userCode ?? ''),
            url: String(event.verificationUri ?? ''),
            expiresInSeconds: typeof event.expiresInSeconds === 'number' ? event.expiresInSeconds : undefined
          })
        } else if (type === 'progress') {
          send({ provider, type: 'progress', message: String(event.message ?? '') })
        }
      },
      prompt(prompt) {
        return new Promise<string>((resolve, reject) => {
          /* 取消发生在两次提问之间时 signal 已是 aborted，监听不会再触发，必须当场结束 */
          if (state.abort.signal.aborted || prompt.signal?.aborted) {
            reject(new Error('prompt cancelled'))
            return
          }
          const id = ++state.seq
          /* 回调服务先收到授权码时，登录模块会用 signal 撤掉这个提问 */
          const onAbort = (): void => {
            state.pending?.id === id && state.pending.reject(new Error('prompt cancelled'))
            send({ provider, type: 'prompt_closed', promptId: id })
          }
          /* 界面一直不回答也不能永久等待 */
          const timer = setTimeout(() => state.pending?.id === id && state.pending.reject(new Error('prompt timed out')), 10 * 60_000)
          const settle = (): void => {
            clearTimeout(timer)
            prompt.signal?.removeEventListener('abort', onAbort)
            state.abort.signal.removeEventListener('abort', onAbort)
            if (state.pending?.id === id) state.pending = null
          }
          state.pending = {
            id,
            resolve: (v) => {
              settle()
              resolve(v)
            },
            reject: (e) => {
              settle()
              reject(e)
            }
          }
          prompt.signal?.addEventListener('abort', onAbort, { once: true })
          state.abort.signal.addEventListener('abort', onAbort, { once: true })
          send({
            provider,
            type: 'prompt',
            promptId: id,
            kind: prompt.type,
            message: prompt.message ?? '',
            placeholder: prompt.placeholder,
            options: prompt.options
          })
        })
      }
    })
    const saved = await mergeAuthEntry(provider, { type: 'oauth', ...credential })
    if (!saved.ok) return { ok: false, error: `登录成功，但写入凭证失败：${saved.error ?? ''}` }
    send({ provider, type: 'done' })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = state.abort.signal.aborted
    send({ provider, type: 'done' })
    return { ok: false, cancelled, error: cancelled ? '已取消登录' : `登录失败：${message}` }
  } finally {
    if (running === state) running = null
  }
}

/** 界面回答一个提问（粘贴的回调地址、企业域名、选项 id） */
export function answerOAuthPrompt(provider: string, promptId: number, value: string): boolean {
  const p = running?.provider === provider ? running.pending : null
  if (!p || p.id !== promptId) return false
  p.resolve(String(value ?? ''))
  return true
}

export function cancelOAuthLogin(provider?: string): void {
  if (!running || (provider && running.provider !== provider)) return
  running.abort.abort()
  running.pending?.reject(new Error('cancelled'))
}
