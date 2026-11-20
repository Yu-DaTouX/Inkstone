import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const meta = { description: '隔离验证 Minecraft 插件建图和 Fabric 开关' }

export default async function run({ box, cdp, sleep, check, shot }) {
  const source = process.env.YAN_MINECRAFT_PLUGIN_FIXTURE
  if (!source) throw new Error('需要 YAN_MINECRAFT_PLUGIN_FIXTURE 指向本地插件工作树')
  const dir = join(box.dataDir, 'plugins', 'inkstone-minecraft')
  await mkdir(dir, { recursive: true })
  for (const file of ['mcp', 'src', 'skills', 'package.json']) await cp(join(source, file), join(dir, file), { recursive: true })
  const file = join(box.piDir, 'mcp.json')
  await writeFile(file, JSON.stringify({ mcpServers: { 'inkstone-minecraft': { command: process.execPath, args: [join(dir, 'mcp', 'server.ts')] } } }), { flag: 'wx' })
  const names = () => readFile(file, 'utf8').then(text => JSON.parse(text).mcpServers)
  const skill = () => readFile(join(box.dataDir, 'skills', 'inkstone-fabric-dev', 'SKILL.md'), 'utf8').then(() => true, () => false)
  const until = async (fn) => {
    for (let i = 0; i < 80; i++) { if (await fn()) return; await sleep(250) }
    throw new Error('等待 Minecraft 开关状态超时')
  }
  const toggle = '[data-testid="caps-minecraft-dev-toggle"]'
  const server = 'inkstone-minecraft-dev'
  await cdp.evaluate(`window.__yanStore.getState().openSettings('market')`)
  await until(() => cdp.evaluate(`!!document.querySelector('${toggle} input:not(:disabled)')`))
  check('本地双入口包默认没有 Fabric 注册和技能', !(server in await names()) && !(await skill()))
  await shot('minecraft-map-default')
  await cdp.evaluate(`document.querySelector('${toggle} input').click()`)
  await until(async () => (await names())[server]?.enabled === true && (await skill()))
  await until(() => cdp.evaluate(`!!document.querySelector('${toggle} input:not(:disabled):checked')`))
  check('打开 Fabric 后独立注册，并启用开发技能', (await names())[server].args.at(-1) === join(dir, 'mcp', 'dev-server.ts'))
  await shot('minecraft-dev-enabled')
  await cdp.evaluate(`document.querySelector('${toggle} input').click()`)
  await until(async () => (await names())[server]?.enabled === false && !(await skill()))
  check('关闭 Fabric 不关闭建图', (await names())['inkstone-minecraft'].enabled !== false)
}
