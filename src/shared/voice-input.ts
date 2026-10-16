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

const MB = 1024 * 1024

export const VOICE_MODELS: VoiceModelSpec[] = [
  { id: 'base', tier: 'light', file: 'ggml-base.bin', approxBytes: 148 * MB, approxMemoryMB: 400, minThreads: 2, minFreeMemoryMB: 1000 },
  { id: 'small', tier: 'balanced', file: 'ggml-small.bin', approxBytes: 488 * MB, approxMemoryMB: 900, minThreads: 4, minFreeMemoryMB: 2500 },
  {
    id: 'large-v3-turbo-q5_0',
    tier: 'quality',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    approxBytes: 574 * MB,
    approxMemoryMB: 1600,
    minThreads: 8,
    minFreeMemoryMB: 4000
  }
]

export const VOICE_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
export const WHISPER_RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'
export const WHISPER_RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20'
export const WHISPER_WINDOWS_ASSET = 'whisper-bin-x64.zip'

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

export function recommendVoiceModel(hw: VoiceHardware, installed: ReadonlySet<string> = new Set()): VoiceModelCandidate[] {
  const busyFactor = hw.cpuLoad !== null && hw.cpuLoad > 0.6 ? 0.5 : 1
  const effectiveThreads = Math.max(1, Math.floor(hw.threads * busyFactor))
  const fits = (spec: VoiceModelSpec): boolean =>
    effectiveThreads >= spec.minThreads && hw.freeMemoryMB >= spec.minFreeMemoryMB
  const best = [...VOICE_MODELS].reverse().find(fits) ?? VOICE_MODELS[0]
  return VOICE_MODELS.map((spec) => {
    const reasons: string[] = []
    if (effectiveThreads < spec.minThreads) reasons.push(`建议至少 ${spec.minThreads} 个可用 CPU 线程`)
    if (hw.freeMemoryMB < spec.minFreeMemoryMB) reasons.push(`建议至少 ${Math.round((spec.minFreeMemoryMB / 1024) * 10) / 10}GB 可用内存`)
    return {
      spec,
      recommended: spec.id === best.id,
      strain: reasons.length ? `${reasons.join('，')}；转写会比较慢` : null,
      installed: installed.has(spec.id)
    }
  })
}

export function voiceModelSpec(id: string): VoiceModelSpec | undefined {
  return VOICE_MODELS.find((spec) => spec.id === id)
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

export function parseWhisperOutput(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, '').trim())
    .filter((line) => line && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SOUND|音乐|静音)[^\]]*\]$/i.test(line) && !/^\((?:music|silence)\)$/i.test(line))
    .join('\n')
    .trim()
}

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
