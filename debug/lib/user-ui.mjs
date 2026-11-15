import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readLocalStorage } from './leveldb.mjs'
import { sleep } from './env.mjs'
import { REAL_PI } from './user-data.mjs'

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
export const USER_LOCAL_STORAGE = process.env.YAN_DEBUG_USER_LOCAL_STORAGE || join(APPDATA, 'yan-desktop', 'Local Storage', 'leveldb')
export const USER_FRICTION_DIR = process.env.YAN_DEBUG_USER_FRICTION || join(process.env.YAN_DEBUG_USER_PI || join(homedir(), '.pi', 'agent'), 'yan', 'friction')
const APP_ORIGIN = 'file://'
const KEEP = /^(yan[:.]|inkstone[.:])/
const SKIP = /^(yan\.composerDrafts|yan\.promptStash|yan\.scroll-snapshots|yan\.boot|yan:boot|yan:bootstrap|yan:switch|yan:splash|yan:shell-import|yan:preload-reload|yan:prompt-stash|yan:reduced-motion)/
const WIDTH_KEYS = ['inkstone.v3.sidebarWidth', 'inkstone.v3.tilesWidth']

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathRemapper(box) {
  if (!box) return (value) => value
  const pairs = [[join(REAL_PI, 'sessions'), box.sessionsDir], [join(REAL_PI, 'yan'), box.dataDir], [REAL_PI, box.piDir]]
  const rules = []
  for (const [from, to] of pairs) {
    const forms = [[from, to], [from.replaceAll('\\', '\\\\'), to.replaceAll('\\', '\\\\')], [encodeURIComponent(from), encodeURIComponent(to)], [from.replaceAll('\\', '/'), to.replaceAll('\\', '/')]]
    for (const [a, b] of forms) rules.push([new RegExp(escapeRegExp(a), 'gi'), b])
  }
  return (value) => rules.reduce((text, [pattern, target]) => text.replace(pattern, () => target), value)
}

export function readUserUi({ dir = USER_LOCAL_STORAGE, box = null } = {}) {
  if (!existsSync(dir)) return { values: {}, errors: [`没有 ${dir}`], origin: APP_ORIGIN }
  const { byOrigin, errors } = readLocalStorage(dir, { keep: (name, origin) => origin === APP_ORIGIN && KEEP.test(name) && !SKIP.test(name) })
  const remap = pathRemapper(box)
  const values = Object.fromEntries(Object.entries(byOrigin[APP_ORIGIN] ?? {}).map(([key, value]) => [key, remap(value)]))
  return { values, errors, origin: APP_ORIGIN }
}

function rightPanelWidth(values) {
  try { return JSON.parse(values['inkstone.v3.rightPanel'] ?? 'null')?.width ?? null } catch { return null }
}

export async function maximizeWindow(cdp) {
  await cdp.evaluate('window.yan.win.maximize()').catch(() => {})
  let last = ''
  let steady = 0
  for (let i = 0; i < 60 && steady < 7; i++) {
    await sleep(250)
    const now = await cdp.evaluate('`${innerWidth}x${innerHeight}@${devicePixelRatio}`').catch(() => '')
    steady = now && now === last ? steady + 1 : 0
    last = now
  }
  return cdp.evaluate('({ viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, screen: [screen.width, screen.height], avail: [screen.availWidth, screen.availHeight] })')
}

async function waitReady(until) {
  if (!(await until('true', 30000))) throw new Error('重载后渲染端没有暴露 __yanStore')
  await until('s.conn === "ready"', 60000)
}

async function writeAndReload(cdp, until, values) {
  await cdp.evaluate(`(() => {
    const values = ${JSON.stringify(values)}
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
    const width = (() => { try { return JSON.parse(values['inkstone.v3.rightPanel'] ?? 'null')?.width } catch { return null } })()
    if (typeof width === 'number') window.__yanRightPanel?.getState().setWidth?.(width)
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
    return true
  })()`)
  await sleep(300)
  await cdp.evaluate('location.reload()').catch(() => {})
  await sleep(800)
  await waitReady(until)
  await sleep(1200)
}

export async function measureUi(cdp) {
  return cdp.evaluate(`(() => {
    const root = document.documentElement
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.left), w: Math.round(r.width) } : null }
    const st = window.__yanStore?.getState()
    return {
      viewport: [innerWidth, innerHeight],
      dpr: Math.round(devicePixelRatio * 1000) / 1000,
      theme: root.dataset.theme ?? root.className,
      fontUi: getComputedStyle(document.body).fontFamily.slice(0, 120),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      settings: { theme: st?.settings?.theme, uiScale: st?.settings?.uiScale, density: st?.settings?.density, fontUi: st?.settings?.fontUi, fontSizeBody: st?.settings?.fontSizeBody },
      storage: { sidebarWidth: Number(localStorage.getItem('inkstone.v3.sidebarWidth')), tilesWidth: Number(localStorage.getItem('inkstone.v3.tilesWidth')), rightPanel: window.__yanRightPanel?.getState().width ?? null, homeBackground: (() => { try { const b = JSON.parse(localStorage.getItem('yan:home-background') ?? 'null'); return b ? { mode: b.mode, image: b.image, effect: b.effect, tone: b.tone } : null } catch { return null } })() },
      sidebar: box('[data-testid="v3-sidebar"]'),
      sessionBar: box('[data-testid="v3-sessionbar"]'),
      rightPanel: box('[data-testid="rp"]'),
      session: st?.session?.sessionFile ?? null
    }
  })()`)
}

export async function applyUserUi(cdp, until, { values } = readUserUi()) {
  const window = await maximizeWindow(cdp)
  const wanted = { sidebar: Number(values['inkstone.v3.sidebarWidth'] ?? NaN), tiles: Number(values['inkstone.v3.tilesWidth'] ?? NaN), rightPanel: rightPanelWidth(values) }
  let applied = null
  for (let attempt = 0; attempt < 3; attempt++) {
    await writeAndReload(cdp, until, values)
    applied = await cdp.evaluate(`({ sidebar: Number(localStorage.getItem('inkstone.v3.sidebarWidth')), tiles: Number(localStorage.getItem('inkstone.v3.tilesWidth')), rightPanel: window.__yanRightPanel?.getState().width ?? null, background: localStorage.getItem('yan:home-background') === ${JSON.stringify(values['yan:home-background'] ?? null)} })`)
    const ok = WIDTH_KEYS.every((key) => !values[key] || String(applied[key === WIDTH_KEYS[0] ? 'sidebar' : 'tiles']) === values[key]) && (wanted.rightPanel == null || applied.rightPanel === wanted.rightPanel)
    if (ok) break
  }
  return { keys: Object.keys(values).length, window, wanted, applied }
}

export function listFrictionShots(dir = USER_FRICTION_DIR) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir).sort().reverse()) {
    const shot = join(dir, name, 'shot.png')
    const metaFile = join(dir, name, 'meta.json')
    if (!existsSync(shot) || !existsSync(metaFile)) continue
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
      if (meta.context?.privateVisible) continue
      out.push({ name, dir: join(dir, name), shot, viewport: meta.context?.viewport ?? null, sessionId: meta.context?.sessionId ?? null, route: meta.context?.route ?? null, savedAt: meta.savedAt })
    } catch {}
  }
  return out
}

export function pickFrictionShot(viewport, dir = USER_FRICTION_DIR) {
  const shots = listFrictionShots(dir)
  const near = (v) => v && viewport && Math.abs(v.width - viewport[0]) <= 4 && Math.abs(v.height - viewport[1]) <= 4
  return shots.find((item) => near(item.viewport)) ?? shots.find((item) => item.viewport && item.viewport.width >= 1600) ?? shots[0] ?? null
}

export async function openFrictionSession(cdp, until, sessionId) {
  if (!sessionId) return null
  const path = await cdp.evaluate(`(() => { const list = window.__yanStore.getState().sessions ?? []; const hit = list.find((x) => String(x.path ?? '').includes(${JSON.stringify(sessionId)})); return hit?.path ?? null })()`)
  if (!path) return null
  await cdp.evaluate(`window.__yanStore.getState().switchSession(${JSON.stringify(path)})`)
  await until(`s.session?.sessionFile === ${JSON.stringify(path)}`, 20000)
  await sleep(2500)
  return path
}

export async function composeComparison(cdp, { userShot, instanceShot, out, labels = ['用户窗口（摩擦记录）', '隔离实例'] }) {
  const toUrl = (file) => {
    const buf = readFileSync(file)
    const mime = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  }
  const data = await cdp.evaluate(`(async () => {
    const load = (src) => new Promise((done, fail) => { const img = new Image(); img.onload = () => done(img); img.onerror = fail; img.src = src })
    const [a, b] = await Promise.all([load(${JSON.stringify(toUrl(userShot))}), load(${JSON.stringify(toUrl(instanceShot))})])
    const width = 1600
    const head = 44
    const ha = Math.round(a.naturalHeight * width / a.naturalWidth)
    const hb = Math.round(b.naturalHeight * width / b.naturalWidth)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = head * 2 + ha + hb
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#202020'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#ffffff'
    ctx.font = '600 22px "Segoe UI", "Microsoft YaHei", sans-serif'
    ctx.fillText(${JSON.stringify(labels[0])} + '  ' + a.naturalWidth + '×' + a.naturalHeight, 12, 30)
    ctx.drawImage(a, 0, head, width, ha)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(${JSON.stringify(labels[1])} + '  ' + b.naturalWidth + '×' + b.naturalHeight, 12, head + ha + 30)
    ctx.drawImage(b, 0, head * 2 + ha, width, hb)
    return canvas.toDataURL('image/png').split(',')[1]
  })()`)
  writeFileSync(out, Buffer.from(data, 'base64'))
  return out
}
