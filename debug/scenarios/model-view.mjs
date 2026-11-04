import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '模型视角快照：抓主会话与子代理实际收到的系统提示和工具 schema，落盘并统计体积' }

const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('\n')

export default async function run({ cdp, fake, runDir, check, waitFor, turn, log }) {
  const requests = []
  fake.server.prependListener('request', (req) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try { requests.push(JSON.parse(body)) } catch {}
    })
  })
  const dump = (name, marker) => {
    const req = requests.findLast((item) => (item.tools ?? []).length > 0 && JSON.stringify(item.input ?? []).includes(marker))
    if (!req) return null
    const input = req.input ?? []
    const system = [req.instructions ?? '', ...input.filter((item) => item.role === 'system' || item.role === 'developer').map((item) => textOf(item.content))].filter(Boolean).join('\n\n')
    const firstUser = input.filter((item) => item.role === 'user').map((item) => textOf(item.content)).join('\n---\n')
    const tools = (req.tools ?? []).map((tool) => {
      const fn = tool.function ?? tool
      return { name: fn.name ?? tool.type, descriptionChars: (fn.description ?? '').length, schemaChars: JSON.stringify(fn.parameters ?? {}).length }
    })
    writeFileSync(join(runDir, `${name}-request.json`), JSON.stringify(req, null, 2))
    writeFileSync(join(runDir, `${name}-system.md`), system)
    writeFileSync(join(runDir, `${name}-user.md`), firstUser)
    const summary = {
      systemChars: system.length,
      userChars: firstUser.length,
      toolCount: tools.length,
      toolChars: JSON.stringify(req.tools ?? []).length,
      tools: tools.sort((a, b) => b.descriptionChars + b.schemaChars - a.descriptionChars - a.schemaChars),
      requestKeys: Object.keys(req),
    }
    writeFileSync(join(runDir, `${name}-summary.json`), JSON.stringify(summary, null, 2))
    log(`${name}: system ${summary.systemChars} 字 / 工具 ${summary.toolCount} 个 ${summary.toolChars} 字`)
    return summary
  }
  await turn('model-view-main-probe')
  check('抓到主会话请求', !!dump('main', 'model-view-main-probe'))
  const started = await cdp.evaluate('window.yan.subagents.start("model-view-child-probe", "fake/fake-model", "shared-cwd")')
  check('子代理已启动', started?.ok, started?.error)
  if (started?.run?.id) {
    await waitFor(`s.subagents?.some((run) => run.id === ${JSON.stringify(started.run.id)} && run.status === 'done')`, 30000)
    check('抓到子代理请求', !!dump('child', 'model-view-child-probe'))
  }
}
