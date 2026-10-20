import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-smooth-text-'))
const compiled = await mkdtemp(resolve('node_modules/.inkstone-smooth-text-'))
const env = { ...process.env }
let checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++ }
const electronStub = { name: 'electron-stub', setup(b) {
  b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app={getLocale:()=> 'zh-CN',getPath:()=> ${JSON.stringify(root)}}`, loader: 'js' }))
} }
try {
  process.env.YAN_DATA_DIR = root
  process.env.YAN_PI_DIR = join(root, 'pi')
  await mkdir(process.env.YAN_PI_DIR)
  const bundle = async (entry, name) => {
    const outfile = join(compiled, name)
    await build({ entryPoints: [entry], outfile, bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent', plugins: [electronStub] })
    return import(pathToFileURL(outfile).href)
  }
  const { smoothTextEnabledSync } = await bundle('src/main/early-switches.ts', 'early-switches.mjs')
  const file = join(root, 'probe.json')
  check(smoothTextEnabledSync(join(root, 'missing.json')) === false, 'missing settings file keeps LCD text')
  for (const [body, want, label] of [
    ['{}', false, 'unset preference keeps LCD text'],
    ['{"smoothText":false}', false, 'explicit off keeps LCD text'],
    ['{"smoothText":"true"}', false, 'non-boolean value keeps LCD text'],
    ['{"smoothText":true}', true, 'explicit on disables LCD text'],
    ['﻿{"smoothText":true}', true, 'BOM-prefixed file is read'],
    ['not json', false, 'broken file keeps LCD text']
  ]) {
    await writeFile(file, body)
    check(smoothTextEnabledSync(file) === want, label)
  }

  const { getSettings, patchSettings, validateRendererSettingsPatch } = await bundle('src/main/settings.ts', 'settings.mjs')
  check((await getSettings()).smoothText !== true, 'fresh settings default to LCD text')
  const on = await patchSettings(validateRendererSettingsPatch({ smoothText: true }))
  check(on.smoothText === true, 'enabled state returned to renderer')
  check(JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8')).smoothText === true, 'enabled preference persisted')
  const off = await patchSettings(validateRendererSettingsPatch({ smoothText: false }))
  check(off.smoothText !== true, 'disabled state returned to renderer')
  check(JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8')).smoothText === undefined, 'disabled preference falls back to default')
  for (const raw of ['true', 1, {}, null]) check((await patchSettings({ smoothText: raw })).smoothText !== true, 'invalid value normalizes to off')
  console.log(`smooth-text-settings: ${checks} checks passed`)
} finally {
  await rm(compiled, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
}
