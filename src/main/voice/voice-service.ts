import { app, net } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, freemem, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  VOICE_MAX_WAV_BYTES,
  VOICE_MODEL_BASE_URL,
  VOICE_MODELS,
  WHISPER_RELEASE_API,
  WHISPER_RELEASES_API,
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
const MAX_BINARY_ZIP_BYTES = 100 * 1024 * 1024
const MAX_BINARY_ENTRY_BYTES = 64 * 1024 * 1024
const PLAN_TTL_MS = 30 * 60_000
const WORKER_IDLE_MS = 10 * 60_000
const WHISPER_ASSET_SHA256: Record<string, string> = {
  'b5454/whisper-bin-x64.zip': '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  'b5454/whisper-bin-win-cpu-arm64.zip': '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d'
}

export function whisperAssetSha256(tag: string, assetName: string): string | undefined {
  return WHISPER_ASSET_SHA256[`${tag}/${assetName}`]
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function whisperAssetProblem(expected: string | undefined, digest: string): string | undefined {
  if (!expected) return '没有这个版本转写程序的校验值，已中止下载'
  return digest === expected ? undefined : '程序包校验失败（SHA-256 不一致），已删除下载内容'
}

interface PendingPlan {
  plan: VoiceDownloadPlan
  createdAt: number
}

interface AssetPlan {
  tag: string
  name: string
}

export class VoiceService {
  private plans = new Map<string, PendingPlan>()
  private assets = new Map<string, AssetPlan>()
  private progress: VoiceDownloadProgress | null = null
  private abort: AbortController | null = null
  private backend: 'cuda' | 'cpu' | 'unknown' = 'unknown'
  private worker: { process: ChildProcess; key: string; url: string; token: string; proxy: ReturnType<typeof createHttpServer> } | null = null
  private workerStart: Promise<string> | null = null
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private readonly getSettings: () => Promise<VoiceInputSettings | undefined>) {
    app.on('before-quit', () => { this.stopWorker(); this.abort?.abort() })
  }

  private stopWorker(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    const worker = this.worker
    this.worker = null
    if (!worker) return
    worker.proxy.close()
    if (worker.process.exitCode === null) worker.process.kill()
  }

  private scheduleWorkerIdle(): void {
    if (!this.worker) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stopWorker(), WORKER_IDLE_MS)
    this.idleTimer.unref?.()
  }

  private async server(binary: string, model: string, language: string): Promise<string | null> {
    const executable = join(dirname(binary), process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server')
    if (!(await isFile(executable))) return null
    const key = `${binary}|${model}|${language}`
    if (this.workerStart) await this.workerStart
    if (this.worker?.key === key) { this.scheduleWorkerIdle(); return this.worker.url }
    this.stopWorker()
    this.workerStart = (async () => {
      const port = await new Promise<number>((resolve, reject) => {
        const listener = createServer(); listener.on('error', reject)
        listener.listen(0, '127.0.0.1', () => { const address = listener.address(); listener.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('无法分配本地转写端口'))) })
      })
      const child = spawn(executable, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-l', language, '-t', String(Math.max(1, Math.min(8, cpus().length - 1)))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const childUrl = `http://127.0.0.1:${port}`
      const token = randomUUID()
      let log = '', failure = ''
      child.on('error', (error) => { failure = error.message })
      child.on('exit', (code) => { failure = `转写服务退出（${code}）：${log.slice(-1200)}`; if (this.worker?.process === child) { this.worker.proxy.close(); this.worker = null } })
      const collect = (chunk: Buffer): void => { log = (log + chunk.toString()).slice(-16000); if (/CUDA.*(device|GPU)|using CUDA|ggml_cuda_init: found/i.test(log)) this.backend = 'cuda'; else if (/use gpu\s*=\s*0|CPU backend/i.test(log)) this.backend = 'cpu' }
      child.stdout?.on('data', collect); child.stderr?.on('data', collect)
      this.backend = 'unknown'
      try {
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          if (failure) throw new Error(failure)
          try { const response = await fetch(childUrl, { signal: AbortSignal.timeout(1000) }); if (response.status < 500) {
            const proxy = createHttpServer((req, res) => {
              if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
              const upstream = httpRequest(new URL(req.url ?? '/', childUrl), { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (reply) => {
                res.writeHead(reply.statusCode ?? 502, reply.headers)
                reply.pipe(res)
              })
              req.pipe(upstream)
              upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
            })
            const proxyPort = await new Promise<number>((resolve, reject) => {
              proxy.once('error', reject)
              proxy.listen(0, '127.0.0.1', () => { const address = proxy.address(); typeof address === 'object' && address ? resolve(address.port) : reject(new Error('无法启动本地鉴权代理')) })
            })
            const url = `http://127.0.0.1:${proxyPort}`
            this.worker = { process: child, key, url, token, proxy }
            this.scheduleWorkerIdle()
            return url
          } } catch { }
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        throw new Error('转写模型加载超时')
      } catch (error) { child.kill(); throw error }
    })()
    try { return await this.workerStart } finally { this.workerStart = null }
  }

  get storageDir(): string {
    return VOICE_DIR
  }

  async hardware(): Promise<VoiceHardware> {
    const list = cpus()
    const load = await sampleCpuLoad()
    let gpu: string | null = null
    try {
      const info = (await app.getGPUInfo('complete')) as { gpuDevice?: Array<{ active?: boolean; deviceString?: string; vendorId?: number }> }
      const device = info.gpuDevice?.find((item) => item.active) ?? info.gpuDevice?.[0]
      gpu = device?.deviceString ?? null
      const nvidia = await new Promise<string>((resolve) => execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, timeout: 3000 }, (error, out) => resolve(error ? '' : out.trim())))
      if (nvidia) gpu = nvidia.split('\n')[0]
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
      backend: this.backend,
      storageDir: VOICE_DIR,
      download: this.progress
    }
  }

  async prepare(): Promise<{ ok: boolean; error?: string }> {
    try {
      const settings = await this.getSettings()
      const binary = await this.resolveBinary(settings), model = await this.resolveModel(settings, await this.installedModels())
      if (!binary || !model) return { ok: false, error: '请先准备转写程序和模型' }
      await this.server(binary.path, model.path, settings?.language ?? 'auto')
      return { ok: true }
    } catch (error) { return { ok: false, error: String(error) } }
  }

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
        type Release = { tag_name?: string; prerelease?: boolean; draft?: boolean; assets?: Array<{ name: string; size: number; browser_download_url: string }> }
        const latest = (await response.json()) as Release
        const versionsResponse = await net.fetch(WHISPER_RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
        const versions = versionsResponse.ok ? (await versionsResponse.json()) as Release[] : []
        const releases = [latest, ...versions.filter((r) => !r.prerelease && !r.draft && r.tag_name?.startsWith('v')), ...versions.filter((r) => !r.draft && !r.tag_name?.startsWith('v'))]
        const gpu = (await this.hardware()).gpu ?? ''
        const names = process.arch === 'arm64' ? ['whisper-bin-win-cpu-arm64.zip'] : /NVIDIA/i.test(gpu) ? ['whisper-cublas-12.4.0-bin-x64.zip', WHISPER_WINDOWS_ASSET] : [WHISPER_WINDOWS_ASSET]
        let selected: { release: Release; asset: NonNullable<Release['assets']>[number] } | undefined
        for (const name of names) {
          for (const release of releases) {
            const asset = release.assets?.find((item) => item.name === name)
            if (asset && whisperAssetSha256(release.tag_name ?? '', asset.name)) { selected = { release, asset }; break }
          }
          if (selected) break
        }
        if (!selected) return { ok: false, error: '官方发布暂时没有可校验的转写程序，请稍后重试或指定已有程序' }
        const { release, asset } = selected
        plan = {
          planId: randomUUID(),
          target: { kind: 'binary' },
          label: `whisper.cpp ${release.tag_name ?? ''} · ${asset.name}`.trim(),
          url: asset.browser_download_url,
          bytes: asset.size,
          sizeKnown: true,
          destination: BIN_DIR
        }
        this.assets.set(plan.planId, { tag: release.tag_name ?? '', name: asset.name })
      }
      this.dropStalePlans()
      this.plans.set(plan.planId, { plan, createdAt: Date.now() })
      return { ok: true, plan }
    } catch (error) {
      return { ok: false, error: `无法连接下载服务器：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private dropStalePlans(): void {
    for (const [id, pending] of this.plans) {
      if (Date.now() - pending.createdAt <= PLAN_TTL_MS) continue
      this.plans.delete(id)
      this.assets.delete(id)
    }
  }

  async download(planId: string): Promise<{ ok: boolean; error?: string }> {
    const pending = this.plans.get(planId)
    if (!pending || Date.now() - pending.createdAt > PLAN_TTL_MS) return { ok: false, error: '下载确认已失效，请重新查看大小后再确认' }
    if (this.progress?.state === 'running') return { ok: false, error: '已有下载在进行' }
    this.plans.delete(planId)
    const asset = this.assets.get(planId)
    this.assets.delete(planId)
    const { plan } = pending
    this.abort = new AbortController()
    this.progress = { planId, label: plan.label, received: 0, total: plan.bytes, state: 'running' }
    void this.runDownload(plan, asset, this.abort.signal)
    return { ok: true }
  }

  cancel(): void {
    this.abort?.abort()
  }

  private async runDownload(plan: VoiceDownloadPlan, asset: AssetPlan | undefined, signal: AbortSignal): Promise<void> {
    const partDir = plan.target.kind === 'model' ? MODELS_DIR : VOICE_DIR
    const part = join(partDir, `${plan.target.kind === 'model' ? basename(plan.destination) : 'whisper-bin'}.part`)
    try {
      await mkdir(partDir, { recursive: true })
      const response = await net.fetch(plan.url, { signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || plan.bytes
      if (plan.sizeKnown && total !== plan.bytes) throw new Error('下载大小与确认时不一致，请重新核实')
      if (plan.target.kind === 'binary' && total > MAX_BINARY_ZIP_BYTES) throw new Error('程序包大小异常，已停止')
      if (this.progress) this.progress.total = total
      const out = createWriteStream(part)
      let received = 0
      const counting = new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          received += chunk.byteLength
          if (plan.sizeKnown && received > plan.bytes) throw new Error('下载内容超过确认时的文件大小')
          if (plan.target.kind === 'binary' && received > MAX_BINARY_ZIP_BYTES) throw new Error('程序包超过 100 MiB 上限，已停止')
          if (this.progress) this.progress.received = received
          controller.enqueue(chunk)
        }
      })
      await pipeline(Readable.fromWeb(response.body.pipeThrough(counting) as import('node:stream/web').ReadableStream), out)
      if (this.progress) this.progress.received = received
      if (plan.sizeKnown && received !== plan.bytes) throw new Error('下载大小与确认时不一致，请重新核实')
      if (this.progress && this.progress.received < total) throw new Error('下载不完整')

      if (plan.target.kind === 'model') {
        await rename(part, plan.destination)
      } else {
        const problem = whisperAssetProblem(asset ? whisperAssetSha256(asset.tag, asset.name) : undefined, sha256Hex(await readFile(part)))
        if (problem) throw new Error(problem)
        if (this.workerStart) await this.workerStart.catch(() => undefined)
        if (this.worker) {
          const worker = this.worker.process; this.worker.proxy.close(); this.worker = null
          if (worker.exitCode === null) await new Promise<void>((resolve) => { worker.once('exit', () => resolve()); worker.kill() })
        }
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
      const url = await this.server(binary.path, model.path, lang)
      if (url) {
        const form = new FormData()
        form.set('file', new Blob([new Uint8Array(wav).buffer], { type: 'audio/wav' }), 'dictation.wav')
        form.set('response_format', 'json'); form.set('language', lang)
        const worker = this.worker
        if (!worker || worker.url !== url) throw new Error('本地转写服务已重启，请重试')
        const response = await fetch(`${url}/inference`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${worker.token}` }, signal: AbortSignal.timeout(120_000) })
        if (!response.ok) throw new Error(`本地转写服务 HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
        const result = await response.json() as { text?: string; error?: string }
        this.scheduleWorkerIdle()
        const text = (result.text ?? '').trim()
        if (!text) return { ok: false, error: result.error ?? '没有识别到内容，请靠近麦克风再试一次' }
        return { ok: true, text, elapsedMs: Date.now() - started }
      }
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

async function installBinaryZip(zipPath: string): Promise<void> {
  const packed = await readFile(zipPath)
  if (packed.length > MAX_BINARY_ZIP_BYTES) throw new Error('程序包超过 100 MiB 上限，已停止')
  const zip = new ZipReader(packed, MAX_BINARY_ZIP_BYTES)
  const wanted = zip.names().filter((name) => /\.(exe|dll)$/i.test(name) && !name.endsWith('/'))
  if (wanted.some((name) => (zip.entries.get(name)?.size ?? 0) > MAX_BINARY_ENTRY_BYTES)) throw new Error('程序包单个文件超过 64 MiB 上限，已停止')
  if (wanted.reduce((sum, name) => sum + (zip.entries.get(name)?.size ?? 0), 0) > 2 * MAX_BINARY_ZIP_BYTES) throw new Error('程序包解压后过大，已停止')
  if (!wanted.some((name) => /(^|\/)whisper-cli\.exe$/i.test(name))) throw new Error('程序包里没有 whisper-cli.exe')
  const staging = join(VOICE_DIR, `bin-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    for (const name of wanted) {
      const data = zip.read(name)
      if (data) await writeFile(join(staging, basename(name)), data)
    }
    const backup = join(VOICE_DIR, `bin-backup-${randomUUID()}`)
    let backedUp = false
    try { await rename(BIN_DIR, backup); backedUp = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { await rename(staging, BIN_DIR) } catch (error) { if (backedUp) await rename(backup, BIN_DIR); throw error }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
