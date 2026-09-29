/**
 * 电脑本地语音输入（需求稿 3.5）：契约与纯逻辑。
 *
 * 首版只做「录音 → 本地转写 → 填进输入框 → 用户编辑后发送」，与文字走同一条发送路径。
 * 引擎是 whisper.cpp（命令行 whisper-cli + ggml 模型文件），全部在这台电脑上运行，录音不上传。
 *
 * ── 边界 ──
 *  · 模型与程序都要用户**看过大小和保存位置、明确同意**后才下载；也可以指定已有的文件。
 *  · 推荐只是建议：按 CPU 线程、可用内存和当前负载给出轻量 / 均衡 / 高质量三档，用户可手动选。
 *  · 录音只在转写期间以临时文件存在，转写结束即删除，不保留录音。
 *  · Windows NVIDIA 设备优先选择官方 CUDA 包；录音按短段转写，支持本地驻留服务。
 *
 * 不碰 electron / 文件系统，主进程、渲染端与单测共用。
 */

export type VoiceModelTier = 'light' | 'balanced' | 'quality'

export interface VoiceModelSpec {
  id: string
  tier: VoiceModelTier
  /** 下载到本地的文件名，也是 Hugging Face 仓库里的文件名 */
  file: string
  /** 目录里的估计大小；下载前会再向服务器核实实际大小 */
  approxBytes: number
  /** 转写时大致的内存占用 */
  approxMemoryMB: number
  /** 推荐它的最低条件（CPU 线程数、可用内存） */
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
/** whisper.cpp 官方发布页（CPU 版 Windows 程序从这里取最新一版） */
export const WHISPER_RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'
export const WHISPER_RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20'
export const WHISPER_WINDOWS_ASSET = 'whisper-bin-x64.zip'

export type VoiceLanguage = 'auto' | 'zh' | 'en'
export const VOICE_LANGUAGES: VoiceLanguage[] = ['auto', 'zh', 'en']

/** 设置里保存的部分（`undefined` = 没配置过） */
export interface VoiceInputSettings {
  /** 选用的模型：内置目录的 id，或用户指定的已有模型文件（绝对路径） */
  model?: { kind: 'catalog'; id: string } | { kind: 'file'; path: string }
  /** 用户指定的已有 whisper-cli 程序；不设则用砚下载管理的那一份 */
  binaryPath?: string
  language?: VoiceLanguage
}

export interface VoiceHardware {
  cpuModel: string
  threads: number
  totalMemoryMB: number
  freeMemoryMB: number
  /** 最近一小段时间的 CPU 占用（0–1），取不到时为 null */
  cpuLoad: number | null
  /** 显卡名称；后端是否启用以运行日志为准 */
  gpu: string | null
}

export interface VoiceModelCandidate {
  spec: VoiceModelSpec
  recommended: boolean
  /** 这台电脑跑它是否吃力（给出原因，不隐藏选项） */
  strain: string | null
  installed: boolean
}

/**
 * 按配置推荐一档模型。
 * 负载高时按「实际可用的线程」估算 —— 推荐要反映现在用起来的感受，而不是纸面配置。
 */
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

/** 下载目标：用户确认前由宿主核实的真实大小与保存位置 */
export interface VoiceDownloadPlan {
  planId: string
  target: { kind: 'model'; id: string } | { kind: 'binary' }
  label: string
  url: string
  /** 服务器报告的大小；拿不到时为估计值，并由 sizeKnown 标明 */
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
  /** 当前可用的程序：砚管理的一份、用户指定的一份，或没有 */
  binary: { path: string; source: 'managed' | 'custom' } | null
  /** 最近实际转写确认的后端；未执行前保持 unknown。 */
  backend?: 'cuda' | 'cpu' | 'unknown'
  /** 当前选用且文件确实存在的模型 */
  model: { label: string; path: string; catalogId: string | null } | null
  language: VoiceLanguage
  /** 程序与模型都就绪才能录音转写 */
  ready: boolean
  /** 砚管理的文件放在哪里（展示给用户） */
  storageDir: string
  download: VoiceDownloadProgress | null
}

export type VoiceTranscribeResult =
  | { ok: true; text: string; elapsedMs: number }
  | { ok: false; error: string }

/** 单次录音上限：whisper 按整段转写，太长既慢又占内存 */
export const VOICE_MAX_SECONDS = 180
/** 16kHz 单声道 16 位 PCM 的 WAV 上限（含文件头余量） */
export const VOICE_MAX_WAV_BYTES = VOICE_MAX_SECONDS * 16_000 * 2 + 1024

/**
 * 从 whisper-cli 的标准输出取正文：去掉时间戳行首、空白与 `[BLANK_AUDIO]` 一类标记。
 * 用了 `-nt`（不打时间戳）时每段一行；没用时也能兼容。
 */
export function parseWhisperOutput(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, '').trim())
    .filter((line) => line && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SOUND|音乐|静音)[^\]]*\]$/i.test(line) && !/^\((?:music|silence)\)$/i.test(line))
    .join('\n')
    .trim()
}

/** 把 16kHz 单声道 Float32 采样编码成 16 位 PCM WAV（渲染端录音后调用） */
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
