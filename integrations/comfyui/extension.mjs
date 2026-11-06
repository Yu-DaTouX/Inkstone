import { readFile, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'

function postJson(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('已取消')); return }
    const req = httpRequest(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try { resolve({ ok: (res.statusCode ?? 500) < 400, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch { reject(new Error('插件返回的不是有效 JSON')) }
      })
      res.on('error', reject)
    })
    const abort = () => req.destroy(new Error('已取消'))
    signal?.addEventListener('abort', abort, { once: true })
    req.on('close', () => signal?.removeEventListener('abort', abort))
    req.on('error', reject)
    req.end(body)
  })
}

async function callPlugin(action, input, toolCallId, ctx, signal) {
  const env = process.env
  if (!env.YAN_CLI_URL || !env.YAN_CLI_TOKEN || !env.YAN_SESSION_ID || !env.YAN_PROJECT_ID) throw new Error('Inkstone 会话接口未就绪')
  const response = await postJson(env.YAN_CLI_URL, { 'content-type': 'application/json', authorization: `Bearer ${env.YAN_CLI_TOKEN}` },
    JSON.stringify({ apiVersion: 1, command: 'plugin.invoke', params: { plugin: 'comfyui', action, input, toolCall: { id: toolCallId, cwd: ctx.cwd, subagent: false } }, sessionId: env.YAN_SESSION_ID, projectId: env.YAN_PROJECT_ID }),
    signal)
  const result = response.json
  if (!response.ok || !result.ok) throw new Error(result.error || '插件调用失败')
  if (!result.resultFile) throw new Error('插件返回结果缺失')
  return JSON.parse(await readFile(result.resultFile, 'utf8'))
}
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value })

const DEFAULT_WAIT_SECONDS = 240
const POLL_SECONDS = 5
const STAGES = {
  preparing: '准备中', 'waiting-for-plugin-queue': '等待前一个插件任务', 'awaiting-approval': '等待用户确认', 'starting-comfyui': '正在启动 ComfyUI',
  uploading: '上传素材', submitting: '提交工作流', queued: '排队中', running: '生成中', downloading: '下载结果', saving: '保存结果', done: '已完成'
}

export function describeJob(job) {
  if (job.state === 'error') return `任务 ${job.jobId} 失败：${job.error}`
  if (job.state === 'cancelled') return `任务 ${job.jobId} 已取消`
  const parts = [STAGES[job.stage] ?? job.stage ?? '运行中']
  if (job.message) parts.push(job.message)
  if (job.workflow) parts.push(job.workflow)
  if (job.queuePosition) parts.push(`第 ${job.queuePosition} 位`)
  if (job.nodeType) parts.push(`节点 ${job.nodeType}${job.nodesTotal ? `（已完成 ${job.nodesDone}/${job.nodesTotal}）` : ''}`)
  if (job.steps) parts.push(`步数 ${job.step}/${job.steps}（${job.stepPercent}%）`)
  parts.push(`已用 ${job.elapsedSeconds} 秒`)
  return `任务 ${job.jobId}：${parts.join('，')}`
}

function waitBudget(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 900) : DEFAULT_WAIT_SECONDS
}

function cancelOnAbort(jobId, toolCallId, ctx, signal) {
  const cancel = () => { void callPlugin('job', { jobId, cancel: true }, toolCallId, ctx).catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  return () => signal?.removeEventListener('abort', cancel)
}

async function followJob(jobId, budgetSeconds, toolCallId, ctx, signal, onUpdate) {
  const deadline = Date.now() + budgetSeconds * 1000
  for (;;) {
    const remaining = Math.max(0, (deadline - Date.now()) / 1000)
    const job = await callPlugin('job', { jobId, waitSeconds: Math.min(POLL_SECONDS, remaining) }, toolCallId, ctx, signal)
    onUpdate?.({ content: [{ type: 'text', text: describeJob(job) }], details: job })
    if (job.state !== 'running' || remaining <= 0) return job
  }
}

async function finishVideoJob(pi, job, signal) {
  if (job.state === 'error' || job.state === 'cancelled') throw new Error(describeJob(job))
  if (job.state === 'running') {
    const text = `${describeJob(job)}。任务仍在后台运行：用 comfyui_job 传 jobId "${job.jobId}" 继续等待（可设 waitSeconds），或传 cancel: true 取消。`
    return { content: [{ type: 'text', text }], details: job }
  }
  const paths = job.files ? job.files.map(file => file.path) : [job.path]
  let attached = false
  for (const path of paths) {
    if (!(await stat(path).catch(() => null))?.isFile()) throw new Error('结果文件无效')
    try { attached = (await pi.exec('yan', ['artifact', 'attach', '--path', path], { signal })).code === 0 } catch { attached = false }
  }
  if (signal?.aborted) throw new Error('已取消')
  const done = { ...job, attached }
  return { content: [{ type: 'text', text: `${describeJob(done)}。${JSON.stringify(done)}` }], details: done }
}

export default function comfyui(pi) {
  pi.registerTool({
    name: 'comfyui_service', label: 'ComfyUI 服务',
    description: '查询、启动或关闭本机 ComfyUI；只关闭此插件启动的实例。status 会列出已保存工作流及其类型（text-to-image、image-to-image、text-to-video、image-to-video、video-to-video），服务未运行时从安装目录读取。启动直接执行，关闭由宿主向用户确认。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'start', 'stop'] } }, required: ['action'], additionalProperties: false },
    async execute(id, params, signal, _update, ctx) {
      if (!['status', 'start', 'stop'].includes(params.action)) throw new Error('未知服务操作')
      return textResult(await callPlugin(params.action, {}, id, ctx, signal))
    }
  })
  pi.registerTool({
    name: 'comfyui_generate', label: 'ComfyUI 出图',
    description: '用 ComfyUI 已保存的文生图或图生图工作流生成图片，支持 UI/API 工作流和子图。保留模型、LoRA 等设置；workflow 可选。sourcePaths 只允许项目内或插件成果目录内图片。需要时自动启动本机 ComfyUI；外部请求和云端节点由宿主向用户确认。',
    parameters: {
      type: 'object', properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 20000 }, workflow: { type: 'string' }, size: { type: 'string' },
        sourcePaths: { type: 'array', items: { type: 'string' }, maxItems: 4 }
      }, required: ['prompt'], additionalProperties: false
    },
    async execute(id, params, signal, _update, ctx) {
      const generated = await callPlugin('generate', params, id, ctx, signal)
      if (signal?.aborted) throw new Error('已取消')
      const info = await stat(generated.path)
      if (!info.isFile() || info.size > 40 * 1024 * 1024) throw new Error('图片结果无效或过大')
      const bytes = await readFile(generated.path)
      let attached = false
      try { attached = (await pi.exec('yan', ['artifact', 'attach', '--path', generated.path], { signal })).code === 0 } catch {}
      if (signal?.aborted) throw new Error('已取消')
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...generated, attached }) }, { type: 'image', mimeType: generated.mimeType, data: bytes.toString('base64') }],
        details: { ...generated, attached }
      }
    }
  })
  pi.registerTool({
    name: 'comfyui_video', label: 'ComfyUI 生视频',
    description: '用 ComfyUI 已保存的视频工作流生成视频：给 videoPath 走 video-to-video，给 sourcePaths 走 image-to-video，都不给走 text-to-video。保留工作流里的模型、LoRA 等设置，支持 MiniMax H3 Director。workflow 可选，先用 comfyui_service status 看可用工作流。size 如 672x384，不给时 Director 按源视频比例保持工作流像素量；seconds 限制生成时长（Director 默认 10 秒）。路径只允许项目内或插件成果目录内的文件。生成在后台任务里跑，卡片实时显示进度；最多等 waitSeconds（默认 240，0 为立即返回），到时没完成就返回进度和 jobId，再用 comfyui_job 继续等待或取消。需要时自动启动本机 ComfyUI；外部请求和云端节点由宿主向用户确认。',
    parameters: {
      type: 'object', properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 20000 }, workflow: { type: 'string' }, size: { type: 'string' },
        videoPath: { type: 'string' }, sourcePaths: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        seconds: { type: 'number', exclusiveMinimum: 0, maximum: 30 },
        waitSeconds: { type: 'number', minimum: 0, maximum: 900 }
      }, required: ['prompt'], additionalProperties: false
    },
    async execute(id, params, signal, onUpdate, ctx) {
      const { waitSeconds, ...input } = params
      const started = await callPlugin('video', { ...input, detach: true }, id, ctx, signal)
      const release = cancelOnAbort(started.jobId, id, ctx, signal)
      try {
        onUpdate?.({ content: [{ type: 'text', text: describeJob(started) }], details: started })
        return await finishVideoJob(pi, await followJob(started.jobId, waitBudget(waitSeconds), id, ctx, signal, onUpdate), signal)
      } finally { release() }
    }
  })
  pi.registerTool({
    name: 'comfyui_nodes', label: 'ComfyUI 节点目录',
    description: '查询这台 ComfyUI 实际安装的节点（object_info）。不传参数返回分类概览；search 按空格分隔的关键词匹配名称、显示名、分类和说明，category 限定分类；types 按节点类型名取完整定义（必填/可选输入、取值范围、下拉选项、输出序号与类型）。拼装或改写工作流前用它确认节点存在及输入名，不要凭记忆写。需要时自动启动本机 ComfyUI。',
    parameters: { type: 'object', properties: { search: { type: 'string' }, category: { type: 'string' }, types: { type: 'array', items: { type: 'string' }, maxItems: 20 } }, additionalProperties: false },
    async execute(id, params, signal, _update, ctx) { return textResult(await callPlugin('nodes', params, id, ctx, signal)) }
  })
  pi.registerTool({
    name: 'comfyui_workflow', label: 'ComfyUI 工作流',
    description: '读取或校验工作流。来源三选一：name（ComfyUI 已保存工作流，界面格式会转成 API 格式）、path（项目内 JSON 文件，API 或界面格式）、prompt（API 格式对象）。mode 为 read（默认）返回 API 格式 JSON（{节点编号: {class_type, inputs}}，输入里 ["节点编号", 输出序号] 是连线）；JSON 太长时不内联，传 outPath（项目内 .json，已存在需 overwrite: true）保存后用文件工具修改。mode 为 validate 用 object_info 检查节点是否存在、必填输入、连线节点与输出序号、类型是否匹配、数值范围、下拉值、是否有输出节点、是否成环，返回逐条问题（节点、输入、原因和可选值）及云端 API 节点列表；校验通过再用 comfyui_run 运行。',
    parameters: {
      type: 'object', properties: {
        mode: { type: 'string', enum: ['read', 'validate'] }, name: { type: 'string' }, path: { type: 'string' }, prompt: { type: 'object' },
        outPath: { type: 'string' }, overwrite: { type: 'boolean' }
      }, additionalProperties: false
    },
    async execute(id, params, signal, _update, ctx) { return textResult(await callPlugin('workflow', params, id, ctx, signal)) }
  })
  pi.registerTool({
    name: 'comfyui_upload', label: 'ComfyUI 上传素材',
    description: '把项目内或插件成果目录内的图片（PNG/JPEG/WebP）、视频（MP4/MOV/WebM/MKV）上传到 ComfyUI 的 input 目录，返回可填入 LoadImage 的 image、LoadVideo 的 file 等输入的文件名。',
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 } }, required: ['paths'], additionalProperties: false },
    async execute(id, params, signal, _update, ctx) { return textResult(await callPlugin('upload', params, id, ctx, signal)) }
  })
  pi.registerTool({
    name: 'comfyui_run', label: 'ComfyUI 运行工作流',
    description: '运行你拼装或改写的工作流（API 格式），来源 path（项目内 JSON）或 prompt（对象）二选一，提交前自动校验，不通过则返回问题清单且不提交；ComfyUI 拒绝或节点执行失败时返回节点编号、类型和原因，据此修改再运行。所有输出图片和视频（最多 8 个）保存并挂到回复，文本输出一并返回。后台任务，卡片显示进度，最多等 waitSeconds（默认 240，0 为立即返回），到时没完成返回 jobId，用 comfyui_job 继续。含云端 API 节点（可能付费）时每次运行都由宿主向用户确认。',
    parameters: {
      type: 'object', properties: { path: { type: 'string' }, prompt: { type: 'object' }, waitSeconds: { type: 'number', minimum: 0, maximum: 900 } }, additionalProperties: false
    },
    async execute(id, params, signal, onUpdate, ctx) {
      const { waitSeconds, ...input } = params
      const started = await callPlugin('run', { ...input, detach: true }, id, ctx, signal)
      const release = cancelOnAbort(started.jobId, id, ctx, signal)
      try {
        onUpdate?.({ content: [{ type: 'text', text: describeJob(started) }], details: started })
        return await finishVideoJob(pi, await followJob(started.jobId, waitBudget(waitSeconds), id, ctx, signal, onUpdate), signal)
      } finally { release() }
    }
  })
  pi.registerTool({
    name: 'comfyui_job', label: 'ComfyUI 任务',
    description: '查看、继续等待或取消 comfyui_video 的后台任务。传 jobId 等到完成或 waitSeconds（默认 240，最多 900）到期，返回阶段、排队位置、当前节点、步数和已用时间，完成时返回视频路径并挂到回复；cancel: true 取消任务；不传 jobId 列出最近的任务。',
    parameters: {
      type: 'object', properties: {
        jobId: { type: 'string' }, waitSeconds: { type: 'number', minimum: 0, maximum: 900 }, cancel: { type: 'boolean' }
      }, additionalProperties: false
    },
    async execute(id, params, signal, onUpdate, ctx) {
      if (!params.jobId) return textResult(await callPlugin('job', {}, id, ctx, signal))
      if (params.cancel === true) {
        const job = await callPlugin('job', { jobId: params.jobId, cancel: true }, id, ctx, signal)
        return { content: [{ type: 'text', text: describeJob(job) }], details: job }
      }
      const release = cancelOnAbort(params.jobId, id, ctx, signal)
      try {
        return await finishVideoJob(pi, await followJob(params.jobId, waitBudget(params.waitSeconds), id, ctx, signal, onUpdate), signal)
      } finally { release() }
    }
  })
}
