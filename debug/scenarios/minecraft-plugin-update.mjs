import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evidenceDir } from '../lib/env.mjs'

export const meta = { description: '隔离验证 Minecraft 插件单一入口和 MCP 列表去重', demo: true }

export default async function run({ cdp, check, sleep, box }) {
  const target = process.env.YAN_MINECRAFT_TEST_VERSION
  if (!target) throw new Error('请指定用于实际下载验收的 YAN_MINECRAFT_TEST_VERSION')
  const evidence = evidenceDir('2026-11-19-mcp-settings-dedup')
  await mkdir(evidence, { recursive: true })
  const by = id => `[data-testid="${id}"]`
  const evalJs = code => cdp.evaluate(code)
  const click = id => evalJs(`document.querySelector(${JSON.stringify(by(id))})?.click()`)
  const count = selector => evalJs(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const hostPath = join(box.dataDir, 'mcp-servers.json')
  const hostFixture = JSON.stringify([{ id: 'blender', title: 'Blender', transport: 'stdio', command: 'fixture-blender', enabled: false }])
  await writeFile(hostPath, hostFixture, { flag: 'wx' })
  const wait = async (selector, condition) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const done = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && (${condition}); })()`)
      if (done) return
      await sleep(250)
    }
    throw new Error(`等待超时：${selector}, ${await evalJs(`document.querySelector('${by('caps-market-minecraft')}')?.innerText`)}`)
  }

  await evalJs(`window.__yanStore.getState().openSettings('market')`)
  await wait(by('caps-minecraft-install'), '!el.disabled')
  check('可安装时只有安装按钮，没有并排检查', await count(by('caps-minecraft-check')) === 0)
  const available = await evalJs(`window.yan.packages.minecraft('status')`)
  check('当前官方稳定版正确', available.ok && available.status.latestVersion === target && !available.status.installed, available)
  await click('caps-minecraft-install')
  await wait('.caps-confirm-detail', `el.textContent.includes(${JSON.stringify(target)})`)
  await cdp.shot(`minecraft-${target}-confirm`, evidence)
  await click('caps-confirm-accept')
  await wait(by('caps-minecraft-note'), 'el.textContent.length > 0')
  await click('caps-minecraft-check')
  await wait(by('caps-minecraft-check'), '!el.disabled')
  const status = await evalJs(`window.yan.packages.minecraft('status')`)
  check('正式包已安装且不再提示更新', status.ok && status.status.installedVersion === target && status.status.configured && !status.status.updateAvailable, status)
  check('已是最新时只留检查按钮', await count(by('caps-minecraft-install')) === 0)
  const nativePath = join(box.piDir, 'mcp.json')
  const enableState = async () => JSON.parse(await readFile(nativePath, 'utf8')).mcpServers['inkstone-minecraft'].enabled !== false
  await wait(by('caps-minecraft-toggle'), '!el.closest("[aria-disabled=true]")')
  const toggle = async () => evalJs(`(() => { const el = document.querySelector('${by('caps-minecraft-toggle')}'); (el.matches('input') ? el : el.querySelector('input,button') ?? el).click(); })()`)
  await toggle()
  await wait(by('caps-minecraft-note'), 'el.textContent.includes("新会话") || el.textContent.includes("new sessions")')
  check('插件市场的开关真正写入全局停用', !(await enableState()))
  await toggle()
  await wait(by('caps-minecraft-note'), 'el.textContent.length > 0')
  check('可从插件市场重新启用', await enableState())
  await cdp.shot(`minecraft-${target}-installed`, evidence)

  await evalJs(`window.__yanStore.getState().openSettings('mcp')`)
  const list = by('mcp-services')
  await wait(list, 'el.textContent.includes("Blender")')
  check('MCP 全局列表不重复列托管 Minecraft', !(await evalJs(`document.querySelector('${list}').textContent.includes('inkstone-minecraft')`)))
  check('当前会话 MCP 检查只有一个入口', await count(by('caps-native-mcp')) === 1)
  await click('mcp-advanced')
  await wait(by('mcp-advanced'), 'el.getAttribute("aria-expanded") === "true"')
  await wait(by('v3-mcp-app-refresh'), '!el.closest("[inert]")')
  await sleep(300)
  const panel = by('caps-settings')
  check('展开高级设置，Blender 仍只列一次', await evalJs(`(document.querySelector('${panel}').textContent.match(/Blender/g) ?? []).length === 1`))
  check('旧服务分组已移除，Blender 配置原样保留', await count(by('caps-mcp-server')) === 0 && await readFile(hostPath, 'utf8') === hostFixture)
  await cdp.shot('mcp-single-list', evidence)
  await click('mcp-scope-project')
  await wait(list, 'el.textContent.includes("inkstone-minecraft")')
  check('当前项目仍可覆盖 Minecraft', await evalJs(`document.querySelector('${list}').textContent.includes('inkstone-minecraft')`))
  const packagePath = join(status.status.pluginDir, 'package.json')
  const installedPackage = JSON.parse(await readFile(packagePath, 'utf8'))
  await writeFile(packagePath, JSON.stringify({ ...installedPackage, version: '0.1.1' }))
  await evalJs(`window.__yanStore.getState().openSettings('market')`)
  await wait(by('caps-minecraft-install'), '!el.disabled && /^(更新|Update)$/.test(el.textContent.trim())')
  check('有新版时只留更新，不重复展示旧目录版本', await count(by('caps-minecraft-check')) === 0 && await evalJs(`(document.querySelector('${by('caps-market-minecraft')}').textContent.match(/0\\.1\\.1/g) ?? []).length === 1`))
  await cdp.shot('minecraft-update-available', evidence)
}
