import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { detectLocalImageService } from './discovery.mjs'
import { comfyStatus, ensureComfyRunning, holdManagedComfy, stopManagedComfy } from './launcher.mjs'
import { comfyImage, loadSources, sniffFormat } from './generation.mjs'

export function createComfyService({ confirm, artifactDir, sourceArtifactDir = artifactDir, report = () => {} }) {
  let generationQueue = Promise.resolve()
  const check = signal => { if (signal?.aborted) throw new Error('已取消') }
  const approve = async (title, detail, signal) => {
    check(signal)
    if (!(await confirm(title, detail, signal))) throw new Error('用户未批准操作')
    check(signal)
  }
  return async function invoke(action, request = {}, signal) {
    const params = request.input ?? {}
    check(signal)
    if (action === 'status') return comfyStatus()
    if (action === 'start') {
      await approve('启动 ComfyUI', '将运行本机 Python 进程，监听 127.0.0.1。是否继续？', signal)
      await ensureComfyRunning(detail => report('preparing', detail))
      check(signal)
      return comfyStatus()
    }
    if (action === 'stop') {
      await approve('关闭 ComfyUI', '仅关闭插件启动的 ComfyUI，释放显存。是否继续？', signal)
      const stopped = stopManagedComfy()
      return { ...await comfyStatus(), stopped }
    }
    if (action !== 'generate') throw new Error('未知插件操作')
    if (typeof params.prompt !== 'string' || !params.prompt.trim() || params.prompt.length > 20000) throw new Error('提示词无效')
    if (typeof request.context?.cwd !== 'string' || !isAbsolute(request.context.cwd)) throw new Error('缺少可信项目目录')
    if (params.sourcePaths !== undefined && (!Array.isArray(params.sourcePaths) || params.sourcePaths.some(path => typeof path !== 'string'))) throw new Error('参考图路径无效')
    const previous = generationQueue
    let release
    generationQueue = new Promise(resolve => { release = resolve })
    await previous
    try {
      check(signal)
      const status = await comfyStatus()
      let server = status.managed && status.baseUrl ? { kind: 'comfyui', name: 'ComfyUI', baseUrl: status.baseUrl, models: status.workflows } : await detectLocalImageService()
      if (!server) {
        await approve('启动 ComfyUI', '出图需要启动本机 ComfyUI（Python 进程）。是否继续？', signal)
        server = await ensureComfyRunning(detail => report('preparing', detail))
      }
      check(signal)
      const host = new URL(server.baseUrl).hostname
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) await approve('外部图像服务', '将提示词和参考图发送至 ' + server.baseUrl, signal)
      await mkdir(artifactDir, { recursive: true })
      const sources = await loadSources(params.sourcePaths, { cwd: request.context.cwd, artifactDir: sourceArtifactDir })
      check(signal)
      const hold = holdManagedComfy(server.baseUrl)
      try {
        const generated = await comfyImage(
          { prompt: params.prompt, model: params.workflow, size: params.size }, sources, server, hold.managed,
          report, signal,
          async workflow => {
            await approve('ComfyUI 云端 API', '工作流 ' + workflow + ' 包含云端 API 节点，可能发送数据并产生费用。是否允许本次执行？', signal)
            return true
          }
        )
        check(signal)
        const format = sniffFormat(generated.bytes)
        if (!format || !generated.bytes.length || generated.bytes.length > 40 * 1024 * 1024) throw new Error('ComfyUI 返回的图片无效或过大')
        const path = join(artifactDir, randomUUID() + '.' + format)
        await writeFile(path, generated.bytes, { flag: 'wx', mode: 0o600 })
        check(signal)
        return { path, workflow: generated.model, bytes: generated.bytes.length, mimeType: 'image/' + format }
      } finally { hold.release() }
    } finally { release() }
  }
}
