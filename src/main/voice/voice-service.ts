/**
 * 电脑本地语音输入（需求稿 3.5）：硬件检测、模型推荐、征得同意后的下载、whisper.cpp 转写。
 *
 * ── 边界 ──
 *  · 下载分两步：`plan` 只向服务器核实大小并给出保存位置；用户在界面上确认后，
 *    才用这份 planId 调 `download`。没有 plan 的下载请求一律拒绝。
 *  · 下载走 Electron 的 net.fetch（Chromium 网络栈，跟随系统代理）。先写 `.part`，完整后再改名。
 *  · 程序只取官方发布的 CPU 版 zip 里的 exe / dll，放进砚自己的目录，不改系统 PATH。
 *  · 转写：录音以临时 WAV 写进系统临时目录，whisper-cli 读完即删；不保留录音。
 */
import { app, net } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, freemem, tmpdir, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import {
  VOICE_MAX_WAV_BYTES,
  VOICE_MODEL_BASE_URL,
  VOICE_MODELS,
  WHISPER_RELEASE_API,
  WHISPER_WINDOWS_ASSET,
  parseWhisperOutput,
  recommendVoiceModel,
  voiceModelSpec,
  type VoiceDownloadPlan,
  type VoiceDownloadProgress,
  type VoiceHardware,
  type VoiceInputSettings,
  type VoiceInputStatus,
  type VoiceLanguage,
  type VoiceTranscribeResult
} from '../../shared/voice-input'
import { ZipReader } from '../office/zip'
import { YAN_DIR } from '../paths'

const VOICE_DIR = join(YAN_DIR, 'voice')
const MODELS_DIR = join(VOICE_DIR, 'models')
const BIN_DIR = join(VOICE_DIR, 'bin')
const BINARY_NAMES = ['whisper-cli.exe', 'whisper-cli']
/** 程序 zip 的上限：官方 CPU 版只有几 MB，远超这个数说明拿错了东西 */
const MAX_BINARY_ZIP_BYTES = 200 * 1024 * 1024
/** plan 的有效期：确认框开太久就重新核实一次大小 */
const PLAN_TTL_MS = 30 * 60_000

interface PendingPlan {
  plan: VoiceDownloadPlan
  createdAt: number
}

export class VoiceService {
  private plans = new Map<string, PendingPlan>()
  private progress: VoiceDownloadProgress | null = null
  private abort: AbortController | null = null

  constructor(private readonly getSettings: () => Promise<VoiceInputSettings | undefined>) {}

  get storageDir(): string {
    return VOICE_DIR
  }

  async hardware(): Promise<VoiceHardware> {
    const list = cpus()
    const load = await sampleCpuLoad()
    let gpu: string | null = null
    try {
      const info = (await app.getGPUInfo('basic')) as { gpuDevice?: Array<{ active?: boolean; deviceString?: string; vendorId?: number }> }
      const device = info.gpuDevice?.find((item) => item.active) ?? info.gpuDevice?.[0]
      gpu = device?.deviceString ?? null
    } catch {
      gpu = null
    }
    return {
      cpuModel: list[0]?.model?.trim() ?? '',
      threads: list.length,
      totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
      freeMemoryMB: Math.round(freemem() / 1024 / 1024),
      cpuLoad: load,
      gpu
    }
  }

  private async installedModels(): Promise<Set<string>> {
    const out = new Set<string>()
    for (const spec of VOICE_MODELS) {
      if (await isFile(join(MODELS_DIR, spec.file))) out.add(spec.id)
    }
    return out
  }

  private async managedBinary(): Promise<string | null> {
    for (const name of BINARY_NAMES) {
      const path = join(BIN_DIR, name)
      if (await isFile(path)) return path
    }
    return null
  }

  private async resolveBinary(settings: VoiceInputSettings | undefined): Promise<VoiceInputStatus['binary']> {
    if (settings?.binaryPath && (await isFile(settings.binaryPath))) return { path: settings.binaryPath, source: 'custom' }
    const managed = await this.managedBinary()
    return managed ? { path: managed, source: 'managed' } : null
  }

  private async resolveModel(settings: VoiceInputSettings | undefined, installed: Set<string>): Promise<VoiceInputStatus['model']> {
    const chosen = settings?.model
    if (chosen?.kind === 'file') {
      return (await isFile(chosen.path)) ? { label: basename(chosen.path), path: chosen.path, catalogId: null } : null
    }
    /* 没选过时，用已下载里质量最高的一份 —— 已有可用模型就不催用户再下 */
    const id = chosen?.kind === 'catalog' && installed.has(chosen.id) ? chosen.id : [...VOICE_MODELS].reverse().find((spec) => installed.has(spec.id))?.id
    const spec = id ? voiceModelSpec(id) : undefined
    return spec ? { label: spec.id, path: join(MODELS_DIR, spec.file), catalogId: spec.id } : null
  }

  async status(): Promise<VoiceInputStatus> {
    const settings = await this.getSettings()
    const [hardware, installed] = await Promise.all([this.hardware(), this.installedModels()])
    const binary = await this.resolveBinary(settings)
    const model = await this.resolveModel(settings, installed)
    return {
      hardware,
      candidates: recommendVoiceModel(hardware, installed),
      binary,
      model,
      language: settings?.language ?? 'auto',
      ready: !!binary && !!model,
      storageDir: VOICE_DIR,
      download: this.progress
    }
  }

  /** 第一步：核实大小与保存位置，不下载任何内容 */
  async plan(target: VoiceDownloadPlan['target']): Promise<{ ok: true; plan: VoiceDownloadPlan } | { ok: false; error: string }> {
    try {
      let plan: VoiceDownloadPlan
      if (target.kind === 'model') {
        const spec = voiceModelSpec(target.id)
        if (!spec) return { ok: false, error: '未知的模型' }
        const url = `${VOICE_MODEL_BASE_URL}${spec.file}`
        const size = await headSize(url)
        plan = {
          planId: randomUUID(),
          target: { kind: 'model', id: spec.id },
          label: spec.file,
          url,
          bytes: size ?? spec.approxBytes,
          sizeKnown: size !== null,
          destination: join(MODELS_DIR, spec.file)
        }
      } else {
        const response = await net.fetch(WHISPER_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
        if (!response.ok) return { ok: false, error: `查询 whisper.cpp 发布版本失败（HTTP ${response.status}）` }
        const release = (await response.json()) as { tag_name?: string; assets?: Array<{ name: string; size: number; browser_download_url: string }> }
        const asset = release.assets?.find((item) => item.name === WHISPER_WINDOWS_ASSET)
        if (!asset) return { ok: false, error: `最新发布里没有 ${WHISPER_WINDOWS_ASSET}，请手动指定 whisper-cli 程序` }
        plan = {
          planId: randomUUID(),
          target: { kind: 'binary' },
          label: `whisper.cpp ${release.tag_name ?? ''} · ${asset.name}`.trim(),
          url: asset.browser_download_url,
          bytes: asset.size,
          sizeKnown: true,
          destination: BIN_DIR
        }
      }
      this.plans.set(plan.planId, { plan, createdAt: Date.now() })
      return { ok: true, plan }
    } catch (error) {
      return { ok: false, error: `无法连接下载服务器：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 第二步：用户已确认的 plan 才会真正下载；进度由 status() 读取 */
  async download(planId: string): Promise<{ ok: boolean; error?: string }> {
    const pending = this.plans.get(planId)
    if (!pending || Date.now() - pending.createdAt > PLAN_TTL_MS) return { ok: false, error: '下载确认已失效，请重新查看大小后再确认' }
    if (this.progress?.state === 'running') return { ok: false, error: '已有下载在进行' }
    this.plans.delete(planId)
    const { plan } = pending
    this.abort = new AbortController()
    this.progress = { planId, label: plan.label, received: 0, total: plan.bytes, state: 'running' }
    void this.runDownload(plan, this.abort.signal)
    return { ok: true }
  }

  cancel(): void {
    this.abort?.abort()
  }

  private async runDownload(plan: VoiceDownloadPlan, signal: AbortSignal): Promise<void> {
    const partDir = plan.target.kind === 'model' ? MODELS_DIR : VOICE_DIR
    const part = join(partDir, `${plan.target.kind === 'model' ? basename(plan.destination) : 'whisper-bin'}.part`)
    try {
      await mkdir(partDir, { recursive: true })
      const response = await net.fetch(plan.url, { signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || plan.bytes
      if (plan.target.kind === 'binary' && total > MAX_BINARY_ZIP_BYTES) throw new Error('程序包大小异常，已停止')
      if (this.progress) this.progress.total = total
      const out = createWriteStream(part)
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
          if (this.progress) this.progress.received += value.byteLength
        }
      } finally {
        await new Promise<void>((resolve) => out.end(() => resolve()))
      }
      if (this.progress && this.progress.received < total) throw new Error('下载不完整')

      if (plan.target.kind === 'model') {
        await rename(part, plan.destination)
      } else {
        await installBinaryZip(part)
        await rm(part, { force: true })
      }
      if (this.progress) this.progress.state = 'done'
    } catch (error) {
      await rm(part, { force: true }).catch(() => undefined)
      if (this.progress) {
        this.progress.state = signal.aborted ? 'cancelled' : 'failed'
        this.progress.error = signal.aborted ? undefined : error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.abort = null
    }
  }

  async transcribe(wav: Uint8Array, language?: VoiceLanguage): Promise<VoiceTranscribeResult> {
    if (!(wav instanceof Uint8Array) || wav.byteLength < 44) return { ok: false, error: '录音为空' }
    if (wav.byteLength > VOICE_MAX_WAV_BYTES) return { ok: false, error: '录音太长，请分段录制' }
    if (String.fromCharCode(...wav.subarray(0, 4)) !== 'RIFF') return { ok: false, error: '录音格式不对' }
    const settings = await this.getSettings()
    const binary = await this.resolveBinary(settings)
    const model = await this.resolveModel(settings, await this.installedModels())
    if (!binary || !model) return { ok: false, error: '还没有准备好转写程序或模型，请在「设置 → 语音输入」里完成' }
    const lang = language ?? settings?.language ?? 'auto'
    const file = join(tmpdir(), `yan-voice-${randomUUID()}.wav`)
    const started = Date.now()
    try {
      await writeFile(file, wav)
      const seconds = (wav.byteLength - 44) / 32_000
      const threads = Math.max(1, Math.min(8, cpus().length - 1))
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          binary.path,
          ['-m', model.path, '-f', file, '-l', lang, '-t', String(threads), '-nt', '-np'],
          {
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            /* 整段转写：给录音时长的 10 倍再加一分钟，慢机器也够用 */
            timeout: Math.round(seconds * 10_000) + 60_000,
            encoding: 'utf8'
          },
          (error, out, err) => (error ? reject(new Error((err || error.message).toString().trim().split('\n').slice(-3).join('\n'))) : resolve(out))
        )
      })
      const text = parseWhisperOutput(stdout)
      if (!text) return { ok: false, error: '没有识别到内容，请靠近麦克风再试一次' }
      return { ok: true, text, elapsedMs: Date.now() - started }
    } catch (error) {
      return { ok: false, error: `转写失败：${error instanceof Error ? error.message : String(error)}` }
    } finally {
      await rm(file, { force: true }).catch(() => undefined)
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function headSize(url: string): Promise<number | null> {
  try {
    const response = await net.fetch(url, { method: 'HEAD', redirect: 'follow' })
    const size = Number(response.headers.get('content-length'))
    return response.ok && size > 0 ? size : null
  } catch {
    return null
  }
}

/** 200ms 内的整体 CPU 占用；Windows 上 loadavg 恒为 0，只能自己采样 */
async function sampleCpuLoad(): Promise<number | null> {
  const snap = (): { idle: number; total: number } =>
    cpus().reduce(
      (acc, cpu) => {
        const t = cpu.times
        acc.idle += t.idle
        acc.total += t.user + t.nice + t.sys + t.idle + t.irq
        return acc
      },
      { idle: 0, total: 0 }
    )
  const a = snap()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const b = snap()
  const total = b.total - a.total
  return total > 0 ? Math.max(0, Math.min(1, 1 - (b.idle - a.idle) / total)) : null
}

/** 从官方 zip 里取出 exe / dll，拍平到 bin 目录（先解到临时目录，齐了再替换） */
async function installBinaryZip(zipPath: string): Promise<void> {
  const zip = new ZipReader(await readFile(zipPath))
  const wanted = zip.names().filter((name) => /\.(exe|dll)$/i.test(name) && !name.endsWith('/'))
  if (!wanted.some((name) => /(^|\/)whisper-cli\.exe$/i.test(name))) throw new Error('程序包里没有 whisper-cli.exe')
  const staging = join(VOICE_DIR, `bin-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    for (const name of wanted) {
      const data = zip.read(name)
      if (data) await writeFile(join(staging, basename(name)), data)
    }
    await rm(BIN_DIR, { recursive: true, force: true })
    await rename(staging, BIN_DIR)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
