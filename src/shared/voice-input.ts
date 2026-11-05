export type VoiceModelTier = 'light' | 'balanced' | 'quality'

export interface VoiceModelSpec {
  id: string
  tier: VoiceModelTier
  file: string
  approxBytes: number
  approxMemoryMB: number
  minThreads: number
  minFreeMemoryMB: number
}

export type VoiceLanguage = 'auto' | 'zh' | 'en'
export const VOICE_LANGUAGES: VoiceLanguage[] = ['auto', 'zh', 'en']

export interface VoiceInputSettings {
  model?: { kind: 'catalog'; id: string } | { kind: 'file'; path: string }
  binaryPath?: string
  language?: VoiceLanguage
}

export interface VoiceHardware {
  cpuModel: string
  threads: number
  totalMemoryMB: number
  freeMemoryMB: number
  cpuLoad: number | null
  gpu: string | null
}

export interface VoiceModelCandidate {
  spec: VoiceModelSpec
  recommended: boolean
  strain: string | null
  installed: boolean
}

export interface VoiceDownloadPlan {
  planId: string
  target: { kind: 'model'; id: string } | { kind: 'binary' }
  label: string
  url: string
  bytes: number
  sizeKnown: boolean
  destination: string
}

export interface VoiceDownloadProgress {
  planId: string
  label: string
  received: number
  total: number
  state: 'running' | 'done' | 'failed' | 'cancelled'
  error?: string
}

export interface VoiceInputStatus {
  hardware: VoiceHardware
  candidates: VoiceModelCandidate[]
  binary: { path: string; source: 'managed' | 'custom' } | null
  backend?: 'cuda' | 'cpu' | 'unknown'
  model: { label: string; path: string; catalogId: string | null } | null
  language: VoiceLanguage
  ready: boolean
  storageDir: string
  download: VoiceDownloadProgress | null
}

export type VoiceTranscribeResult =
  | { ok: true; text: string; elapsedMs: number }
  | { ok: false; error: string }

export const VOICE_MAX_SECONDS = 180
export const VOICE_MAX_WAV_BYTES = VOICE_MAX_SECONDS * 16_000 * 2 + 1024

export function encodeWav16k(samples: Float32Array): Uint8Array {
  const sampleRate = 16_000
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}
