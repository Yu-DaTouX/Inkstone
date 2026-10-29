import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createPetEventTranslator } from '../integrations/desktop-pet/events.mjs'
import { startDesktopPetEdgeFix, desktopPetEdgeStatus, cancelDesktopPetEdgeFix } from '../integrations/desktop-pet/edges.mjs'

const buildDir = join('.tmp', 'full-audit-1022', 'F6')
await mkdir(buildDir, { recursive: true })
const dir = await mkdtemp(join(buildDir, 'desktop-pet-'))
try {
  const bundle = join(dir, 'desktop-pet.mjs')
  const electronStub = join(dir, 'electron-stub.mjs')
  await writeFile(
    electronStub,
    [
      'export const app = { getPath: () => process.cwd(), isPackaged: false, on: () => {}, whenReady: async () => {}, getVersion: () => "0.0.0" }',
      'export const nativeTheme = { shouldUseDarkColors: false, on: () => {} }',
      'export const shell = { openPath: async () => "" }',
      'export const BrowserWindow = class {}',
      'export const ipcMain = { on: () => {}, handle: () => {} }',
      'export default { app }'
    ].join('\n')
  )
  await build({
    entryPoints: ['integrations/desktop-pet/controller.mjs'],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: { electron: resolve(electronStub) },
    logLevel: 'silent'
  })
  process.env.INKSTONE_DATA_ROOT = resolve(dir)
  process.env.INKSTONE_PLUGIN_DATA = resolve(dir, 'plugin-data')
  const pet = await import(pathToFileURL(bundle).href)

  const source = {
    PATH: 'C:\\Windows\\system32',
    PATHEXT: '.COM;.EXE',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    USERPROFILE: 'C:\\Users\\someone',
    LANG: 'zh_CN.UTF-8',
    DEEPSEEK_API_KEY: 'sk-secret',
    OPENAI_API_KEY: 'sk-secret',
    YAN_REMOTE_TOKEN: 'token',
    GITHUB_TOKEN: 'ghp-secret',
    ELECTRON_RUN_AS_NODE: undefined,
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NODE_OPTIONS: '--require ./inject.js'
  }
  const env = pet.desktopPetEnv(source)

  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'USERPROFILE', 'LANG']) {
    assert.equal(env[key], source[key], `保留必需的环境变量：${key}`)
  }
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'YAN_REMOTE_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS']) {
    assert.equal(key in env, false, `不把宿主环境里的密钥或注入变量传给桌宠：${key}`)
  }
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false, '由 launch 自己按需设置，不从宿主继承')

  const empty = pet.desktopPetEnv({ PATH: '', LANG: undefined })
  assert.deepEqual(empty, {}, '空值不写进环境，避免 fork 收到空字符串路径')

  const translator = createPetEventTranslator()
  const run = phase => ({ runId: 'r1', sessionId: 's1', kind: 'session', phase })
  const translate = phase => translator.translate({ upsert: [run(phase)], remove: [] }).map(item => item.event.type)
  assert.deepEqual(translate({ kind: 'running', activity: 'thinking' }), ['turn/start'])
  assert.deepEqual(translate({ kind: 'running', activity: 'tool', tool: { callId: 'c1', name: 'read' } }), ['tool/call'])
  assert.deepEqual(translate({ kind: 'needs-you', request: { id: 'a1', summary: '等待用户处理' } }), ['approval/asked'])
  assert.deepEqual(translate({ kind: 'done' }), ['turn/end'])
  assert.deepEqual(translate({ kind: 'done' }), [])
  translate({ kind: 'running', activity: 'thinking' })
  assert.equal(translator.translate({ upsert: [], remove: ['r1'] })[0].event.data.reason.kind, 'aborted')
  assert.deepEqual(translator.translate({ upsert: [{ ...run({ kind: 'running' }), kind: 'subagent' }], remove: [] }), [])
  startDesktopPetEdgeFix({ ffmpeg: null, version: 'fixture', sourceDir: dir, targetDir: join(dir, 'edges'), workDir: join(dir, 'work'), log: () => {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(desktopPetEdgeStatus().state, 'skipped')
  await cancelDesktopPetEdgeFix()
  console.log('test-desktop-pet: 环境隔离、运行态翻译、无 ffmpeg 退回全部通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
