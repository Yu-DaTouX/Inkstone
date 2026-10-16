#!/usr/bin/env node
/**
 * v3 内置浏览器边界回归（R3）。
 *
 * 只用纯函数 + 一个内存桥，验证三件事：
 *   · owner：`active=false` / 资源归别人 / 未打开时 **不能**驱动原生浏览器；
 *   · visibility：叠加既有 `shouldShowBrowser` 后，overlay 遮挡时不可见，遮挡解除后归还；
 *   · rect：占位区裁剪、半像素量化、签名去重、归属切换后重发。
 *
 * 不启动 Electron、不打开真实网页、不读用户 profile、不调用模型。
 * 用法：node scripts/test-v3-browser.mjs
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/* 把被测的纯模块合成一个虚拟入口，经 esbuild 转成可 import 的 ESM。 */
const entry = [
  "export * from './src/renderer/src/features/browser/ownership.ts'",
  "export * from './src/renderer/src/features/browser/bounds.ts'",
  "export * from './src/renderer/src/features/browser/overlay.ts'",
  "export * from './src/renderer/src/state/browser-visibility.ts'"
].join('\n')

const built = await build({
  stdin: {
    contents: entry,
    resolveDir: ROOT,
    sourcefile: 'v3-browser-test-entry.ts',
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)
const {
  browserControlAllowed,
  browserNativeVisible,
  BrowserBoundsSync,
  BrowserSurfaceClaim,
  nativeBoundsFor,
  boundsSignature,
  boundsArea,
  hasBlockingOverlay,
  shouldShowBrowser,
  OverlayBlockers
} = mod

/* ------------------------------------------------------------------ 断言 */

let pass = 0
let fail = 0
function ok(cond, label, detail) {
  if (cond) {
    pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    fail += 1
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : `  ← 实际: ${JSON.stringify(detail)}`}\n`)
  }
}
function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}

const rect = { left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100 }
const owner = (over = {}) => ({ key: 'k1', sessionId: 's1', cwd: '/work', active: true, ...over })

/* ------------------------------------------------------------ owner 门禁 */

group('owner 门禁：只有活动且资源归属一致才能控制')
{
  const base = { owner: owner(), visible: true, browserOpen: true, browserOwnerKey: 'k1' }
  ok(browserControlAllowed(base) === true, '活动 + 持有 + 打开 + 可见 → 可控制')

  ok(browserControlAllowed({ ...base, owner: owner({ active: false }) }) === false, 'active=false 不能控制')
  ok(browserControlAllowed({ ...base, browserOwnerKey: 'k2' }) === false, '资源归别的会话时不能控制')
  ok(browserControlAllowed({ ...base, browserOwnerKey: undefined }) === false, '资源无主时不认作可控制')
  ok(browserControlAllowed({ ...base, browserOpen: false }) === false, '浏览器未打开时不控制')
  ok(browserControlAllowed({ ...base, visible: false }) === false, '面板隐藏时不控制')
}

/* -------------------------------------------------------- 可见性 / 遮挡 */

group('可见性：叠加既有 shouldShowBrowser，overlay 遮挡时隐藏、解除后归还')
{
  const base = { owner: owner(), visible: true, browserOpen: true, browserOwnerKey: 'k1' }
  ok(browserNativeVisible(base, false) === true, '无遮挡 → 原生层可见')
  ok(browserNativeVisible(base, true) === false, '有 overlay blocker → 原生层隐藏')
  ok(
    browserNativeVisible({ ...base, owner: owner({ active: false }) }, false) === false,
    'active=false 即使没有遮挡也不可见'
  )
  ok(
    browserNativeVisible({ ...base, browserOwnerKey: 'k2' }, false) === false,
    '资源归别人时不显示这条会话的浏览器'
  )
  ok(
    shouldShowBrowser({ browserOpen: true, rightPanelOpen: true, activeBrowserSurface: true, overlayBlockers: 0 }) ===
      true,
    '复用既有协调器：所有输入成立才可见'
  )

  const blockers = new OverlayBlockers()
  blockers.acquire('browser-overlay')
  blockers.acquire('browser-overlay')
  blockers.release('browser-overlay')
  ok(blockers.has('browser-overlay') === true, '同一 token 嵌套领取需全部释放')
  blockers.release('browser-overlay')
  ok(blockers.has('browser-overlay') === false, '释放后遮挡解除')
}

/* ------------------------------------------------- 分屏多列：surface 认领 */

group('分屏多列：非活动列挂载时不能覆盖活动列的原生表面')
{
  const claim = new BrowserSurfaceClaim()
  ok(claim.claim('k1') === true, '活动列认领成功')
  ok(claim.claim('k2') === false, '另一列（owner.active=false）不能抢')
  ok(claim.current() === 'k1', '持有者仍是活动列')
  ok(claim.release('k2') === false, '非持有者释放不生效')
  ok(claim.current() === 'k1', '活动列的原生表面没有被误清')
  ok(claim.release('k1') === true, '持有者释放后清空')
  ok(claim.claim('k2') === true, '活动列退出后新列可以认领')
}

/* ------------------------------------------------------------ overlay 检测 */

group('overlay 检测：只认注入 query 的结果，不碰焦点')
{
  ok(hasBlockingOverlay(() => false) === false, '没有浮层节点 → 不领取 blocker')
  ok(hasBlockingOverlay((selector) => selector.includes('dialog')) === true, '有 dialog 选择器 → 领取 blocker')
}

/* -------------------------------------------------------------- 坐标 rect */

group('坐标：裁剪、半像素量化与签名')
{
  ok(
    JSON.stringify(nativeBoundsFor(rect, null)) === JSON.stringify({ x: 10, y: 20, width: 200, height: 100 }),
    '无裁剪时与占位区一致'
  )

  const clip = { left: 50, top: 0, right: 300, bottom: 60, width: 250, height: 60 }
  ok(
    JSON.stringify(nativeBoundsFor(rect, clip)) === JSON.stringify({ x: 50, y: 20, width: 160, height: 40 }),
    '占位区 ∩ 滚动裁剪区'
  )

  const out = nativeBoundsFor(rect, { left: 0, top: 0, right: 400, bottom: 10, width: 400, height: 10 })
  ok(boundsArea(out) === 0, '完全滚出裁剪区时面积归零（面板据此隐藏原生层）')

  const frac = nativeBoundsFor(
    { left: 10.24, top: 20.26, right: 210.26, bottom: 120.24, width: 200.02, height: 99.98 },
    null
  )
  ok(frac.x === 10 && frac.y === 20.5 && frac.width === 200 && frac.height === 100, '量化到半像素网格', frac)
  ok(boundsSignature(frac) === '10,20.5,200,100', '签名稳定，供去重使用')
}

/* --------------------------------------------------- 内存桥：同步 / 去重 */

group('内存桥：几何不变不重复发坐标，reset 后重发')
{
  const calls = []
  const sync = new BrowserBoundsSync({ setBounds: (bounds) => calls.push(bounds) })
  sync.sync(rect, null)
  ok(calls.length === 1, '首帧发送一次坐标')
  sync.sync(rect, null)
  ok(calls.length === 1, '相同坐标不重复发 IPC')
  sync.sync(rect, { left: 50, top: 0, right: 300, bottom: 60, width: 250, height: 60 })
  ok(calls.length === 2, '几何变化时才再发')
  sync.reset()
  sync.sync(rect, null)
  ok(calls.length === 3, '归属/显隐切换后 reset 强制重发')
  ok(sync.sync(null, null) === null, '量不到占位区时返回 null')
}

/* -------------------------------------------- 边界流程：inactive 不动原生层 */

group('边界流程：active=false 不驱动原生层，active 时才发坐标')
{
  const base = { owner: owner(), visible: true, browserOpen: true, browserOwnerKey: 'k1' }

  const inactive = { ...base, owner: owner({ active: false }) }
  const visibleCalls = []
  let boundsWhenInactive = 0
  if (browserControlAllowed(inactive)) {
    new BrowserBoundsSync({ setBounds: () => (boundsWhenInactive += 1) }).sync(rect)
  }
  visibleCalls.push(browserNativeVisible(inactive, false))
  ok(boundsWhenInactive === 0, 'inactive 时不发 setBounds')
  ok(visibleCalls[0] === false, 'inactive 时原生层不可见')

  const boundsCalls = []
  if (browserControlAllowed(base)) new BrowserBoundsSync({ setBounds: (b) => boundsCalls.push(b) }).sync(rect)
  ok(boundsCalls.length === 1, 'active 且持有资源时才发坐标')
}

process.stdout.write(`\n${fail === 0 ? '✓' : '✗'} v3 浏览器边界：${pass} 通过，${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
