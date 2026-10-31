import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

function installGlobals() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear()
  }
  function ElementShim() {}
  ElementShim.prototype = { focus() {}, blur() {}, addEventListener() {}, removeEventListener() {} }
  globalThis.HTMLElement = ElementShim
  globalThis.Element = ElementShim
  globalThis.Node = ElementShim
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    HTMLElement: ElementShim,
    Element: ElementShim,
    Node: ElementShim,
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    getComputedStyle: globalThis.getComputedStyle,
    screen: { orientation: { angle: 0 } },
    location: { href: 'http://localhost/' }
  }
  globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: {},
    visibilityState: 'visible',
    hasFocus: () => false
  }
}

async function buildBundle(outdir) {
  const here = process.cwd()
  const p = (rel) => join(here, rel).replace(/\\/g, '/')
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import * as General from '${p('src/renderer/src/features/settings/general/index.ts')}'`,
    `import * as Model from '${p('src/renderer/src/features/settings/general/general-model.ts')}'`,
    `import * as i18n from '${p('src/renderer/src/i18n/index.tsx')}'`,
    'export { React, renderToStaticMarkup, General, Model, i18n }'
  ].join('\n')
  const outfile = join(outdir, 'v3-settings-general.bundle.cjs')
  await build({
    stdin: { contents: entry, resolveDir: here, loader: 'tsx' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' }
  })
  return outfile
}

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-settings-general-'))
  const require = createRequire(import.meta.url)

  try {
    const bundle = require(await buildBundle(outdir))
    const { React, renderToStaticMarkup, General, Model, i18n } = bundle
    const { createElement } = React
    const render = (element) => renderToStaticMarkup(element)

    assert.deepEqual(
      Model.GENERAL_LEGACY_MAP,
      { workspace: 'session', devices: 'devices', remote: 'devices', peer: 'devices', about: 'about', status: 'about' },
      '旧 openSettings 页名映射到通用分区'
    )
    ok(!('sound' in Model.GENERAL_LEGACY_MAP), 'sound 仍归外观，不在通用分区重映射')

    assert.equal(Model.bytesText(0), '0 MB')
    assert.equal(Model.bytesText(-1), '0 MB')
    assert.equal(Model.bytesText(1024 ** 2 * 10), '10 MB')
    assert.equal(Model.bytesText(1024 ** 3 * 2), '2.0 GB')
    assert.equal(Model.formatWhen(null, 'never', 'zh-CN'), 'never')
    assert.equal(Model.formatWhen(0, 'never', 'zh-CN'), 'never')
    ok(Model.formatWhen(Date.UTC(2026, 0, 2), 'never', 'zh-CN').length > 0, '合法时间戳格式化为非空本地时间')

    const merged = Model.mergeSound(
      { enabled: false, volume: 0.4, notifications: true, events: { done: true, question: true, error: true } },
      { enabled: true, events: { done: false, error: false } }
    )
    assert.equal(merged.enabled, true)
    assert.equal(merged.volume, 0.4, '未给的事件与音量保持原值')
    assert.deepEqual(merged.events, { done: false, question: true, error: false }, '事件开关逐项合并')

    assert.deepEqual(Model.removeAllowRoot(['a', 'b', 'c'], 'b'), ['a', 'c'])
    assert.deepEqual(Model.removeAllowRoot([], 'x'), [])
    assert.equal(Model.permissionNeedsConfirm('all'), true)
    assert.equal(Model.permissionNeedsConfirm('danger'), false)
    assert.equal(Model.piSourceLabel('bundled'), 'bundled')
    assert.equal(Model.piSourceLabel(undefined), '—')
    const base = { current: '0.10.0', automatic: true, packaged: true, releaseUrl: '' }
    assert.equal(Model.updatePercent({ ...base, phase: 'downloading', percent: 42.6 }), 43, '下载进度取整')
    assert.equal(Model.updatePercent({ ...base, phase: 'downloading' }), 0, '刚开始下载时进度为 0')
    assert.equal(Model.updatePercent({ ...base, phase: 'downloading', percent: 180 }), 100, '进度不超过 100')
    assert.equal(Model.updatePercent({ ...base, phase: 'available', percent: 50 }), null, '不在下载时不显示进度')
    assert.equal(Model.updatePercent(null), null)
    assert.equal(Model.updateStatusDetail({ ...base, phase: 'downloading', latest: '0.11.0', percent: 42.6 }), '0.11.0 · 43%', '下载中显示目标版本与百分比')
    assert.equal(Model.updateStatusDetail({ ...base, phase: 'available', latest: '0.11.0' }), '0.11.0', '有新版本时显示版本号')
    assert.equal(Model.updateStatusDetail({ ...base, phase: 'error', error: 'GitHub HTTP 403' }), 'GitHub HTTP 403', '失败时显示原因')
    assert.equal(Model.updateStatusDetail({ ...base, phase: 'current', latest: '0.10.0' }), '', '已是最新时不重复版本号')
    assert.equal(Model.GENERAL_LEGACY_MAP.workspace, 'session')

    const zh = General.generalText('zh-CN')
    localStorage.setItem('yan.lang', 'zh-CN')

    const rootsHtml = render(
      createElement(General.AllowRootsList, {
        roots: ['C:/a', 'D:/b'],
        emptyText: 'empty',
        removeText: 'rem',
        onRemove: () => {}
      })
    )
    ok(rootsHtml.includes('data-testid="v3-security-roots"') && rootsHtml.includes('C:/a') && rootsHtml.includes('D:/b'), '允许目录列表渲染全部条目')
    const rootsEmpty = render(
      createElement(General.AllowRootsList, { roots: [], emptyText: 'empty', removeText: 'rem', onRemove: () => {} })
    )
    ok(rootsEmpty.includes('data-testid="v3-security-roots-empty"') && rootsEmpty.includes('empty'), '空允许目录显示空态')

    const devicesHtml2 = render(
      createElement(General.DeviceList, {
        devices: [
          { id: 'd1', name: 'Pixel', kind: 'phone', createdAt: 1000, lastSeenAt: 2000, revokedAt: null },
          { id: 'd2', name: 'Old', kind: 'phone', createdAt: 900, lastSeenAt: null, revokedAt: 3000 }
        ],
        busy: false,
        text: zh,
        lang: 'zh-CN',
        onRevoke: () => {},
        onForget: () => {}
      })
    )
    ok(devicesHtml2.includes('data-testid="v3-device"') && devicesHtml2.includes('Pixel'), '设备列表渲染有效设备')
    ok(devicesHtml2.includes('data-state="revoked"') && devicesHtml2.includes('Old'), '已撤销设备单独渲染')

    const factsHtml = render(createElement(General.StorageFacts, { info: null, text: zh }))
    ok(factsHtml.includes('data-testid="v3-data-location-loading"'), '数据位置为空时显示加载')
    const factsReal = render(
      createElement(General.StorageFacts, {
        text: zh,
        info: { agentDir: 'C:/agent', realDir: 'C:/data', relocated: false, movable: true, bytes: 1024 ** 2 * 12 }
      })
    )
    ok(factsReal.includes('data-testid="v3-data-location"') && factsReal.includes('12 MB'), '数据位置显示真实路径与体积')

    console.log(`\nv3-settings-general: ${checks} checks passed`)
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

await main()
