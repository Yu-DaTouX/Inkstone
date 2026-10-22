import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { ARTIFACT_KINDS, pickStyles, readRecent, rememberStyles } = await import(pathToFileURL('resources/yan-cli/artifact-style.mjs').href)

let passed = 0
const ok = (value, label) => {
  if (!value) throw new Error(`artifact style: ${label}`)
  passed++
}

const deck = JSON.parse(readFileSync('resources/skills/artifact/styles.json', 'utf8'))
const ids = new Set()
for (const card of deck) {
  ok(typeof card.id === 'string' && !ids.has(card.id), `unique id ${card.id}`)
  ids.add(card.id)
  ok(card.theme === 'light' || card.theme === 'dark', `${card.id} has one theme`)
  ok(Array.isArray(card.kinds) && card.kinds.every((kind) => ARTIFACT_KINDS.includes(kind)), `${card.id} uses known kinds`)
  ok(['bg', 'surface', 'ink', 'muted', 'accent'].every((key) => /^#[0-9a-f]{6}$/i.test(card.colors?.[key] ?? '')), `${card.id} has hex colors`)
  ok(Array.isArray(card.colors.series) && card.colors.series.length >= 4, `${card.id} has chart series`)
  ok(['display', 'body', 'numeric'].every((key) => typeof card.fonts?.[key] === 'string' && /(serif|sans-serif|monospace|cursive|system-ui)\s*$/.test(card.fonts[key])), `${card.id} font stacks end with a generic family`)
  ok(!JSON.stringify(card).match(/https?:|@import|googleapis/), `${card.id} stays offline`)
}
ok(deck.length >= 14, 'deck has enough cards')
for (const kind of ARTIFACT_KINDS) ok(deck.filter((card) => card.kinds.includes(kind)).length >= 5, `kind ${kind} has at least 5 cards`)
ok(deck.some((card) => card.theme === 'light') && deck.some((card) => card.theme === 'dark'), 'deck has both light and dark cards')

let seed = 7
const random = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % n
}
const three = pickStyles(deck, { kind: 'dashboard', count: 3, random })
ok(three.length === 3 && new Set(three.map((card) => card.id)).size === 3, 'draws three distinct cards')
ok(three.every((card) => card.kinds.includes('dashboard')), 'draw respects the kind')
ok(three.some((card) => card.theme === 'light') && three.some((card) => card.theme === 'dark'), 'draw mixes light and dark when possible')
const recent = three.map((card) => card.id)
const next = pickStyles(deck, { kind: 'dashboard', count: 3, recent, random })
ok(next.every((card) => !recent.includes(card.id)), 'recently drawn cards are skipped while enough remain')
const darkOnly = pickStyles(deck, { kind: 'landing', theme: 'dark', count: 3, random })
ok(darkOnly.length === 3 && darkOnly.every((card) => card.theme === 'dark'), 'theme filter keeps only that theme')
const everything = pickStyles(deck, { kind: 'dashboard', count: 3, recent: deck.map((card) => card.id), random })
ok(everything.length === 3, 'falls back to the full pool when every card was recent')

const scratch = mkdtempSync(join(tmpdir(), 'yan-style-'))
try {
  const file = join(scratch, 'recent.json')
  ok(readRecent(file).length === 0, 'missing recent file reads as empty')
  rememberStyles(file, ['a', 'b'], [])
  const merged = rememberStyles(file, ['c', 'a'], readRecent(file))
  ok(merged.join(',') === 'c,a,b', 'recent list keeps newest first without duplicates')
  ok(rememberStyles(file, ['1', '2', '3', '4', '5', '6', '7', '8', '9'], merged).length === 8, 'recent list is capped')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const env = { ...process.env, TMP: tmpdir(), YAN_CLI_URL: '', YAN_CLI_TOKEN: '' }
const cli = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'artifact', 'style', '--kind', 'poster'], { encoding: 'utf8', env })
const payload = JSON.parse(cli.stdout)
ok(cli.status === 0 && payload.ok && payload.styles.length === 3, 'yan artifact style works without the host service')
const byId = JSON.parse(spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'artifact', 'style', '--id', deck[0].id], { encoding: 'utf8', env }).stdout)
ok(byId.ok && byId.styles[0].id === deck[0].id, 'yan artifact style --id returns that card')
const byName = JSON.parse(spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'artifact', 'style', '--id', deck[1].name], { encoding: 'utf8', env }).stdout)
ok(byName.ok && byName.styles[0].id === deck[1].id, 'yan artifact style --id accepts the Chinese name')
const listed = JSON.parse(spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'artifact', 'style', '--list'], { encoding: 'utf8', env }).stdout)
ok(listed.ok && listed.styles.length === deck.length && !listed.styles[0].colors, 'yan artifact style --list gives a compact catalog')
const unknown = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'artifact', 'style', '--id', 'nope'], { encoding: 'utf8', env })
ok(unknown.status === 1 && JSON.parse(unknown.stdout).error === 'unknown_style', 'unknown card id fails clearly')

console.log(`artifact style: ${passed} checks passed`)
