import { dialog, type BrowserWindow } from 'electron'
import type { VoiceInputSettings, VoiceLanguage } from '../../shared/voice-input'
import type { VoiceService } from '../voice/voice-service'
import type { IpcRegistrar } from './registrar'

export interface VoiceIpcDeps {
  service: VoiceService
  window: () => BrowserWindow | null
  settings: () => Promise<VoiceInputSettings | undefined>
  saveSettings: (next: VoiceInputSettings) => Promise<void>
}

export function registerVoiceIpc(ipc: IpcRegistrar, deps: VoiceIpcDeps): void {
  const { handle } = ipc
  const { service } = deps
  handle('yan:voice:status', () => service.status())
  handle('yan:voice:prepare', () => service.prepare())
  handle('yan:voice:plan', (target: unknown) => {
    const raw = (target ?? {}) as { kind?: unknown; id?: unknown }
    if (raw.kind === 'binary') return service.plan({ kind: 'binary' })
    if (raw.kind === 'model' && typeof raw.id === 'string') return service.plan({ kind: 'model', id: raw.id })
    return { ok: false as const, error: '下载目标无效' }
  })
  handle('yan:voice:download', (planId: unknown) => service.download(String(planId ?? '')))
  handle('yan:voice:cancel', () => service.cancel())
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
    return service.status()
  })
  handle('yan:voice:transcribe', (wav: unknown, language: unknown) =>
    service.transcribe(wav instanceof Uint8Array ? wav : new Uint8Array(0), language as VoiceLanguage | undefined)
  )
}
