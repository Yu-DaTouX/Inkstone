import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MOD, click, press } from '../lib/review-kit.mjs'

export const meta = { description: '摩擦记录器：开关、连点自动记录、Ctrl+Alt+F 记录、私密内容不进录像、关闭后不再记录' }

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, newSession }) {
  const ev = (expr) => cdp.evaluate(expr)
  const root = join(box.dataDir, 'friction')
  const records = () => (existsSync(root) ? readdirSync(root).filter((n) => n !== '_player').sort() : [])
  report.frictionDir = root

  await newSession(box.project)
  await ev(`window.__yanStore.getState().send('MDREAL')`)
  await waitFor(`!window.__yanStore.getState().session?.isStreaming && window.__yanStore.getState().messages.length >= 2`, 60000, 100)

  await press(cdp, 'F', { modifiers: MOD.ctrl | MOD.alt, waitMs: 1500 })
  check('关闭时快捷键不记录', records().length === 0, records().join(','))

  await ev(`window.__yanStore.getState().patchSettings({ frictionRecorder: true })`)
  await sleep(2500)

  await ev(`(() => {
    const box = document.createElement('div');
    box.setAttribute('data-friction-private', '');
    box.textContent = 'PRIVATE-MARK-7Q';
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999';
    const pw = document.createElement('input');
    pw.type = 'password';
    pw.setAttribute('data-testid', 'friction-pw');
    pw.style.cssText = 'position:fixed;left:8px;bottom:40px;z-index:99999';
    document.body.append(box, pw);
    pw.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(pw, 'PW-MARK-3Z');
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    pw.blur();
  })()`)
  await sleep(600)

  for (let i = 0; i < 3; i++) await click(cdp, '[data-testid="friction-pw"]', { waitMs: 120 })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && !records().some((n) => n.endsWith('-rage-click'))) await sleep(200)
  check('连点自动记录一次', records().some((n) => n.endsWith('-rage-click')), records().join(','))

  await press(cdp, 'F', { modifiers: MOD.ctrl | MOD.alt, waitMs: 300 })
  const toastDeadline = Date.now() + 6000
  while (Date.now() < toastDeadline && !records().some((n) => n.endsWith('-hotkey'))) await sleep(200)
  const hotkey = records().find((n) => n.endsWith('-hotkey'))
  check('Ctrl+Alt+F 记录一次', !!hotkey, records().join(','))
  check('记录后有提示', await ev(`document.body.innerText.includes('已记录刚才的界面问题') || document.body.innerText.includes('Recorded what just happened')`))
  await shot('friction-toast')

  if (hotkey) {
    const dir = join(root, hotkey)
    const files = readdirSync(dir).sort()
    report.hotkeyFiles = files
    check('记录包含事件、元数据和回放页', ['events.js', 'meta.json', 'replay.html'].every((f) => files.includes(f)), files.join(','))
    check('界面上有私密元素时不截整窗图', !files.includes('shot.png'), files.join(','))
    const events = readFileSync(join(dir, 'events.js'), 'utf8')
    const metaJson = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    report.hotkeyMeta = { events: metaJson.events, bytes: events.length, marks: metaJson.marks.map((m) => m.kind), route: metaJson.context.route }
    check('录到了完整快照与后续事件', metaJson.events > 5 && events.includes('"type":2'), String(metaJson.events))
    check('时间轴带触发标记', metaJson.marks.some((m) => m.kind === 'hotkey') && events.includes('"tag":"friction"'))
    check('标记为私密的元素文字不进录像', !events.includes('PRIVATE-MARK-7Q'))
    check('密码框内容不进录像', !events.includes('PW-MARK-3Z'))
    check('对话内容在录像里（可回放）', events.length > 20000, String(events.length))
    check('播放器文件已就位', existsSync(join(root, '_player', 'rrweb-player.js')) && existsSync(join(root, '_player', 'rrweb-player.css')))
    report.replay = join(dir, 'replay.html')
  }

  await ev(`document.querySelectorAll('[data-friction-private], [data-testid="friction-pw"]').forEach((el) => el.remove())`)
  await sleep(300)
  const beforeClean = records().length
  await press(cdp, 'F', { modifiers: MOD.ctrl | MOD.alt, waitMs: 300 })
  const cleanDeadline = Date.now() + 6000
  while (Date.now() < cleanDeadline && records().length === beforeClean) await sleep(200)
  const clean = records().filter((n) => n.includes('-hotkey')).pop()
  await sleep(1500)
  check('没有私密元素时附整窗截图', !!clean && existsSync(join(root, clean, 'shot.png')), clean)

  const gapFrom = Date.now()
  await ev(`window.__yanStore.getState().send('LONGTEXT')`)
  await waitFor(`!window.__yanStore.getState().session?.isStreaming && window.__yanStore.getState().messages.length >= 4`, 90000, 200)
  await sleep(Math.max(1500, 21000 - (Date.now() - gapFrom)))
  check('贴底流式输出不触发滚动跳变', !records().some((n) => n.endsWith('-scroll-jump')), records().join(','))
  const jumpFrom = await ev(`(() => { const s = document.querySelector('.v3-stream'); const from = s.scrollTop; s.scrollTop = Math.max(0, from - 600); return { from, to: s.scrollTop, height: s.scrollHeight, viewport: s.clientHeight } })()`)
  report.scrollJump = jumpFrom
  const jumpDeadline = Date.now() + 6000
  while (Date.now() < jumpDeadline && !records().some((n) => n.endsWith('-scroll-jump'))) await sleep(200)
  const jumpDir = records().find((n) => n.endsWith('-scroll-jump'))
  check('无操作时消息流大幅跳动自动记录', !!jumpDir, JSON.stringify(jumpFrom))
  if (jumpDir) {
    const jumpMeta = JSON.parse(readFileSync(join(root, jumpDir, 'meta.json'), 'utf8'))
    report.scrollJumpMeta = { detail: jumpMeta.detail, marks: jumpMeta.marks.map((m) => m.kind) }
    check('跳变记录写明起止位置和滚动区', /\d+->\d+.*v3-stream/.test(String(jumpMeta.detail ?? '')), jumpMeta.detail)
  }

  await ev(`window.__yanStore.getState().patchSettings({ frictionRecorder: false })`)
  await sleep(800)
  const before = records().length
  await press(cdp, 'F', { modifiers: MOD.ctrl | MOD.alt, waitMs: 2500 })
  check('关闭后快捷键不再记录', records().length === before, records().join(','))

  await ev(`window.__yanStore.getState().openSettings()`)
  await sleep(1200)
  await ev(`document.querySelector('[data-testid="v3-settings-nav-about"]')?.click()`)
  await sleep(900)
  check('关于页有记录开关', await ev(`!!document.querySelector('[data-testid="v3-friction-toggle"]')`))
  check('关闭时不显示打开文件夹', await ev(`!document.querySelector('[data-testid="v3-friction-open"]')`))
  await ev(`document.querySelector('[data-setting-id="about-friction"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(300)
  await click(cdp, '[data-testid="v3-friction-toggle"]', { waitMs: 700 })
  check('点开关后设置打开', await ev(`window.__yanStore.getState().settings?.frictionRecorder === true`))
  check('打开时显示打开文件夹', await ev(`!!document.querySelector('[data-testid="v3-friction-open"]')`))
  await ev(`document.querySelector('[data-setting-id="about-friction"]')?.scrollIntoView({ block: 'center' })`)
  for (const theme of ['dark', 'light']) {
    await ev(`window.__yanStore.getState().patchSettings({ theme: '${theme}' })`)
    await sleep(600)
    await shot(`friction-setting-${theme}`)
  }
}
