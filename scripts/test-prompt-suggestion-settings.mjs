import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const compiled = await mkdtemp(resolve('node_modules/.inkstone-suggestion-settings-'))
const env = { ...process.env }
let checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++ }

async function loadSettings(root, tag) {
  process.env.YAN_DATA_DIR = root
  process.env.YAN_PI_DIR = join(root, 'pi')
  await mkdir(process.env.YAN_PI_DIR, { recursive: true })
  const outfile = join(compiled, `settings-${tag}.mjs`)
  await build({ entryPoints: ['src/main/settings.ts'], outfile, bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'electron-stub', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app={getLocale:()=> 'zh-CN',getPath:()=> ${JSON.stringify(root)}}`, loader: 'js' }))
  } }] })
  return import(pathToFileURL(outfile).href)
}

const roots = []
try {
  const cases = [
    { tag: 'legacy-off', disk: { wrapUpCard: false }, expect: false, label: '旧版关掉了收尾决策卡：升级后预测下一句同样关闭' },
    { tag: 'legacy-on', disk: { wrapUpCard: true }, expect: undefined, label: '旧版开着决策卡：预测下一句按默认开启' },
    { tag: 'fresh', disk: {}, expect: undefined, label: '新安装：预测下一句默认开启' },
    { tag: 'explicit-on', disk: { wrapUpCard: false, promptSuggestions: true }, expect: undefined, label: '已经明确打开过新开关时，不被旧的关闭覆盖' }
  ]
  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `inkstone-suggestion-${item.tag}-`))
    roots.push(root)
    await writeFile(join(root, 'desktop.json'), JSON.stringify(item.disk))
    const { getSettings, patchSettings } = await loadSettings(root, item.tag)
    const settings = await getSettings()
    check(settings.promptSuggestions === item.expect, item.label)
    check(!('wrapUpCard' in settings), `${item.label}：旧键不再出现在设置里`)
    if (item.tag === 'legacy-off') {
      await patchSettings({ theme: 'dark' })
      const disk = JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8'))
      check(disk.promptSuggestions === false && !('wrapUpCard' in disk), '写回磁盘时把关闭状态落到新键，旧键删除')
    }
  }
  console.log(`prompt-suggestion-settings: ${checks} checks passed`)
} finally {
  await rm(compiled, { recursive: true, force: true })
  for (const root of roots) await rm(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
}
