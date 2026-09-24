/**
 * 原生视图与浮层遮挡的**真实窗口**截图（实施-11 H-9a / 实施-12 U-6 残余）。
 *
 * 为什么不能用矩阵的 `capturePage()`：内置浏览器是主进程的 `WebContentsView`，
 * 它不进渲染进程的截图 —— 矩阵图里那一块是空的，看不出“谁盖住谁”。
 * 这里走 OS 级窗口捕获（`capture-review-window.ps1`，PrintWindow + 全内容），
 * 产出的图里网页与浮层都在，才能真的看图判断遮挡关系。
 *
 * 两个 phase：
 *   · browser  —— 浏览器是活动页、没有浮层：原生网页应当可见（正向对照）
 *   · settings —— 打开设置浮层：原生网页应当让位，面板完整可见（遮挡结论）
 *
 * 用法：node scripts/capture-native-overlay.mjs
 */
import './lib/stdio-guard.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve('.')
const electron = createRequire(import.meta.url)('electron')
const PORT = 38418
const SIZE = '1440x900'
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')

/* 页面配色刻意与砚的主题撞色差很大：一眼就能看出“网页到底可见不可见” */
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(
    '<!doctype html><meta charset="utf-8"><title>native overlay fixture</title>' +
      '<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;' +
      'background:repeating-linear-gradient(45deg,#ffd166 0 40px,#ef476f 40px 80px);' +
      'font:700 34px/1.4 Segoe UI,sans-serif;color:#073b4c}</style>' +
      '<div>原生网页可见（斜纹背景）</div>'
  )
})
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok))

const sandbox = mkdtempSync(join(tmpdir(), 'yan-native-overlay-'))
let child = null
try {
  const base = join(sandbox, SIZE)
  for (const name of ['data', 'pi', 'sessions', 'userData']) mkdirSync(join(base, name), { recursive: true })
  writeFileSync(join(base, 'data', 'desktop.json'), JSON.stringify({ cwd: root, lang: 'zh-CN', uiScale: 1 }))

  const env = {
    ...process.env,
    YAN_PI_DIR: join(base, 'pi'),
    YAN_DATA_DIR: join(base, 'data'),
    YAN_SESSIONS_DIR: join(base, 'sessions'),
    YAN_USER_DATA: join(base, 'userData'),
    YAN_CHROME_SYNC: '0',
    YAN_PROBE: resolve('scripts/probe/native-overlay.js'),
    YAN_PROBE_DELAY: '4000',
    YAN_WIN: SIZE
  }
  delete env.ELECTRON_RUN_AS_NODE

  child = spawn(electron, ['.'], { env, cwd: root, windowsHide: true })

  const shots = { browser: 0, settings: 0 }
  let output = ''
  const capture = (phase) => {
    const out = resolve('docs/design/preview', `native-overlay-${SIZE}-${phase}-${stamp}.png`)
    const res = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-File', resolve('scripts/capture-review-window.ps1'), '-ReviewProcessId', String(child.pid), '-OutputPath', out],
      { windowsHide: true, encoding: 'utf8' }
    )
    if (res.status !== 0) {
      console.error(`✗ ${phase} 截图失败：${res.stderr}`)
      return
    }
    shots[phase]++
    console.log(`原生截图（${phase}）：${out}`)
  }
  const onData = (data) => {
    const text = data.toString()
    output += text
    for (const phase of Object.keys(shots)) {
      /* 每个 phase 只认第一次出现（探针里每个 phase 只发一次） */
      if (shots[phase] === 0 && output.includes(`NATIVE_OVERLAY_READY phase=${phase}`)) capture(phase)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const timer = setTimeout(() => child?.kill(), 90_000)
  await new Promise((ok) => child.once('exit', ok))
  clearTimeout(timer)

  const marker = output.match(/NATIVE_OVERLAY_DONE[^\r\n]*/)
  console.log(marker?.[0] ?? output.slice(-1200))
  if (shots.browser !== 1 || shots.settings !== 1) {
    console.error(`✗ 期望 browser / settings 各一张截图，实际 ${JSON.stringify(shots)}`)
    process.exitCode = 1
  }
} finally {
  server.close()
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 尽力而为 */
  }
}
