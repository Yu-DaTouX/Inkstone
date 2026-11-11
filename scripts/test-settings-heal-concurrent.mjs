#!/usr/bin/env node
import fsPromises, { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const ELECTRON_STUB = `
export const app = {
  getLocale: () => 'zh-CN',
  getPath: () => process.env.YAN_TEST_DOCS_PATH
}
`

await runSuite(import.meta.url, async (ok, compile) => {
  const temp = await mkdtemp(join(tmpdir(), 'yan-settings-heal-'))
  process.env.YAN_PI_DIR = join(temp, 'pi')
  process.env.YAN_DATA_DIR = join(temp, 'data')
  process.env.YAN_TEST_DOCS_PATH = join(temp, 'documents')
  await mkdir(process.env.YAN_TEST_DOCS_PATH, { recursive: true })
  await mkdir(process.env.YAN_DATA_DIR, { recursive: true })
  const { getSettings, patchSettings } = await compile('src/main/settings.ts', {
    plugins: [{
      name: 'settings-electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'settings-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'settings-stub' }, () => ({ contents: ELECTRON_STUB, loader: 'js' }))
      }
    }]
  })
  const file = join(process.env.YAN_DATA_DIR, 'desktop.json')
  const realRead = fsPromises.readFile
  let waiting = []
  fsPromises.readFile = async (path, ...rest) => {
    const text = await realRead(path, ...rest)
    if (String(path) !== file) return text
    await new Promise((release) => {
      waiting.push(release)
      if (waiting.length >= 2) {
        const all = waiting
        waiting = []
        for (const fn of all) fn()
      } else {
        setTimeout(() => {
          const all = waiting
          waiting = []
          for (const fn of all) fn()
        }, 150)
      }
    })
    return text
  }
  syncBuiltinESMExports()
  const backups = async () => (await readdir(process.env.YAN_DATA_DIR)).filter((name) => name.startsWith('desktop.json.corrupt-'))

  await writeFile(file, '{ broken', 'utf8')
  const results = await Promise.all([getSettings(), getSettings(), getSettings()])
  ok(results.every((value) => value && typeof value.cwd === 'string'), '并发三次 getSettings 读坏文件都成功，没有误报拒绝覆盖')
  const names = await backups()
  ok(names.length === 1 && (await readFile(join(process.env.YAN_DATA_DIR, names[0]), 'utf8')) === '{ broken', '坏文件只备份一次且原文保留')
  ok(results[0] !== results[1] && results[0].profile !== results[1].profile, '并发调用各拿独立快照')
  results[0].profile.name = 'mutated'
  ok((await getSettings()).profile.name !== 'mutated', '修改返回值不污染缓存')

  await writeFile(file, '[]', 'utf8')
  const patched = await Promise.all([patchSettings({ theme: 'light' }), getSettings()])
  ok(patched[0].theme === 'light' && patched[1] && (await backups()).length === 2, '读修复与补丁并发也只备份一次并成功写入')
  ok(JSON.parse(await readFile(file, 'utf8')).theme === 'light', '补丁已落盘')
})
