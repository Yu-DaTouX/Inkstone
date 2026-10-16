import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const root = await mkdtemp(join(tmpdir(), 'inkstone-loop-settings-'))
const compiled = await mkdtemp(resolve('node_modules/.inkstone-loop-settings-'))
const env = { ...process.env }
let checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++ }
try {
  process.env.YAN_DATA_DIR = root
  process.env.YAN_PI_DIR = join(root, 'pi')
  await mkdir(process.env.YAN_PI_DIR)
  const outfile = join(compiled, 'settings.mjs')
  await build({ entryPoints: ['src/main/settings.ts'], outfile, bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'electron-stub', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app={getLocale:()=> 'zh-CN',getPath:()=> ${JSON.stringify(root)}}`, loader: 'js' }))
  } }] })
  const { getSettings, patchSettings, validateRendererSettingsPatch } = await import(pathToFileURL(outfile).href)
  check((await getSettings()).streamLoopAutoContinue !== false, 'old or missing setting defaults enabled')
  check((await patchSettings({ streamLoopAutoContinue: false })).streamLoopAutoContinue === false, 'literal false stays disabled')
  for (const raw of [true, undefined, null, 'false', 0, {}, []]) check((await patchSettings({ streamLoopAutoContinue: raw })).streamLoopAutoContinue !== false, 'default-on normalization for invalid or enabled value')
  const off = validateRendererSettingsPatch({ streamLoopAutoContinue: false })
  check(off.streamLoopAutoContinue === false, 'renderer setting is allow-listed')
  await patchSettings({ autoArchiveDays: 7 })
  const disabled = await patchSettings(off)
  check(disabled.streamLoopAutoContinue === false, 'disabled state returned to renderer')
  check(disabled.autoArchiveDays === 7, 'unrelated setting preserved')
  const diskOff = JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8'))
  check(diskOff.streamLoopAutoContinue === false, 'explicit disabled preference persisted')
  const enabled = await patchSettings(validateRendererSettingsPatch({ streamLoopAutoContinue: true }))
  check(enabled.streamLoopAutoContinue !== false, 're-enabled state returned')
  const diskOn = JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8'))
  check(diskOn.streamLoopAutoContinue !== false, 'enabled preference persisted or uses enabled default')
  check(diskOn.autoArchiveDays === 7, 'toggle did not overwrite existing archive preference')
  console.log(`stream-loop-settings: ${checks} checks passed`)
} finally {
  await rm(compiled, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
}
