import { dialog, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { VOICE_MAX_WAV_BYTES, type VoiceInputSettings, type VoiceInputStatus, type VoiceLanguage, type VoiceTranscribeResult } from '../../shared/voice-input'
import type { IpcRegistrar } from './registrar'

export const VOICE_PLUGIN = 'voice-input'
const MISSING = '语音输入插件未安装，请在「设置 → 插件」里安装'

export interface VoicePluginHost {
  installed(id: string): boolean
  inbox(id: string): string
  invoke(id: string, action: string, params?: unknown): Promise<unknown>
}

export interface VoiceIpcDeps {
  plugins: VoicePluginHost
  window: () => BrowserWindow | null
  settings: () => Promise<VoiceInputSettings | undefined>
  saveSettings: (next: VoiceInputSettings) => Promise<void>
}

export function voiceTranscriber(deps: Pick<VoiceIpcDeps, 'plugins' | 'settings'>): (wav: Uint8Array, language?: VoiceLanguage) => Promise<VoiceTranscribeResult> {
  return async (wav, language) => {
    if (!deps.plugins.installed(VOICE_PLUGIN)) return { ok: false, error: MISSING }
    if (!(wav instanceof Uint8Array) || wav.byteLength < 44) return { ok: false, error: '录音为空' }
    if (wav.byteLength > VOICE_MAX_WAV_BYTES) return { ok: false, error: '录音太长，请分段录制' }
    const inbox = deps.plugins.inbox(VOICE_PLUGIN)
    const path = join(inbox, `${randomUUID()}.wav`)
    try {
      await mkdir(inbox, { recursive: true })
      await writeFile(path, wav)
      return (await deps.plugins.invoke(VOICE_PLUGIN, 'transcribe', { path, language, settings: await deps.settings() })) as VoiceTranscribeResult
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined)
      return { ok: false, error: `转写失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

export function registerVoiceIpc(ipc: IpcRegistrar, deps: VoiceIpcDeps): void {
  const { handle } = ipc
  const installed = (): boolean => deps.plugins.installed(VOICE_PLUGIN)
  const call = async (action: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    deps.plugins.invoke(VOICE_PLUGIN, action, { ...params, settings: await deps.settings() })
  const status = async (): Promise<VoiceInputStatus | null> => (installed() ? ((await call('details')) as VoiceInputStatus) : null)
  const transcribe = voiceTranscriber(deps)

  handle('yan:voice:available', () => installed())
  handle('yan:voice:status', status)
  handle('yan:voice:prepare', async () => (installed() ? call('prepare') : { ok: false, error: MISSING }))
  handle('yan:voice:plan', (target: unknown) => {
    const raw = (target ?? {}) as { kind?: unknown; id?: unknown }
    if (raw.kind === 'binary') return call('plan', { target: { kind: 'binary' } })
    if (raw.kind === 'model' && typeof raw.id === 'string') return call('plan', { target: { kind: 'model', id: raw.id } })
    return { ok: false as const, error: '下载目标无效' }
  })
  handle('yan:voice:download', (planId: unknown) => call('download', { planId: String(planId ?? '') }))
  handle('yan:voice:cancel', async () => { await call('cancel') })
  handle('yan:voice:pick', async (kind: unknown) => {
    const win = deps.window()
    if (!win || (kind !== 'binary' && kind !== 'model')) return null
    const result = await dialog.showOpenDialog(win, {
      title: kind === 'binary' ? '选择 whisper-cli 程序' : '选择 whisper.cpp 模型文件（ggml-*.bin）',
      properties: ['openFile'],
      filters: kind === 'binary' ? [{ name: 'whisper-cli', extensions: ['exe'] }] : [{ name: 'ggml 模型', extensions: ['bin'] }]
    })
    const path = result.canceled ? undefined : result.filePaths[0]
    if (!path) return null
    const current = (await deps.settings()) ?? {}
    await deps.saveSettings(kind === 'binary' ? { ...current, binaryPath: path } : { ...current, model: { kind: 'file', path } })
    return status()
  })
  handle('yan:voice:transcribe', (wav: unknown, language: unknown) =>
    transcribe(wav instanceof Uint8Array ? wav : new Uint8Array(0), language as VoiceLanguage | undefined)
  )
}
