import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { ARTIFACT_KINDS, pickStyles, readRecent, rememberStyles, runArtifactStyle } = await import(pathToFileURL('resources/yan-cli/artifact-style.mjs').href)
const { parseTreeIds, listRemoteSystems, pullRemoteSystem, designRoot } = await import(pathToFileURL('resources/yan-cli/design-remote.mjs').href)

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

const COMMIT = '61ab0f2a6dbfea20a1010b841d7f5234c69327b4'
const RAW = `https://raw.githubusercontent.com/nexu-io/open-design/${COMMIT}/`
const TREE_URL = `https://api.github.com/repos/nexu-io/open-design/git/trees/${COMMIT}?recursive=1`
const cliPath = join(process.cwd(), 'resources', 'yan-cli', 'yan.mjs')

const remoteTree = {
  tree: [
    { path: 'design-systems/editorial/manifest.json', type: 'blob' },
    { path: 'design-systems/brutalism/manifest.json', type: 'blob' },
    { path: 'design-systems/clay/manifest.json', type: 'blob' },
    { path: 'design-systems/brutalism/DESIGN.md', type: 'blob' },
    { path: 'design-systems/README.md', type: 'blob' },
    { path: 'design-systems/_schema/AGENTS.md', type: 'blob' }
  ]
}

const remoteManifests = {
  'design-systems/brutalism/manifest.json': {
    id: 'brutalism',
    name: 'Brutalism',
    category: 'Bold & Expressive',
    description: 'Concrete, loud, deliberately raw.'
  },
  'design-systems/editorial/manifest.json': {
    id: 'editorial',
    name: 'Editorial',
    category: 'Creative & Artistic',
    description: 'Magazine grid with quiet type.'
  },
  'design-systems/clay/manifest.json': {}
}

const remoteFiles = {
  'design-systems/brutalism/DESIGN.md': '# Brutalism\n\n## Color\n\n- Primary: #dd614c\n',
  'design-systems/brutalism/tokens.css': ':root {\n  --bg: #f5f1e8;\n}\n',
  'design-systems/editorial/DESIGN.md': '# Editorial\n\n## Type\n\n- Serif body.\n'
}

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body })

function fakeNet({ tree = remoteTree, manifests = remoteManifests, files = remoteFiles } = {}) {
  const calls = []
  const fetch = async (url) => {
    calls.push(url)
    if (url === TREE_URL) return reply(200, JSON.stringify(tree))
    if (url.startsWith(RAW)) {
      const path = url.slice(RAW.length)
      if (manifests[path] !== undefined) return reply(200, JSON.stringify(manifests[path]))
      if (files[path] !== undefined) return reply(200, files[path])
    }
    return reply(404, 'not found')
  }
  return { fetch, calls }
}

const offline = async () => {
  throw new Error('artifact style: this call must stay offline')
}

const rejection = async (run) => {
  try {
    await run()
    return null
  } catch (err) {
    return err
  }
}

const remoteScratch = mkdtempSync(join(tmpdir(), 'yan-design-remote-'))
try {
  const root = join(remoteScratch, 'data')
  ok(
    designRoot({ YAN_DATA_DIR: remoteScratch }) === join(remoteScratch, 'design-systems', COMMIT.slice(0, 12)),
    'remote cache lives under the data directory keyed by commit'
  )
  ok(parseTreeIds(remoteTree).join(',') === 'brutalism,clay,editorial', 'remote tree keeps only design-systems manifest paths')

  const net = fakeNet()
  const listed = await listRemoteSystems({ requestImpl: net.fetch, root })
  ok(listed.ok && listed.count === 3 && listed.total === 3, 'remote list parses the catalog')
  ok(
    listed.systems[0].id === 'brutalism' && listed.systems[0].name === 'Brutalism' && listed.systems[0].category === 'Bold & Expressive',
    'remote list reads name and category from manifest.json'
  )
  ok(listed.systems[0].description.includes('Concrete'), 'remote list reads the description from manifest.json')
  ok(listed.systems[1].id === 'clay' && listed.systems[1].name === 'clay', 'manifest without metadata falls back to its id')
  ok(listed.cached === false && net.calls.length === 4, 'first remote list fetches the tree plus one manifest each')

  const again = await listRemoteSystems({ requestImpl: offline, root })
  ok(again.ok && again.cached === true && again.count === 3, 'remote list reuses the cached catalog without network')
  const filtered = await listRemoteSystems({ requestImpl: offline, root, query: 'creative' })
  ok(filtered.count === 1 && filtered.systems[0].id === 'editorial', 'remote list filters by --query')
  ok((await listRemoteSystems({ requestImpl: offline, root, query: 'zzz' })).count === 0, 'remote list query without hits is still ok')

  const brokenList = await rejection(() => listRemoteSystems({ requestImpl: offline, root: join(remoteScratch, 'broken-list') }))
  ok(brokenList?.code === 'remote_unreachable' && /连不上/.test(brokenList.message), 'network failure while listing fails in Chinese')
  const stalledList = await rejection(() =>
    listRemoteSystems({ requestImpl: () => new Promise(() => {}), timeoutMs: 30, root: join(remoteScratch, 'stalled-list') })
  )
  ok(stalledList?.code === 'remote_timeout' && /超时/.test(stalledList.message), 'remote list times out with a clear message')
  const partialRoot = join(remoteScratch, 'partial')
  const partialNet = fakeNet({
    manifests: { 'design-systems/brutalism/manifest.json': remoteManifests['design-systems/brutalism/manifest.json'] },
    files: remoteFiles
  })
  const partial = await listRemoteSystems({ requestImpl: partialNet.fetch, root: partialRoot })
  ok(partial.ok && partial.count === 1 && partial.failed?.join(',') === 'clay,editorial', 'manifests that cannot be fetched are reported, not dropped silently')
  const partialAgain = await rejection(() => listRemoteSystems({ requestImpl: offline, root: partialRoot }))
  ok(partialAgain?.code === 'remote_unreachable', 'a partial catalog is rebuilt instead of cached')

  for (const bad of ['../brutalism', 'Brutalism', 'a b', '', 'brut/alism', 'brutalism\u0000']) {
    const rejected = await pullRemoteSystem({ id: bad, requestImpl: offline, root })
    ok(rejected.ok === false && rejected.error === 'invalid_remote_id', `remote id ${JSON.stringify(bad)} is rejected before any download`)
  }

  const pulled = await pullRemoteSystem({ id: 'brutalism', requestImpl: fakeNet().fetch, root })
  ok(pulled.ok && pulled.cached === false && pulled.dir === join(root, 'brutalism'), 'remote pull writes into the data directory by id')
  ok(readFileSync(pulled.design, 'utf8').includes('# Brutalism'), 'remote pull saves DESIGN.md')
  ok(pulled.tokens && readFileSync(pulled.tokens, 'utf8').includes('--bg'), 'remote pull saves tokens.css')
  const notice = readFileSync(join(pulled.dir, 'NOTICE.txt'), 'utf8')
  ok(
    notice.includes('nexu-io/open-design') && notice.includes(COMMIT) && notice.includes('Apache-2.0'),
    'NOTICE records repo, commit and Apache-2.0'
  )
  ok(/DESIGN\.md/.test(pulled.note) && /系统字体/.test(pulled.note) && /:root/.test(pulled.note), 'pull output tells the model to read DESIGN.md and use system fonts')

  const cachedPull = await pullRemoteSystem({ id: 'brutalism', requestImpl: offline, root })
  ok(cachedPull.ok && cachedPull.cached === true, 'remote pull reuses the local copy without network')

  const noTokens = await pullRemoteSystem({ id: 'editorial', requestImpl: fakeNet().fetch, root })
  ok(noTokens.ok && !('tokens' in noTokens), 'missing tokens.css is optional')

  const missing = await rejection(() => pullRemoteSystem({ id: 'unknown-one', requestImpl: fakeNet().fetch, root }))
  ok(missing?.code === 'unknown_remote_id' && missing.message.includes('unknown-one') && /--remote list/.test(missing.detail), 'unknown id fails in Chinese and points at --remote list')

  const unreachable = await rejection(() =>
    pullRemoteSystem({ id: 'clay', requestImpl: async () => { throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com') }, root: join(remoteScratch, 'unreachable') })
  )
  ok(unreachable?.code === 'remote_unreachable' && /连不上/.test(unreachable.message), 'network failure while pulling fails in Chinese')

  const stalled = await rejection(() =>
    pullRemoteSystem({ id: 'clay', requestImpl: () => new Promise(() => {}), timeoutMs: 30, root: join(remoteScratch, 'stalled') })
  )
  ok(stalled?.code === 'remote_timeout' && /超时/.test(stalled.message), 'download timeout is reported')

  const project = join(remoteScratch, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'DESIGN.md'), '# Project\n')
  const preferProject = await runArtifactStyle({}, { cwd: project })
  ok(preferProject.ok && preferProject.projectDesign === join(project, 'DESIGN.md') && !preferProject.styles, 'a project DESIGN.md wins over drawing cards')
  ok(/DESIGN\.md/.test(preferProject.note) && /--ignore-project/.test(preferProject.note), 'project DESIGN.md note explains how to override')
  const forced = await runArtifactStyle({ 'ignore-project': true }, { cwd: project })
  ok(forced.ok && forced.styles.length === 3 && !forced.projectDesign, '--ignore-project draws cards again')
  const byCwd = await runArtifactStyle({ cwd: project }, { cwd: remoteScratch })
  ok(byCwd.projectDesign === join(project, 'DESIGN.md'), '--cwd points at the project folder')
  const noDesign = await runArtifactStyle({}, { cwd: remoteScratch })
  ok(noDesign.ok && !noDesign.projectDesign && noDesign.styles.length === 3, 'a folder without DESIGN.md draws cards')

  const remoteWins = await runArtifactStyle({ remote: 'list', cwd: project }, { root, fetch: offline })
  ok(remoteWins.ok && remoteWins.count === 3, '--remote takes precedence over the project DESIGN.md')
  const remoteBad = await runArtifactStyle({ remote: '../etc' }, { root, fetch: offline })
  ok(remoteBad.ok === false && remoteBad.error === 'invalid_remote_id', '--remote rejects unsafe ids')
  const remoteDown = await runArtifactStyle({ remote: 'clay' }, { root: join(remoteScratch, 'remote-down'), fetch: offline })
  ok(remoteDown.ok === false && remoteDown.error === 'remote_unreachable' && /连不上/.test(remoteDown.message), '--remote network failure returns a clear error')

  const cliProjectRun = spawnSync(process.execPath, [cliPath, 'artifact', 'style'], { encoding: 'utf8', env, cwd: project })
  const cliProjectPayload = JSON.parse(cliProjectRun.stdout)
  ok(
    cliProjectRun.status === 0 && cliProjectPayload.projectDesign?.endsWith('DESIGN.md') && !cliProjectPayload.styles,
    'yan artifact style prefers the project DESIGN.md'
  )
  const cliForced = JSON.parse(spawnSync(process.execPath, [cliPath, 'artifact', 'style', '--ignore-project'], { encoding: 'utf8', env, cwd: project }).stdout)
  ok(cliForced.ok && cliForced.styles.length === 3, 'yan artifact style --ignore-project draws cards')
  const cliRemoteMissing = spawnSync(process.execPath, [cliPath, 'artifact', 'style', '--remote'], { encoding: 'utf8', env })
  ok(cliRemoteMissing.status === 1 && JSON.parse(cliRemoteMissing.stdout).error === 'remote_id_required', 'yan artifact style --remote without an id fails clearly')
} finally {
  rmSync(remoteScratch, { recursive: true, force: true })
}

console.log(`artifact style: ${passed} checks passed`)