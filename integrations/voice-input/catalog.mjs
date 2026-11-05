const MB = 1024 * 1024
const VOICE_MODELS = [
  { id: 'base', tier: 'light', file: 'ggml-base.bin', approxBytes: 148 * MB, approxMemoryMB: 400, minThreads: 2, minFreeMemoryMB: 1_000 },
  { id: 'small', tier: 'balanced', file: 'ggml-small.bin', approxBytes: 488 * MB, approxMemoryMB: 900, minThreads: 4, minFreeMemoryMB: 2500 },
  {
    id: 'large-v3-turbo-q5_0',
    tier: 'quality',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    approxBytes: 574 * MB,
    approxMemoryMB: 1600,
    minThreads: 8,
    minFreeMemoryMB: 4_000
  }
]
const VOICE_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
const WHISPER_RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'
const WHISPER_RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20'
const WHISPER_WINDOWS_ASSET = 'whisper-bin-x64.zip'
function recommendVoiceModel(hw, installed = new Set()) {
  const busyFactor = hw.cpuLoad !== null && hw.cpuLoad > 0.6 ? 0.5 : 1
  const effectiveThreads = Math.max(1, Math.floor(hw.threads * busyFactor))
  const fits = (spec) => effectiveThreads >= spec.minThreads && hw.freeMemoryMB >= spec.minFreeMemoryMB
  const best = [...VOICE_MODELS].reverse().find(fits) ?? VOICE_MODELS[0]
  return VOICE_MODELS.map((spec) => {
    const reasons = []
    if (effectiveThreads < spec.minThreads) reasons.push(`建议至少 ${spec.minThreads} 个可用 CPU 线程`)
    if (hw.freeMemoryMB < spec.minFreeMemoryMB) reasons.push(`建议至少 ${Math.round(spec.minFreeMemoryMB / 1024 * 10) / 10}GB 可用内存`)
    return {
      spec,
      recommended: spec.id === best.id,
      strain: reasons.length ? `${reasons.join('，')}；转写会比较慢` : null,
      installed: installed.has(spec.id)
    }
  })
}
function voiceModelSpec(id) {
  return VOICE_MODELS.find((spec) => spec.id === id)
}
const VOICE_MAX_SECONDS = 180
const VOICE_MAX_WAV_BYTES = VOICE_MAX_SECONDS * 16_000 * 2 + 1024
function parseWhisperOutput(stdout) {
  return stdout.split(/\r?\n/).map((line) => line.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, '').trim()).filter((line) => line && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SOUND|音乐|静音)[^\]]*\]$/i.test(line) && !/^\((?:music|silence)\)$/i.test(line)).join("\n").trim()
}
export {
  VOICE_MAX_SECONDS,
  VOICE_MAX_WAV_BYTES,
  VOICE_MODELS,
  VOICE_MODEL_BASE_URL,
  WHISPER_RELEASES_API,
  WHISPER_RELEASE_API,
  WHISPER_WINDOWS_ASSET,
  parseWhisperOutput,
  recommendVoiceModel,
  voiceModelSpec
}
