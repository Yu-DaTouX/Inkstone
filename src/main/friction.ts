import { app, type WebContents } from 'electron'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { YAN_DIR } from './paths'
import {
  FRICTION_LIMITS,
  frictionDirName,
  sanitizeFrictionRequest,
  selectFrictionPrune,
  type FrictionCaptureResult,
  type FrictionEntry
} from '../shared/friction'

export const FRICTION_DIR = join(YAN_DIR, 'friction')
const PLAYER_DIR_NAME = '_player'
const PLAYER_FILES = [
  ['rrweb-player.umd.min.cjs', 'rrweb-player.js'],
  ['style.min.css', 'rrweb-player.css']
] as const

function playerSourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'friction-player')
    : join(app.getAppPath(), 'node_modules', 'rrweb-player', 'dist')
}

async function ensurePlayer(root: string): Promise<void> {
  const target = join(root, PLAYER_DIR_NAME)
  await mkdir(target, { recursive: true })
  const source = playerSourceDir()
  for (const [from, to] of PLAYER_FILES) {
    const src = join(source, from)
    const dst = join(target, to)
    if (!existsSync(src)) continue
    const [a, b] = await Promise.all([stat(src), stat(dst).catch(() => null)])
    if (!b || a.size !== b.size) await copyFile(src, dst)
  }
}

const FONT_MIME: Record<string, string> = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' }
const FONT_BUDGET_BYTES = 24 * 1024 * 1024

function rendererAssetsDir(contents: WebContents): string | null {
  try {
    const url = typeof contents.getURL === 'function' ? contents.getURL() : ''
    return url.startsWith('file:') ? join(dirname(fileURLToPath(url)), 'assets') : null
  } catch {
    return null
  }
}

export async function embedFonts(urls: readonly string[], assetsDir: string | null): Promise<Record<string, string>> {
  const fonts: Record<string, string> = {}
  if (!assetsDir) return fonts
  let budget = FONT_BUDGET_BYTES
  for (const url of urls) {
    let file: string
    try {
      file = fileURLToPath(url)
    } catch {
      continue
    }
    const name = basename(file)
    const mime = FONT_MIME[extname(name).toLowerCase()]
    if (!mime || fonts[name] || relative(assetsDir, file) !== name) continue
    const data = await readFile(file).catch(() => null)
    if (!data || data.length > budget) continue
    budget -= data.length
    fonts[name] = `data:${mime};base64,${data.toString('base64')}`
  }
  return fonts
}

export function replayHtml(title: string, withFonts = false): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title.replace(/[<&>]/g, '')}</title>
<link rel="stylesheet" href="../${PLAYER_DIR_NAME}/rrweb-player.css">
<style>body{margin:0;background:#1b1b1d;color:#ddd;font:13px system-ui,sans-serif}#meta{padding:8px 12px}#player{display:flex;justify-content:center;padding:8px}</style>
</head>
<body>
<div id="meta"></div>
<div id="player"></div>
<script src="../${PLAYER_DIR_NAME}/rrweb-player.js"></script>
<script src="events.js"></script>${withFonts ? '\n<script src="fonts.js"></script>' : ''}
<script>
const meta = window.__FRICTION_META__ || {}
const fonts = window.__FRICTION_FONTS__ || {}
const recorded = window.__FRICTION_EVENTS__ || []
const events = Object.keys(fonts).length
  ? JSON.parse(JSON.stringify(recorded).replace(/file:\\/\\/\\/[^"'()\\s\\\\]*\\/([^\\/"'()\\s\\\\]+\\.(?:woff2?|ttf|otf))/gi, (m, name) => fonts[name] || m))
  : recorded
document.getElementById('meta').textContent = [meta.reason, meta.detail, meta.savedAt].filter(Boolean).join(' · ')
const Player = window.rrwebPlayer && (window.rrwebPlayer.default || window.rrwebPlayer)
const vp = (meta.context && meta.context.viewport) || {}
const scale = Math.min(1, (window.innerWidth - 32) / (vp.width || 1280))
new Player({
  target: document.getElementById('player'),
  props: {
    events,
    width: Math.round((vp.width || 1280) * scale),
    height: Math.round((vp.height || 800) * scale),
    autoPlay: false,
    showDebug: false,
    tags: { friction: '#e5484d' }
  }
})
</script>
</body>
</html>
`
}

async function dirBytes(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[])
  const sizes = await Promise.all(names.map((name) => stat(join(dir, name)).then((s) => (s.isFile() ? s.size : 0)).catch(() => 0)))
  return sizes.reduce((sum, n) => sum + n, 0)
}

export async function pruneFriction(root: string = FRICTION_DIR, now: number = Date.now()): Promise<string[]> {
  const names = (await readdir(root).catch(() => [] as string[])).filter((name) => name !== PLAYER_DIR_NAME)
  const entries: FrictionEntry[] = []
  for (const name of names) {
    const dir = join(root, name)
    const info = await stat(dir).catch(() => null)
    if (!info?.isDirectory()) continue
    entries.push({ name, mtimeMs: info.mtimeMs, bytes: await dirBytes(dir) })
  }
  const drop = selectFrictionPrune(entries, now)
  await Promise.all(drop.map((name) => rm(join(root, name), { recursive: true, force: true }).catch(() => undefined)))
  return drop
}

export async function saveFrictionCapture(
  contents: WebContents,
  raw: unknown,
  enabled: boolean,
  root: string = FRICTION_DIR
): Promise<FrictionCaptureResult> {
  if (!enabled) return { ok: false, error: 'disabled' }
  const req = sanitizeFrictionRequest(raw)
  if (!req) return { ok: false, error: 'invalid' }
  const eventsText = JSON.stringify(req.events)
  if (eventsText.length > FRICTION_LIMITS.maxRequestChars) return { ok: false, error: 'too-large' }
  const savedAt = new Date()
  const base = join(root, frictionDirName(savedAt, req.reason))
  let dir = base
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`
  await mkdir(dir, { recursive: true })
  const meta = {
    reason: req.reason,
    detail: req.detail,
    marks: req.marks,
    context: { ...req.context, fonts: undefined },
    version: app.getVersion(),
    savedAt: savedAt.toISOString(),
    events: req.events.length
  }
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  await writeFile(join(dir, 'events.js'), `window.__FRICTION_META__ = ${JSON.stringify(meta)};\nwindow.__FRICTION_EVENTS__ = ${eventsText};\n`)
  const fonts = await embedFonts(req.context.fonts ?? [], rendererAssetsDir(contents)).catch(() => ({}))
  const withFonts = Object.keys(fonts).length > 0
  if (withFonts) await writeFile(join(dir, 'fonts.js'), `window.__FRICTION_FONTS__ = ${JSON.stringify(fonts)};\n`)
  await writeFile(join(dir, 'replay.html'), replayHtml(`${req.reason} ${meta.savedAt}`, withFonts))
  const shot = req.context.privateVisible ? null : await contents.capturePage().catch(() => null)
  if (shot && !shot.isEmpty()) await writeFile(join(dir, 'shot.png'), shot.toPNG())
  await ensurePlayer(root).catch(() => undefined)
  void pruneFriction(root).catch(() => undefined)
  return { ok: true, dir }
}
