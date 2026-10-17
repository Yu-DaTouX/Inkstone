import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { shell } from 'electron'
import { mergeAuthEntry } from './credentials'
import { openableAuthUrl } from './external-url'
import type { OAuthLoginEvent, OAuthLoginResult } from '../shared/ipc'

const MODULES: Record<string, { file: string; exportName: string }> = {
  anthropic: { file: 'anthropic.js', exportName: 'anthropicOAuth' },
  'github-copilot': { file: 'github-copilot.js', exportName: 'githubCopilotOAuth' },
  xai: { file: 'xai.js', exportName: 'xaiOAuth' },
  openrouter: { file: 'openrouter.js', exportName: 'openRouterOAuth' }
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
  pending: { id: number; resolve(value: string): void; reject(error: Error): void } | null
  seq: number
}

let running: Running | null = null

export async function startOAuthLogin(opts: {
  provider: string
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
          if (state.abort.signal.aborted || prompt.signal?.aborted) {
            reject(new Error('prompt cancelled'))
            return
          }
          const id = ++state.seq
          const onAbort = (): void => {
            state.pending?.id === id && state.pending.reject(new Error('prompt cancelled'))
            send({ provider, type: 'prompt_closed', promptId: id })
          }
          const timer = setTimeout(() => {
            if (state.pending?.id !== id) return
            state.pending.reject(new Error('prompt timed out'))
            send({ provider, type: 'prompt_closed', promptId: id })
          }, 10 * 60_000)
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
