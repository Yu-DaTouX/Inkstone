import { randomInt } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const ARTIFACT_KINDS = ['poster', 'dashboard', 'game', 'explainer', 'tool', 'landing', 'slides']
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

export function runArtifactStyle(flags) {
  const deck = loadDeck()
  if (!deck?.length) return { ok: false, error: 'style_deck_missing', message: '找不到风格牌（resources/skills/artifact/styles.json）' }
  if (flags.list) {
    return { ok: true, styles: deck.map(({ id, name, mood, theme, kinds }) => ({ id, name, mood, theme, kinds })), note: '用户点名的风格和哪张牌同名或相近，就用 --id 取那张；都不像时按 guides/styles.md 或用户的描述自己定。' }
  }
  if (typeof flags.id === 'string') {
    const wanted = flags.id.trim()
    const card = deck.find((item) => item.id === wanted || item.name === wanted)
    return card ? { ok: true, styles: [card] } : { ok: false, error: 'unknown_style', message: `没有这张风格牌：${flags.id}`, ids: deck.map((item) => item.id) }
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
    note: '从这几张里选最贴合主题与受众的一张，照它的 colors、fonts、type、shape、layout、motifs 写，并遵守 avoid；颜色和字体先写成 :root 里的 CSS 变量。都不合适就再运行一次。回复里用一句话说明用了哪张牌。'
  }
}
