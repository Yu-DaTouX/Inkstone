/**
 * v3 设置「通用分区」（G1：会话 / 通知 / 权限安全 / 设备同步 / 数据 / 关于）的纯本地检查。
 *
 * 不启动 Electron、不连 pi、不读用户设置、不调模型、不联网、不 build：
 *   1. 用 esbuild 编译 `general-model.ts` 的纯逻辑，在 Node 里断言；
 *   2. 用 `react-dom/server` 渲染真实分区组件与展示件（注入假 store 数据），
 *      验证只使用既有字段 / 既有 IPC，不出现假开关；
 *   3. 静态检查源码契约：只走 v3 `ui/` 与真实 store 动作 / IPC，不引入 v2 组件或旧样式，
 *      不新造权限档或授权预算；CSS 落在 features 层。
 *
 * 可独立执行：node scripts/test-v3-settings-general.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

    /* ── 1. 纯逻辑：分区与旧深链接映射 ─────────────────────── */
    assert.deepEqual(
      [...Model.GENERAL_SECTION_ORDER],
      ['session', 'notifications', 'security', 'devices', 'data', 'about'],
      '通用分区顺序按 02 §10.6'
    )
    assert.deepEqual(
      Model.GENERAL_LEGACY_MAP,
      { workspace: 'session', devices: 'devices', remote: 'devices', peer: 'devices', about: 'about', status: 'about' },
      '旧 openSettings 页名映射到通用分区'
    )
    ok(!('sound' in Model.GENERAL_LEGACY_MAP), 'sound 仍归外观，不在通用分区重映射')

    /* ── 2. 纯逻辑：数值与设置归一化 ───────────────────────── */
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
    assert.equal(Model.GENERAL_LEGACY_MAP.workspace, 'session')

    /* ── 3. 文案两语齐全且占位符一致 ───────────────────────── */
    const zh = General.generalText('zh-CN')
    const en = General.generalText('en-US')
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '中英文案键一一对应')
    for (const key of ['sessionAutoArchive', 'notifSystem', 'securityMode', 'devicesEnable', 'dataMove', 'aboutPi']) {
      assert.ok(zh[key] && en[key], `文案键 ${key} 中英都有值`)
    }
    for (const key of Object.keys(zh)) {
      const zhVars = (zh[key].match(/\{(\w+)\}/g) ?? []).sort()
      const enVars = (en[key].match(/\{(\w+)\}/g) ?? []).sort()
      assert.deepEqual(zhVars, enVars, `文案 ${key} 中英占位符一致`)
    }

    /* ── 4. SSR：六个分区只读真实 store 字段 ───────────────── */
    /*
     * 注：zustand 的 `useStore` 在 SSR 用 getInitialState 作为 server snapshot，
     * `setState` 不会影响本次渲染。因此这里只验证组件在真实 store 形状下能渲染、
     * testid 结构稳定；设置值 → 字段的接线由第 6 节静态检查覆盖，
     * 取值边界由第 5 节的纯展示件覆盖。
     */
    localStorage.setItem('yan.lang', 'zh-CN')

    const withProvider = (component) => render(createElement(i18n.I18nProvider, null, createElement(component)))

    const sessionHtml = withProvider(General.SessionSettings)
    ok(sessionHtml.includes('data-testid="v3-session-settings"'), '会话分区有稳定根 testid')
    ok(sessionHtml.includes('data-testid="v3-session-archive-14"'), '自动归档渲染现有 7/14/30 档位')
    ok(sessionHtml.includes('data-testid="v3-session-keep-awake"'), '运行中保持唤醒接现有字段')
    ok(sessionHtml.includes('data-testid="v3-session-checkpoints"'), '检查点接现有字段')
    ok(sessionHtml.includes('data-testid="v3-session-subagent-notify"'), '子 Agent 通知接现有字段')
    ok(!sessionHtml.includes('v3-session-stall-unavailable') && !sessionHtml.includes('停滞判定阈值'), '停滞阈值无后端时不放占位行')

    const notifHtml = withProvider(General.NotificationsSettings)
    ok(notifHtml.includes('data-testid="v3-notifications-settings"'), '通知分区有稳定根 testid')
    ok(notifHtml.includes('data-testid="v3-notif-system"') && notifHtml.includes('data-testid="v3-notif-sound"'), '系统通知与声音总开关接现有 sound 字段')
    ok(notifHtml.includes('data-testid="v3-notif-event-done"') && notifHtml.includes('data-testid="v3-notif-event-error"'), '按事件开关接现有 sound.events')
    ok(notifHtml.includes('data-testid="v3-notif-system-test"'), '系统通知试发走既有 notifyAttention')
    ok(!notifHtml.includes('v3-notif-dnd-unavailable'), '勿扰时段无后端时不放占位行，也不造假开关')

    const securityHtml = withProvider(General.SecuritySettings)
    ok(securityHtml.includes('data-testid="v3-security-settings"'), '权限安全分区有稳定根 testid')
    ok(securityHtml.includes('data-testid="v3-security-mode-danger"') && securityHtml.includes('data-testid="v3-security-mode-all"'), '两档权限来自既有 PERMISSION_MODES')
    ok(securityHtml.includes('data-testid="v3-security-outside"'), '项目外写入保护接现有字段')
    ok(securityHtml.includes('data-testid="v3-security-roots-empty"'), '无允许目录时展示空态，不伪造路径')

    const devicesHtml = withProvider(General.DevicesSettings)
    ok(devicesHtml.includes('data-testid="v3-devices-settings"'), '设备分区有稳定根 testid')
    ok(devicesHtml.includes('data-testid="v3-devices-enable"'), '手机接入开关接现有 remoteAccess.enabled')
    ok(devicesHtml.includes('data-testid="v3-devices-pair"'), '配对入口来自既有 remote.pair')
    ok(devicesHtml.includes('data-testid="v3-devices-empty"'), '未取到设备时不渲染假设备')

    const dataHtml = withProvider(General.DataSettings)
    ok(dataHtml.includes('data-testid="v3-data-settings"'), '数据分区有稳定根 testid')
    ok(dataHtml.includes('data-testid="v3-data-location-loading"'), '首帧未读到时显示加载，不伪造路径')
    ok(dataHtml.includes('data-testid="v3-data-export"'), '会话导出按钮存在且接既有 sync.exportSession')

    const aboutHtml = render(
      createElement(i18n.I18nProvider, null, createElement(General.AboutSettings, { onOpenModels: () => {} }))
    )
    ok(aboutHtml.includes('data-testid="v3-about-settings"'), '关于分区有稳定根 testid')
    ok(aboutHtml.includes('data-testid="v3-about-repo"'), '开源入口按钮存在（无 URL 时禁用）')
    ok(aboutHtml.includes('data-testid="v3-about-pi-redetect"'), 'pi 重新检测走既有 redetectPi')
    ok(aboutHtml.includes('data-testid="v3-about-update-check"'), '更新检查走既有 appUpdate')
    ok(aboutHtml.includes('data-testid="v3-about-models"'), '凭证配置只导航到既有模型页（注入回调时才是真按钮）')

    const aboutNoNav = render(createElement(i18n.I18nProvider, null, createElement(General.AboutSettings)))
    ok(!aboutNoNav.includes('data-testid="v3-about-models"'), '没有导航回调时不摆点不动的假按钮')

    /* ── 5. SSRs：展示件对边界值如实呈现 ───────────────────── */
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

    /* ── 6. 静态接线：真字段 / 真 IPC / 无假开关 ───────────── */
    const dir = join(process.cwd(), 'src/renderer/src/features/settings/general')
    const read = (name) => readFile(join(dir, name), 'utf8')
    const sources = {
      session: await read('SessionSettings.tsx'),
      notif: await read('NotificationsSettings.tsx'),
      security: await read('SecuritySettings.tsx'),
      devices: await read('DevicesSettings.tsx'),
      data: await read('DataSettings.tsx'),
      about: await read('AboutSettings.tsx')
    }
    for (const [name, src] of Object.entries(sources)) {
      assert.ok(src.includes("from '../../../ui'"), `${name} 控件来自 v3 ui/`)
      assert.ok(!src.includes('components/'), `${name} 不引入 v2 组件`)
      assert.ok(!src.includes('styles/'), `${name} 不引入 v2 样式`)
      assert.ok(!/@fontsource/.test(src), `${name} 不引入字体包`)
      assert.ok(!src.includes('checked='), `${name} 不混用 v2 的 checked 属性`)
    }
    const textSrc = await read('general-text.ts')
    const ifaceBlock = textSrc.match(/export interface GeneralText \{([\s\S]*?)\n\}/)
    assert.ok(ifaceBlock, 'GeneralText 接口存在')
    const ifaceKeys = [...ifaceBlock[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort()
    assert.deepEqual(ifaceKeys, Object.keys(zh).sort(), 'GeneralText 接口与中英实现键一致')
    for (const field of ['autoArchiveDays', 'keepAwakeWhileWorking', 'keepAwakeOnBattery', 'checkpointsEnabled', 'subagentNotify']) {
      assert.ok(sources.session.includes(field), `会话分区复用现有字段 ${field}`)
    }
    assert.ok(sources.notif.includes('previewSound') && sources.notif.includes('notifyAttention'), '通知分区复用既有试听与通知 IPC')
    assert.ok(sources.security.includes('PERMISSION_MODES') && sources.security.includes('shared/approval'), '权限分区复用既有档位定义')
    assert.ok(sources.security.includes('guardAllowRoots') && sources.security.includes('guardOutsideWrites'), '权限分区复用现有保护字段')
    assert.ok(sources.devices.includes('window.yan.remote') && sources.devices.includes('window.yan.peer'), '设备分区只调既有 remote / peer IPC')
    assert.ok(sources.data.includes('window.yan.storage') && sources.data.includes('window.yan.backup') && sources.data.includes('window.yan.sync.exportSession'), '数据分区只调既有 storage / backup / sync IPC')
    assert.ok(sources.about.includes('BUILD_INFO') && sources.about.includes('appUpdate') && sources.about.includes('openBrowser'), '关于分区显示真实构建信息并接既有更新 / 浏览器入口')
    for (const bad of ['budget', 'permissionTier', 'authorizationBudget', 'newPermissionMode']) {
      for (const [name, src] of Object.entries(sources)) {
        assert.ok(!src.includes(bad), `${name} 不新造 ${bad}`)
      }
    }

    /* ── 7. CSS 落在 features 层，只做版面 ─────────────────── */
    const css = await readFile(join(dir, 'general.css'), 'utf8')
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
    ok(cssCode.includes('@layer features'), 'CSS 落在 features 层')
    ok(!cssCode.includes('@import') && !/@keyframes/.test(cssCode), 'CSS 不 @import、不自建关键帧')
    ok(!/styles\/|components\//.test(cssCode), 'CSS 不依赖 v2 样式目录')

    console.log(`\nv3-settings-general: ${checks} checks passed`)
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

await main()
