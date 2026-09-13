#!/usr/bin/env node
/**
 * 外部 Chrome 的端到端冒烟：启动一个**无头** Chrome（独立 profile + 调试端口），
 * 用 RawCdp 连上去，跑一遍「导航 → 观察 → 点击」，验证外部浏览器这条通道真的通。
 *
 * 为什么用无头：测试不该弹出一个真窗口、也不该要求用户登录。
 * 这里验证的是**通道与算法**（CDP 连接 + observer + input），
 * 与真实登录态无关 —— 登录是用户在独立 profile 里一次性完成的事。
 *
 * 用法： npm run probe:chrome
 *
 * 需要本机装了 Chrome / Chromium（没有就跳过并返回 0，便于 CI）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const outDir = join(root, 'out', 'test')

// 现场编译用到的 TS 模块（主进程构建会把它们打进 index.js，不单独产出）
await import('../../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: [
      'src/main/chrome.ts',
      'src/main/browser/RawCdp.ts',
      'src/main/browser/Observer.ts',
      'src/main/browser/InputController.ts',
      'src/main/browser/ElementRegistry.ts'
    ],
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)

const { findChrome, pickFreePort, launchChrome, stopChrome, defaultProfileDir } = await import(
  '../../out/test/chrome.js'
)
const { RawCdp, waitForCdp, listTargets, pickPageTarget } = await import('../../out/test/browser/RawCdp.js')
const { Observer } = await import('../../out/test/browser/Observer.js')
const { InputController } = await import('../../out/test/browser/InputController.js')
const { ElementRegistry } = await import('../../out/test/browser/ElementRegistry.js')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const exe = findChrome()
if (!exe) {
  console.log('⚠ 本机没有 Chrome / Chromium，跳过（外部浏览器通道需要它才能验证）')
  process.exit(0)
}
console.log(`Chrome: ${exe}`)

const profileRoot = await mkdtemp(join(tmpdir(), 'yan-chrome-'))
const profileDir = defaultProfileDir(profileRoot)
const port = await pickFreePort()
const page = `data:text/html,${encodeURIComponent(
  '<title>yan-chrome-probe</title><button id="b" onclick="document.title=\'clicked-deep\'">Deep Button</button>'
)}`

console.log(`Profile: ${profileDir}`)
console.log(`端口: ${port}`)
const child = launchChrome({ profileDir, port, url: page, headless: true, executable: exe })

let cdp = null
try {
  console.log('\n=== 1. DevTools 端口就绪 ===')
  await waitForCdp(port, 20_000)
  ok(true, '调试端口在超时前就绪')

  const targets = await listTargets(port)
  const first = pickPageTarget(targets)
  ok(!!first?.webSocketDebuggerUrl, '列到了可连接的 page 目标', first ? first.url.slice(0, 40) : '')

  console.log('\n=== 2. RawCdp 连接 + attach ===')
  cdp = new RawCdp(first.webSocketDebuggerUrl)
  await cdp.attach()
  ok(true, 'attach 成功（Page/DOM/Accessibility/Runtime 已开）')
  const shot = await cdp.screenshot()
  ok(shot.length > 0 && shot.subarray(1, 4).toString() === 'PNG', 'Page.captureScreenshot 返回 PNG', `${shot.length} B`)

  console.log('\n=== 3. observer 解析可交互元素 ===')
  const registry = new ElementRegistry()
  const observer = new Observer(cdp, registry)
  const input = new InputController(cdp)
  let observation = await observer.capture(first.url, '')
  const button = observation.elements.find((e) => /deep button/i.test(e.name) || e.role === 'button')
  ok(!!button, '观察到页面上的按钮', button ? `${button.role} ${button.name}` : '')
  ok(observation.title === 'yan-chrome-probe', 'Runtime.evaluate 读到了标题', observation.title)

  console.log('\n=== 4. 点击生效（复用内置浏览器同一套 InputController）===')
  await input.click(registry.resolve(button.ref))
  // 等页面标题被 onclick 改写
  let title = ''
  for (let i = 0; i < 30; i++) {
    await sleep(100)
    observation = await observer.capture('', '')
    title = observation.title
    if (title === 'clicked-deep') break
  }
  ok(title === 'clicked-deep', '点击后标题变成 clicked-deep', `title=${title}`)
} catch (error) {
  fail++
  console.log(`  ✗ 冒烟过程抛错：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await cdp?.detach().catch(() => undefined)
  stopChrome(child)
  // Chrome 退出后 profile 可能还有短暂文件锁，重试删除
  for (let i = 0; i < 5; i++) {
    try {
      await rm(profileRoot, { recursive: true, force: true })
      break
    } catch {
      await sleep(300)
    }
  }
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
