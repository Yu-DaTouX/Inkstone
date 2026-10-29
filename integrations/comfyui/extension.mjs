import { readFile, stat } from 'node:fs/promises'

async function callPlugin(action, input, toolCallId, ctx, signal) {
  const env = process.env
  if (!env.YAN_CLI_URL || !env.YAN_CLI_TOKEN || !env.YAN_SESSION_ID || !env.YAN_PROJECT_ID) throw new Error('Inkstone 会话接口未就绪')
  const response = await fetch(env.YAN_CLI_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.YAN_CLI_TOKEN}` },
    body: JSON.stringify({ apiVersion: 1, command: 'plugin.invoke', params: { plugin: 'comfyui', action, input, toolCall: { id: toolCallId, cwd: ctx.cwd, subagent: false } }, sessionId: env.YAN_SESSION_ID, projectId: env.YAN_PROJECT_ID }),
    signal
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.error || '插件调用失败')
  if (!result.resultFile) throw new Error('插件返回结果缺失')
  return JSON.parse(await readFile(result.resultFile, 'utf8'))
}
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value })

export default function comfyui(pi) {
  pi.registerTool({
    name: 'comfyui_service', label: 'ComfyUI 服务',
    description: '查询、启动或关闭本机 ComfyUI；只关闭此插件启动的实例。启动和关闭由宿主向用户确认。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'start', 'stop'] } }, required: ['action'], additionalProperties: false },
    async execute(id, params, signal, _update, ctx) {
      if (!['status', 'start', 'stop'].includes(params.action)) throw new Error('未知服务操作')
      return textResult(await callPlugin(params.action, {}, id, ctx, signal))
    }
  })
  pi.registerTool({
    name: 'comfyui_generate', label: 'ComfyUI 出图',
    description: '用 ComfyUI 已保存的文生图或图生图工作流生成图片，支持 UI/API 工作流和子图。保留模型、LoRA 等设置；workflow 可选。sourcePaths 只允许项目内或插件成果目录内图片。启动服务、外部请求和云端节点由宿主向用户确认。',
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
}
