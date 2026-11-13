import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`  ok  ${label}`)
}
const eq = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label)
  checks++
  console.log(`  ok  ${label}`)
}

const dir = await mkdtemp(join(tmpdir(), 'inkstone-ext-widget-'))
try {
  const uiFile = join(dir, 'ui-requests.mjs')
  await build({
    entryPoints: ['src/main/ui-requests.ts'],
    outfile: uiFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
  const { UiRequests } = await import(pathToFileURL(uiFile).href)
  const pushes = []
  const ui = new UiRequests({ push: (message) => pushes.push(message), respondToPi: () => {} })
  const widgetPush = (payload) => {
    pushes.length = 0
    ui.handleUi({ id: 'w', method: 'setWidget', ...payload })
    return pushes.at(-1)
  }

  eq(
    widgetPush({ widgetKey: 'k', widgetLines: ['a'] }),
    { ch: 'widget', payload: { key: 'k', lines: ['a'], placement: 'aboveEditor' } },
    '缺省 placement 归一为 aboveEditor'
  )
  eq(
    widgetPush({ widgetKey: 'k', widgetLines: ['a'], widgetPlacement: 'belowEditor' }),
    { ch: 'widget', payload: { key: 'k', lines: ['a'], placement: 'belowEditor' } },
    'belowEditor 原样保留'
  )
  eq(
    widgetPush({ widgetKey: 'k', widgetLines: ['a'], widgetPlacement: 'aboveEditor' }),
    { ch: 'widget', payload: { key: 'k', lines: ['a'], placement: 'aboveEditor' } },
    '显式 aboveEditor 保留'
  )
  eq(
    widgetPush({ widgetKey: 'k', widgetLines: ['a'], widgetPlacement: 'sideways' }),
    { ch: 'widget', payload: { key: 'k', lines: ['a'], placement: 'aboveEditor' } },
    '未知位置回退 aboveEditor'
  )
  eq(
    widgetPush({ widgetLines: ['a'] }),
    { ch: 'widget', payload: { key: 'ext', lines: ['a'], placement: 'aboveEditor' } },
    '缺省 key 为 ext'
  )
  eq(
    widgetPush({ widgetKey: 'k' }),
    { ch: 'widget', payload: { key: 'k', lines: undefined, placement: 'aboveEditor' } },
    '清空（无 lines）仍带位置，lines 为 undefined'
  )
  eq(
    widgetPush({ widgetKey: 'k', widgetLines: 'not-an-array' }),
    { ch: 'widget', payload: { key: 'k', lines: undefined, placement: 'aboveEditor' } },
    '非数组 lines 视为清空'
  )
  eq(
    widgetPush({ widgetKey: 'k', widgetLines: [1, 'b'] }),
    { ch: 'widget', payload: { key: 'k', lines: ['1', 'b'], placement: 'aboveEditor' } },
    'lines 逐项转成字符串'
  )

  const storeFile = join(dir, 'store.mjs')
  await build({
    entryPoints: ['src/renderer/src/state/store.ts'],
    outfile: storeFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  globalThis.window = { yan: {} }
  globalThis.document = { documentElement: { lang: 'zh-CN' }, hasFocus: () => true }
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const { useStore } = await import(pathToFileURL(storeFile).href)

  eq(useStore.getState().widgetPlacements, {}, 'store 初始 widgetPlacements 为空')

  const runtimeFile = join(dir, 'runtime.mjs')
  await build({ entryPoints:['src/renderer/src/state/session-runtime.ts'],outfile:runtimeFile,bundle:true,platform:'node',format:'esm',logLevel:'silent' })
  const { reduceSessionRuntime } = await import(pathToFileURL(runtimeFile).href)
  const runtimeA = {runId:'a',sessionId:'sa',generation:1,projectId:null,cwd:'a'}
  const runtimeB = {runId:'b',sessionId:'sb',generation:1,projectId:null,cwd:'b'}
  let map = reduceSessionRuntime({},runtimeA,{ch:'widget',payload:{key:'k',lines:['A'],placement:'belowEditor'}})
  eq(map.sa.widgetPlacements.k,'belowEditor','真实推送 reducer 保存位置')
  map = reduceSessionRuntime(map,runtimeB,{ch:'widget',payload:{key:'k',lines:['B']}})
  eq(map.sa.widgetPlacements.k,'belowEditor','后台另一会话不覆盖已有位置')
  eq(map.sb.widgetPlacements.k,'aboveEditor','另一会话缺省位置归上方')
  const stale = reduceSessionRuntime(map,{...runtimeA,generation:0},{ch:'widget',payload:{key:'k',lines:['STALE'],placement:'aboveEditor'}})
  eq(stale.sa.widgets.k,['A'],'旧 generation 的组件推送不覆盖当前内容')
  map = reduceSessionRuntime(map,runtimeA,{ch:'widget',payload:{key:'k'}})
  eq(map.sa.widgets,{},'清空真实组件内容')
  eq(map.sa.widgetPlacements,{},'清空真实组件位置缓存')

  console.log(`extension-widget-placement: ${checks} focused checks passed`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
