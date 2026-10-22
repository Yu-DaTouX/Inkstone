import { randomInt } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { RemoteError, designRoot, listRemoteSystems, pullRemoteSystem } from './design-remote.mjs'

export const ARTIFACT_KINDS = ['poster', 'dashboard', 'game', 'explainer', 'tool', 'landing', 'slides', 'video']
const RECENT_LIMIT = 8

export function deckCandidates(cliDir) {
  return [
    join(cliDir, '..', 'skills', 'artifact', 'styles.json'),
    join(cliDir, '..', 'yan-skills', 'artifact', 'styles.json')
  ]
}

export function loadDeck(cliDir = dirname(fileURLToPath(import.meta.url))) {
  const path = deckCandidates(cliDir).find((candidate) => existsSync(candidate))
  if (!path) return null
  const deck = JSON.parse(readFileSync(path, 'utf8'))
  return Array.isArray(deck) ? deck.filter((card) => card && typeof card.id === 'string') : null
}

const shuffle = (items, random) => {
  const list = items.slice()
  for (let i = list.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

export function pickStyles(deck, { kind, theme, count = 3, recent = [], random = randomInt } = {}) {
  const themed = theme ? deck.filter((card) => card.theme === theme) : deck
  const matching = kind ? themed.filter((card) => Array.isArray(card.kinds) && card.kinds.includes(kind)) : themed
  const pool = matching.length >= count ? matching : themed
  const fresh = pool.filter((card) => !recent.includes(card.id))
  const source = shuffle(fresh.length >= count ? fresh : pool, random)
  const picked = []
  for (const theme of ['light', 'dark']) {
    const card = source.find((item) => item.theme === theme && !picked.includes(item))
    if (card && picked.length < count) picked.push(card)
  }
  for (const card of source) if (picked.length < count && !picked.includes(card)) picked.push(card)
  return shuffle(picked, random)
}

export function readRecent(file) {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

export function rememberStyles(file, ids, previous) {
  const next = [...ids, ...previous.filter((id) => !ids.includes(id))].slice(0, RECENT_LIMIT)
  try {
    writeFileSync(file, JSON.stringify(next))
  } catch {
  }
  return next
}

const PROJECT_DESIGN_NOTE = '项目里有 DESIGN.md：先按它的配色、字体、版式、组件与禁止项做，不要再抽牌，也不用去拉远端设计系统。它没覆盖到的地方才参考随包风格牌；确实要换成随包风格牌时加 --ignore-project 重跑。'

const REMOTE_NOTE = '用 --remote list 看远端设计系统清单（可加 --query 缩小范围），--remote <id> 拉取一套到本机后照它做。'

function projectDesignFile(flags, deps) {
  if (flags['ignore-project'] || flags.ignoreProject) return null
  const base = typeof flags.cwd === 'string' && flags.cwd.trim() ? resolve(flags.cwd.trim()) : deps.cwd ?? process.cwd()
  const file = join(base, 'DESIGN.md')
  return existsSync(file) ? file : null
}

function remoteDeps(deps) {
  return {
    requestImpl: deps.fetch,
    timeoutMs: deps.timeoutMs,
    root: deps.root ?? designRoot(deps.env ?? process.env)
  }
}

async function runRemoteStyle(flags, deps) {
  const remote = flags.remote
  if (remote === true || (typeof remote === 'string' && !remote.trim())) {
    return {
      ok: false,
      error: 'remote_id_required',
      message: '--remote 缺少参数：写 list 看清单，或写设计系统 id（如 brutalism）',
      detail: 'yan artifact style --remote list [--query <词>] / yan artifact style --remote <id>'
    }
  }
  const options = { ...remoteDeps(deps), ...(typeof flags.query === 'string' ? { query: flags.query } : {}) }
  if (remote === 'list') return listRemoteSystems(options)
  try {
    return await pullRemoteSystem({ ...options, id: String(remote) })
  } catch (err) {
    if (err instanceof RemoteError) return { ok: false, error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) }
    throw err
  }
}

export async function runArtifactStyle(flags, deps = {}) {
  const deck = loadDeck()
  if (!deck?.length) return { ok: false, error: 'style_deck_missing', message: '找不到风格牌（resources/skills/artifact/styles.json）' }
  if (flags.remote !== undefined) return runRemoteStyle(flags, deps)
  const projectDesign = projectDesignFile(flags, deps)
  if (flags.list) {
    return {
      ok: true,
      ...(projectDesign ? { projectDesign } : {}),
      styles: deck.map(({ id, name, mood, theme, kinds }) => ({ id, name, mood, theme, kinds })),
      note: projectDesign
        ? PROJECT_DESIGN_NOTE
        : `用户点名的风格和哪张牌同名或相近，就用 --id 取那张；都不像时按 guides/styles.md 或用户的描述自己定。${REMOTE_NOTE}`
    }
  }
  if (projectDesign) return { ok: true, projectDesign, note: PROJECT_DESIGN_NOTE }
  return drawStyle(deck, flags)
}

function drawStyle(deck, flags) {
  if (typeof flags.id === 'string') {
    const wanted = flags.id.trim()
    const card = deck.find((item) => item.id === wanted || item.name === wanted)
    return card ? { ok: true, styles: [card] } : { ok: false, error: 'unknown_style', message: `没有这张风格牌：${flags.id}`, ids: deck.map((item) => item.id), remote: REMOTE_NOTE }
  }
  const kind = typeof flags.kind === 'string' && ARTIFACT_KINDS.includes(flags.kind) ? flags.kind : undefined
  const count = Math.min(5, Math.max(1, Number.parseInt(String(flags.count ?? 3), 10) || 3))
  const recentFile = join(tmpdir(), 'yan-artifact-style-recent.json')
  const recent = readRecent(recentFile)
  const theme = flags.theme === 'light' || flags.theme === 'dark' ? flags.theme : undefined
  const styles = pickStyles(deck, { kind, theme, count, recent })
  rememberStyles(recentFile, styles.map((card) => card.id), recent)
  return {
    ok: true,
    kind: kind ?? 'any',
    ...(theme ? { theme } : {}),
    styles,
    note: '从这几张里选最贴合主题与受众的一张，照它的 colors、fonts、type、shape、layout、motifs 写，并遵守 avoid；颜色和字体先写成 :root 里的 CSS 变量。都不合适就再运行一次。回复里用一句话说明用了哪张牌。用户点名了某个具体设计系统或品牌风格、随包风格牌不够用时，走 --remote。'
  }
}
