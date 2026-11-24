import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '对话里装 MCP、看砚插件与 pi 插件：yan mcp add / disable / remove 弹批准面板，批准后写进 pi 的 mcp.json，密钥值不进工具输出；假模型，不联网安装' }

const SECRET = 'zz-chat-install-secret-zz'

export default async function run({ cdp, box, newSession, turn, check, sleep, shot, report }) {
  const ev = (code) => cdp.evaluate(code)
  await newSession(box.project)
  const commands = join(box.project, 'install-commands.json')
  writeFileSync(commands, JSON.stringify([
    'yan mcp services',
    `KEY_VALUE=$(printf 'zz-%s' chat-install-secret-zz); yan mcp add --name demo-docs --url http://127.0.0.1:9/mcp --env "DEMO_KEY=$KEY_VALUE" --reason "演示：查文档"`,
    'yan mcp services',
    'yan mcp disable --name demo-docs',
    'yan mcp remove --name demo-docs',
    'yan plugin list',
    'yan package list'
  ]))

  const panels = []
  const clickApprovals = async () => {
    for (let i = 0; i < 600; i += 1) {
      const seen = await ev(`(() => {
        const card = [...document.querySelectorAll('[data-testid=v3-question]')].find((el) => el.querySelector('[data-testid=v3-question-option-0]:not([disabled])'))
        if (!card) return null
        const option = card.querySelector('[data-testid=v3-question-option-0] .v3-qoption-t')?.textContent ?? ''
        return { option, text: card.innerText.slice(0, 600) }
      })()`)
      if (seen && !panels.some((p) => p.text === seen.text)) {
        panels.push(seen)
        await sleep(400)
        await shot(`chat-install-panel-${panels.length}`)
        await ev(`(() => { const card = [...document.querySelectorAll('[data-testid=v3-question]')].find((el) => el.querySelector('[data-testid=v3-question-option-0]:not([disabled])')); card?.querySelector('[data-testid=v3-question-option-0]')?.click() })()`)
      }
      if (panels.length >= 3) return
      await sleep(250)
    }
  }

  await turn(`CMDFILE=${commands}`, { timeout: 180000, during: clickApprovals })
  await shot('chat-install-done')

  const outputs = await ev(`(() => {
    const out = []
    for (const m of window.__yanStore.getState().messages) for (const tool of m.toolCalls || []) out.push({ command: String(tool.args?.command ?? ''), output: String(tool.output ?? '') })
    return out
  })()`)
  const parsed = outputs.filter((o) => o.command.includes('yan ')).map((o) => {
    try { return { ...o, json: JSON.parse(o.output.trim().split('\n').pop()) } } catch { return { ...o, json: null } }
  })
  const byCommand = (prefix) => parsed.filter((o) => o.command.includes(prefix))
  const added = byCommand('yan mcp add')[0]?.json
  check('mcp add 批准后返回 done', added?.ok === true && added?.summary?.state === 'done', JSON.stringify(added)?.slice(0, 400))
  check('弹了三次批准面板（添加、停用、删除）', panels.length === 3, JSON.stringify(panels.map((p) => p.option)))
  let trustTable = ''
  try { trustTable = readFileSync(join(box.piDir, 'trust.json'), 'utf8') } catch {}
  check('启动时自动信任已有项目', trustTable.toLowerCase().includes(box.project.replaceAll('\\', '\\\\').toLowerCase()), trustTable.slice(0, 300))
  check('项目已信任时面板给出「只用于当前项目」选项', panels[0]?.text.includes('只用于当前项目「project」') && !panels[0]?.text.includes('还没有被信任'), panels[0]?.text)
  check('面板显示环境变量名，不显示值', panels[0]?.text.includes('DEMO_KEY') && !panels[0]?.text.includes(SECRET))
  check('密钥值不出现在任何工具输出里', !outputs.some((o) => o.output.includes(SECRET)))
  const listed = byCommand('yan mcp services')[1]?.json
  check('添加后 mcp services 能列出新服务', JSON.stringify(listed ?? {}).includes('demo-docs'))
  const disabled = byCommand('yan mcp disable')[0]?.json
  const removed = byCommand('yan mcp remove')[0]?.json
  check('停用、删除都批准生效', disabled?.summary?.state === 'done' && removed?.summary?.state === 'done')
  const mcpFile = join(box.piDir, 'mcp.json')
  let finalConfig = ''
  try { finalConfig = readFileSync(mcpFile, 'utf8') } catch {}
  check('删除后 pi 的 mcp.json 里不再有这个服务', !finalConfig.includes('demo-docs'), finalConfig.slice(0, 300))
  const plugins = byCommand('yan plugin list')[0]?.json
  check('plugin list 列出砚插件', plugins?.ok === true && Array.isArray(plugins?.summary?.plugins) && plugins.summary.plugins.some((p) => p.id === 'comfyui'))
  const packages = byCommand('yan package list')[0]?.json
  check('package list 可用', packages?.ok === true, JSON.stringify(packages)?.slice(0, 300))
  report.panels = panels
  report.outputs = parsed.map((o) => ({ command: o.command.replace(SECRET, '<secret>'), summary: o.json?.summary ?? o.output.slice(0, 300) }))
}
