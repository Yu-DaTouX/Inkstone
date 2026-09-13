import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve('.')
const sandbox = mkdtempSync(join(tmpdir(), 'yan-ui-review-'))
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>布局验证</title><style>body{margin:0;font:16px Segoe UI,sans-serif;color:#223044;background:#eef3f8}main{padding:18px}h1{font-size:22px}article{background:white;border:1px solid #ccd6e0;border-radius:6px;padding:12px;margin:12px 0;overflow-wrap:anywhere}small{color:#54657a}</style><main><small>YAN · LOCAL PREVIEW</small><h1>浏览器尺寸验证</h1><article>页面跟随右侧面板宽度重新排版。</article><article>拖动分隔条，可调整浏览器与工具区的比例。</article><small>本地测试页面 · 不使用真实账户</small></main>')
})
await new Promise((resolve) => server.listen(38417, '127.0.0.1', resolve))
try {
  for (const size of ['1440x900', '940x620']) {
    const base = join(sandbox, size)
    for (const name of ['data', 'pi', 'sessions', 'userData']) mkdirSync(join(base, name), { recursive: true })
    writeFileSync(join(base, 'data', 'desktop.json'), JSON.stringify({ cwd: root, lang: 'zh-CN', uiScale: 1 }))
    const out = resolve('docs/design/preview', `sidebar-review-${size}.png`)
    const env = { ...process.env, YAN_PI_DIR: join(base, 'pi'), YAN_DATA_DIR: join(base, 'data'), YAN_SESSIONS_DIR: join(base, 'sessions'), YAN_USER_DATA: join(base, 'userData'), YAN_CHROME_SYNC: '0', YAN_PROBE: resolve('scripts/probe/sidebar-review.js'), YAN_PROBE_DELAY: '6000', YAN_WIN: size }
    delete env.ELECTRON_RUN_AS_NODE
    let captured = false
    let output = ''
    const child = spawn(resolve('node_modules/electron/dist/electron.exe'), ['.'], { env, cwd: root, windowsHide: true })
    const onData = (data) => {
      output += data.toString()
      if (!captured && output.includes('SIDEBAR_REVIEW_READY')) {
        captured = true
        const cap = spawnSync('powershell.exe', ['-NoProfile', '-File', resolve('scripts/capture-review-window.ps1'), '-ReviewProcessId', String(child.pid), '-OutputPath', out], { windowsHide: true, encoding: 'utf8' })
        if (cap.status !== 0) { console.error(cap.stderr); captured = false }
        else console.log(`Native screenshot: ${out}`)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => child.kill(), 45000)
    await new Promise((resolve) => child.once('exit', resolve))
    clearTimeout(timer)
    const marker = output.match(/SIDEBAR_REVIEW_READY[^\r\n]*/)
    console.log(`${size}: ${marker?.[0] ?? output.slice(-1800)}`)
    if (!captured || !output.includes('Sidebar review: hierarchy')) process.exitCode = 1
  }
} finally { server.close() }
