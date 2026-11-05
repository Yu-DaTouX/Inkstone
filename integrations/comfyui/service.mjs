import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { detectLocalImageService } from './discovery.mjs'
import { comfyStatus, ensureComfyRunning, holdManagedComfy, stopManagedComfy } from './launcher.mjs'
import { comfyGenerate, loadSources, loadVideoSource, sniffFormat, sniffVideoFormat, VIDEO_MIME } from './generation.mjs'

const MAX_IMAGE_BYTES = 40 * 1024 * 1024
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024
const MAX_JOB_WAIT_SECONDS = 60
const KEEP_FINISHED_JOBS = 20

export function createComfyService({ confirm, artifactDir, sourceArtifactDir = artifactDir, report = () => {} }) {
  let generationQueue = Promise.resolve()
  let queued = 0
  const jobs = new Map()
  const check = signal => { if (signal?.aborted) throw new Error('已取消') }
  const approve = async (title, detail, signal, progress) => {
    check(signal)
    progress?.({ stage: 'awaiting-approval', message: title })
    if (!(await confirm(title, detail, signal))) throw new Error('用户未批准操作')
    check(signal)
  }

  const validate = (media, params, request) => {
    if (typeof params.prompt !== 'string' || !params.prompt.trim() || params.prompt.length > 20000) throw new Error('提示词无效')
    if (typeof request.context?.cwd !== 'string' || !isAbsolute(request.context.cwd)) throw new Error('缺少可信项目目录')
    if (params.sourcePaths !== undefined && (!Array.isArray(params.sourcePaths) || params.sourcePaths.some(path => typeof path !== 'string'))) throw new Error('参考图路径无效')
    if (media === 'video' && params.videoPath !== undefined && typeof params.videoPath !== 'string') throw new Error('源视频路径无效')
    if (media === 'video' && params.seconds !== undefined && !(Number.isFinite(params.seconds) && params.seconds > 0 && params.seconds <= 30)) throw new Error('seconds 需在 0–30 秒之间')
  }

  const produce = async (media, params, request, signal, progress) => {
    const previous = generationQueue
    let release
    generationQueue = new Promise(resolve => { release = resolve })
    if (queued++ > 0) progress({ stage: 'waiting-for-plugin-queue' })
    await previous
    try {
      check(signal)
      const status = await comfyStatus()
      let server = status.managed && status.baseUrl ? { kind: 'comfyui', name: 'ComfyUI', baseUrl: status.baseUrl } : await detectLocalImageService()
      if (!server) {
        progress({ stage: 'starting-comfyui' })
        server = await ensureComfyRunning(detail => { report('preparing', detail); progress({ stage: 'starting-comfyui', message: detail }) })
      }
      check(signal)
      const host = new URL(server.baseUrl).hostname
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) await approve('外部图像服务', '将提示词和参考素材发送至 ' + server.baseUrl, signal, progress)
      await mkdir(artifactDir, { recursive: true })
      const roots = { cwd: request.context.cwd, artifactDir: sourceArtifactDir }
      const sources = await loadSources(params.sourcePaths, roots)
      const video = media === 'video' ? await loadVideoSource(params.videoPath, roots) : undefined
      check(signal)
      const hold = holdManagedComfy(server.baseUrl)
      try {
        const generated = await comfyGenerate(
          { prompt: params.prompt, model: params.workflow, size: params.size, seconds: media === 'video' ? params.seconds : undefined }, sources, server, hold.managed,
          report, signal,
          async workflow => {
            await approve('ComfyUI 云端 API', '工作流 ' + workflow + ' 包含云端 API 节点，可能发送数据并产生费用。是否允许本次执行？', signal, progress)
            return true
          },
          { media, video, onProgress: progress }
        )
        check(signal)
        progress({ stage: 'saving' })
        const format = media === 'video' ? sniffVideoFormat(generated.bytes) : sniffFormat(generated.bytes)
        const limit = media === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
        if (!format || !generated.bytes.length || generated.bytes.length > limit) throw new Error(`ComfyUI 返回的${media === 'video' ? '视频' : '图片'}无效或过大`)
        const path = join(artifactDir, randomUUID() + '.' + format)
        await writeFile(path, generated.bytes, { flag: 'wx', mode: 0o600 })
        check(signal)
        return { path, workflow: generated.model, bytes: generated.bytes.length, mimeType: media === 'video' ? VIDEO_MIME[format] : 'image/' + format }
      } finally { hold.release() }
    } finally { queued--; release() }
  }

  const snapshot = job => ({
    jobId: job.id,
    state: job.state,
    media: job.media,
    elapsedSeconds: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
    ...job.progress,
    ...(job.result ?? {}),
    ...(job.error ? { error: job.error, ...(job.code ? { code: job.code } : {}) } : {})
  })

  const pruneJobs = () => {
    const finished = [...jobs.values()].filter(job => job.state !== 'running').sort((a, b) => a.finishedAt - b.finishedAt)
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_JOBS))) jobs.delete(job.id)
  }

  const startJob = (media, params, request) => {
    const job = { id: randomUUID().slice(0, 8), media, state: 'running', startedAt: Date.now(), progress: { stage: 'preparing' }, controller: new AbortController() }
    const progress = patch => {
      if (job.state !== 'running') return
      const stageChanged = patch.stage && patch.stage !== job.progress.stage && !('message' in patch)
      job.progress = { ...job.progress, ...(stageChanged ? { message: undefined } : {}), ...patch }
    }
    job.promise = produce(media, params, request, job.controller.signal, progress).then(
      result => { job.state = 'done'; job.result = result; job.progress = { stage: 'done', workflow: result.workflow } },
      error => {
        job.state = job.controller.signal.aborted ? 'cancelled' : 'error'
        job.error = String(error?.message ?? error)
        job.code = typeof error?.code === 'string' ? error.code : undefined
      }
    ).finally(() => { job.finishedAt = Date.now(); pruneJobs() })
    jobs.set(job.id, job)
    return job
  }

  const waitJob = async (job, seconds, signal) => {
    if (job.state !== 'running' || !(seconds > 0)) return
    let timer
    let onAbort
    await Promise.race([
      job.promise,
      new Promise(resolve => { timer = setTimeout(resolve, Math.min(seconds, MAX_JOB_WAIT_SECONDS) * 1000) }),
      new Promise(resolve => { onAbort = resolve; signal?.addEventListener('abort', resolve, { once: true }) })
    ])
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  return async function invoke(action, request = {}, signal) {
    const params = request.input ?? {}
    check(signal)
    if (action === 'status') return { ...await comfyStatus(), jobs: [...jobs.values()].map(snapshot) }
    if (action === 'start') {
      await ensureComfyRunning(detail => report('preparing', detail))
      check(signal)
      return comfyStatus()
    }
    if (action === 'stop') {
      await approve('关闭 ComfyUI', '仅关闭插件启动的 ComfyUI，释放显存。是否继续？', signal)
      const stopped = stopManagedComfy()
      return { ...await comfyStatus(), stopped }
    }
    if (action === 'job') {
      if (params.jobId === undefined) return { jobs: [...jobs.values()].map(snapshot) }
      const job = typeof params.jobId === 'string' ? jobs.get(params.jobId) : undefined
      if (!job) throw new Error('任务不存在或已过期')
      if (params.cancel === true && job.state === 'running') {
        job.controller.abort()
        await waitJob(job, 15, signal)
      } else {
        await waitJob(job, Number(params.waitSeconds) || 0, signal)
      }
      return snapshot(job)
    }
    if (action !== 'generate' && action !== 'video') throw new Error('未知插件操作')
    const media = action === 'video' ? 'video' : 'image'
    validate(media, params, request)
    if (params.detach === true) return snapshot(startJob(media, params, request))
    return produce(media, params, request, signal, () => {})
  }
}
