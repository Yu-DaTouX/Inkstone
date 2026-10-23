import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')
const HOST_ENV = { YAN_RUNNER_ID: 'r1', YAN_CLI_URL: 'http://127.0.0.1:1', YAN_CLI_TOKEN: 't', YAN_SESSION_ID: 's1', YAN_PROJECT_ID: 'p1' }
let checks = 0
const ok = (value, label) => { assert.ok(value, label); checks++ }
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++ }

function fakePi({ active = ['read', 'bash'] } = {}) {
  const handlers = {}
  const tools = []
  const state = { active: [...active] }
  return {
    handlers,
    tools,
    state,
    pi: {
      on: (event, handler) => { handlers[event] = handler },
      registerTool: (tool) => { tools.push(tool); state.active.push(tool.name) },
      getActiveTools: () => [...state.active],
      getAllTools: () => [...active, ...tools.map((tool) => tool.name)].map((name) => ({ name })),
      setActiveTools: (names) => { state.active = [...names] }
    }
  }
}

async function extensionTests(dataDir) {
  const mod = await import(pathToFileURL(join(ROOT, 'resources/pi-extensions/wrap-up.js')).href)
  const desktop = join(dataDir, 'desktop.json')
  const saved = Object.fromEntries([...Object.keys(HOST_ENV), 'YAN_DATA_DIR'].map((key) => [key, process.env[key]]))
  try {
    for (const key of Object.keys(HOST_ENV)) delete process.env[key]
    process.env.YAN_DATA_DIR = dataDir

    const bare = fakePi()
    mod.default(bare.pi)
    ok(bare.tools.length === 0 && !bare.handlers.before_agent_start, 'no host endpoint: no tool and no prompt hook')

    Object.assign(process.env, HOST_ENV)
    ok(mod.wrapUpEnabled(), 'missing desktop.json defaults to enabled')

    const on = fakePi()
    mod.default(on.pi)
    ok(on.tools.length === 1 && on.tools[0].name === 'wrap_up', 'enabled: registers wrap_up once')
    equal(on.tools[0].parameters.required, ['recap'], 'recap is the only required parameter')
    ok(on.tools[0].parameters.properties.actions.maxItems === 2, 'actions capped at two')
    const sections = {}
    ok(on.handlers.before_agent_start({ systemPrompt: 'BASE', systemPromptOptions: { sections } }) === undefined, 'sectioned prompt returns nothing')
    ok(/call `wrap_up` once at the end/.test(sections.inkstone_wrap_up ?? ''), 'guidance written into its own section')
    ok(/same question in `ask`/.test(sections.inkstone_wrap_up) && /never leave it only in the reply text/.test(sections.inkstone_wrap_up), 'guidance requires a question asked in the reply to appear in ask')
    ok(/Required whenever the final reply asks/.test(on.tools[0].parameters.properties.ask.description), 'ask description repeats the rule at the call site')
    const flat = on.handlers.before_agent_start({ systemPrompt: 'BASE' })
    ok(flat.systemPrompt.startsWith('BASE\n\n') && flat.systemPrompt.includes('wrap_up'), 'guidance appended without sections')
    ok(on.tools.length === 1, 'prompt hook does not register twice')

    const shown = await on.tools[0].execute('c1', { recap: ' Done. ', ask: 'Commit?', actions: [{ label: 'Commit', message: 'Commit it' }, { label: ' ', message: 'x' }, { label: 'A', message: 'B' }, { label: 'C', message: 'D' }] })
    equal(shown.details, { recap: 'Done.', ask: 'Commit?', actions: [{ label: 'Commit', message: 'Commit it' }, { label: 'A', message: 'B' }] }, 'execute trims, drops blank actions and caps at two')
    ok(shown.content[0].text === 'Shown to the user.' && !shown.isError, 'execute returns immediately without error')
    const noAsk = await on.tools[0].execute('c2', { recap: 'Done.', actions: [{ label: 'A', message: 'B' }] })
    equal(noAsk.details.actions, [], 'actions dropped without ask')
    ok((await on.tools[0].execute('c3', {})).isError === true, 'missing recap is an error')

    await writeFile(desktop, JSON.stringify({ wrapUpCard: false }))
    const sectionsOff = {}
    on.handlers.before_agent_start({ systemPrompt: 'BASE', systemPromptOptions: { sections: sectionsOff } })
    ok(!('inkstone_wrap_up' in sectionsOff), 'disabled: no guidance')
    ok(!on.state.active.includes('wrap_up'), 'disabled: wrap_up removed from active tools')
    ok(on.handlers.tool_call({ toolName: 'wrap_up' })?.block === true, 'disabled: stray call is blocked')
    ok(on.handlers.tool_call({ toolName: 'read' }) === undefined, 'other tools are not blocked')

    const off = fakePi()
    mod.default(off.pi)
    ok(off.tools.length === 0, 'disabled at load: tool not registered')
    const offFlat = off.handlers.before_agent_start({ systemPrompt: 'BASE' })
    ok(offFlat === undefined, 'disabled at load: prompt untouched')

    await writeFile(desktop, JSON.stringify({ wrapUpCard: true }))
    const lateSections = {}
    off.handlers.before_agent_start({ systemPrompt: 'BASE', systemPromptOptions: { sections: lateSections } })
    ok(off.tools.length === 1 && off.state.active.includes('wrap_up') && !!lateSections.inkstone_wrap_up, 'enabled later: registers on the next turn without restart')
    on.handlers.before_agent_start({ systemPrompt: 'BASE', systemPromptOptions: { sections: {} } })
    ok(on.state.active.filter((name) => name === 'wrap_up').length === 1, 're-enabled: wrap_up active exactly once')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function loadRenderer(dir) {
  const entry = join(dir, 'entry.ts')
  await writeFile(entry, [
    `export * from '${posix(join(ROOT, 'src/renderer/src/features/session/wrap-up.ts'))}'`,
    `export { groupIntoTurns } from '${posix(join(ROOT, 'src/shared/turns.ts'))}'`
  ].join('\n'))
  const outfile = join(dir, 'bundle.mjs')
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const call = (id, name, args = {}, extra = {}) => ({ id, name, args, status: 'ok', ...extra })
const wrap = (id, args, extra) => call(id, 'wrap_up', args, extra)

async function rendererTests(dir) {
  const m = await loadRenderer(dir)

  equal(m.wrapUpCardOf(wrap('w1', { recap: ' Done. ', ask: ' Ship? ', actions: [{ label: 'Yes', message: 'Ship it' }, { label: 'No', message: '' }, { label: 'Later', message: 'Wait' }, { label: 'X', message: 'Y' }] })),
    { callId: 'w1', recap: 'Done.', ask: 'Ship?', actions: [{ label: 'Yes', message: 'Ship it' }, { label: 'Later', message: 'Wait' }] }, 'card normalizes and caps actions')
  equal(m.wrapUpCardOf(wrap('w2', { recap: 'Done.', actions: [{ label: 'Yes', message: 'Go' }] })).actions, [], 'no ask means no buttons')
  ok(m.wrapUpCardOf(wrap('w3', { ask: 'x' })) === null, 'no recap means no card')
  ok(m.wrapUpCardOf(wrap('w4', { recap: 'x' }, { status: 'error' })) === null, 'failed call shows no card')
  ok(m.wrapUpCardOf(call('q', 'question', { recap: 'x' })) === null, 'other tools are not cards')
  ok(m.latestWrapUp([wrap('a', { recap: 'first' }), call('b', 'bash'), wrap('c', { recap: 'second' }), wrap('d', {}, { status: 'error' })])?.callId === 'c', 'latest valid wrap_up wins')

  const messages = [
    { id: 'u1', role: 'user', text: 'do it' },
    { id: 'a1', role: 'assistant', text: '', toolCalls: [call('t1', 'bash', { command: 'npm test' })] },
    { id: 'a2', role: 'assistant', text: 'All tests pass.', toolCalls: [wrap('w', { recap: 'Tests pass.', ask: 'Commit?', actions: [{ label: 'Commit', message: 'Commit it' }] })] }
  ]
  const stripped = m.withoutWrapUpMessages(messages)
  ok(stripped !== messages && stripped[0] === messages[0] && stripped[1] === messages[1], 'only messages with wrap_up are copied')
  ok(stripped[2].toolCalls.length === 0 && messages[2].toolCalls.length === 1, 'source messages stay untouched')
  ok(m.withoutWrapUpMessages(messages)[2] === stripped[2], 'stripped copies are cached by identity')
  ok(m.withoutWrapUpMessages(stripped) === stripped, 'clean list is returned as is')

  const raw = m.groupIntoTurns(messages)
  const clean = m.groupIntoTurns(stripped)
  const assistant = clean.find((turn) => turn.kind === 'assistant')
  ok(raw.find((turn) => turn.kind === 'assistant').response?.hasTools === true, 'unstripped: reply next to wrap_up counts as tool commentary')
  ok(assistant.tools.length === 1 && assistant.response?.text === 'All tests pass.' && assistant.response.hasTools === false, 'stripped: reply stays the reply and only bash counts as a tool')

  const live = { kind: 'assistant', ...assistant }
  equal(m.sessionWrapUp({ enabled: true, active: true, busy: false, turns: clean, messages })?.card.callId, 'w', 'latest finished turn shows its card from saved args')
  ok(m.sessionWrapUp({ enabled: false, active: true, busy: false, turns: clean, messages }) === null, 'setting off hides card')
  ok(m.sessionWrapUp({ enabled: true, active: false, busy: false, turns: clean, messages }) === null, 'peeked view hides card')
  ok(m.sessionWrapUp({ enabled: true, active: true, busy: true, turns: clean, messages }) === null, 'running session hides card')
  ok(m.sessionWrapUp({ enabled: true, active: true, busy: false, turns: clean.map((turn) => turn === assistant ? { ...live, streaming: true } : turn), messages }) === null, 'streaming turn hides card')
  const followed = [...clean, { kind: 'user', id: 'u2', msg: { id: 'u2', role: 'user', text: 'next' } }]
  ok(m.sessionWrapUp({ enabled: true, active: true, busy: false, turns: followed, messages }) === null, 'older turn hides card once the user replied')

  const segmentTurn = {
    ...assistant,
    tools: [call('x1', 'read'), wrap('wx', { recap: 'r' }), call('x2', 'bash')],
    segments: [{ ...assistant.segments[0], tools: [call('x1', 'read'), wrap('wx', { recap: 'r' }), call('x2', 'bash')], thinkingParts: [{ text: 'a', at: 0 }, { text: 'b', at: 2 }, { text: 'c', at: 3 }] }]
  }
  const without = m.withoutWrapUp(segmentTurn)
  equal(without.tools.map((tool) => tool.id), ['x1', 'x2'], 'turn tools drop wrap_up')
  equal(without.segments[0].tools.map((tool) => tool.id), ['x1', 'x2'], 'segment tools drop wrap_up')
  equal(without.segments[0].thinkingParts.map((part) => part.at), [0, 1, 2], 'thinking anchors after wrap_up shift back')
  ok(m.withoutWrapUp(assistant) === assistant, 'turn without wrap_up keeps identity')
}

function installDomGlobals() {
  function ElementShim() {}
  ElementShim.prototype = { focus() {}, blur() {}, addEventListener() {}, removeEventListener() {} }
  const noop = () => {}
  globalThis.HTMLElement = ElementShim
  globalThis.Element = ElementShim
  globalThis.Node = ElementShim
  globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    HTMLElement: ElementShim, Element: ElementShim, Node: ElementShim,
    addEventListener: noop, removeEventListener: noop,
    getComputedStyle: globalThis.getComputedStyle,
    screen: { orientation: { angle: 0 } },
    location: { href: 'http://localhost/' }
  }
  globalThis.document = { readyState: 'loading', addEventListener: noop, removeEventListener: noop, documentElement: {}, visibilityState: 'visible' }
}

async function cardMarkupTests(dir) {
  installDomGlobals()
  const contents = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import { WrapUpCard } from '${posix(join(ROOT, 'src/renderer/src/features/session/WrapUpCard.tsx'))}'`,
    `import { I18nProvider } from '${posix(join(ROOT, 'src/renderer/src/i18n/index.tsx'))}'`,
    'export { React, renderToStaticMarkup, WrapUpCard, I18nProvider }'
  ].join('\n')
  const outfile = join(dir, 'card.cjs')
  await build({ stdin: { contents, resolveDir: ROOT, loader: 'tsx' }, outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' } })
  const { React, renderToStaticMarkup, WrapUpCard, I18nProvider } = createRequire(import.meta.url)(outfile)
  const render = (card) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(WrapUpCard, { card: { callId: card.callId, recap: card.recap, ask: card.ask ?? null, actions: card.actions ?? [] }, dismissKey: card.callId })))

  const recapOnly = render({ callId: 'm1', recap: 'Edited `wrap-up.js`; tests pass.' })
  ok(recapOnly.includes('v3-wrapup-kicker') && !recapOnly.includes('data-pending') && !recapOnly.includes('v3-wrapup-ask'), 'recap-only card shows a recap heading and no decision area')
  ok(recapOnly.includes('<code class="v3-wrapup-code">wrap-up.js</code>') && !recapOnly.includes('`'), 'backticks in recap render as inline code')

  const pending = render({ callId: 'm2', recap: 'Done.', ask: 'Restart `yan`?', actions: [{ label: 'Restart', message: 'Restart it' }, { label: 'Later', message: 'Wait' }] })
  ok(pending.includes('data-pending=""') && pending.includes('data-testid="v3-wrap-up-question"'), 'card with ask is marked pending and shows the question')
  ok(pending.indexOf('v3-wrap-up-recap') < pending.indexOf('v3-wrap-up-question') && pending.indexOf('v3-wrap-up-question') < pending.indexOf('v3-wrap-up-action'), 'order: recap, question, then buttons')
  ok((pending.match(/data-testid="v3-wrap-up-action"/g) ?? []).length === 2 && pending.includes('<code class="v3-wrapup-code">yan</code>'), 'two buttons and inline code in the question')
}

const dir = await mkdtemp(join(tmpdir(), 'inkstone-wrap-up-'))
try {
  await extensionTests(dir)
  await rendererTests(dir)
  await cardMarkupTests(dir)
  console.log(`wrap-up: ${checks} checks passed`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
