import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const RETIRED_LIVE = ['dailyhome', 'sessionmap', 'taskinbox', 'agentprofile', 'spaces', 'spaceview', 'follow', 'activitymodel', 'knowledgeasync', 'knowledgetab', 'knowledgeisolation', 'workmode', 'goal', 'goalreview', 'goalreviewmodify', 'goallinks', 'goalpopover', 'budgetgate', 'contextpressure240k', 'contextsoak300k', 'contextsoak60k', 'contextpressure1m', 'activity']
const RETIRED_STATES = ['autonomous', 'autonomousrunning', 'workmodemenu', 'workmodekey', 'plusgoal', 'goalpursued', 'goalreview', 'huboverview', 'hubsplit', 'hubcreate', 'hubfallback', 'knowledgetab', 'workbenchhome', 'taskinbox', 'sessionmap', 'agentprofilemenu', 'railspaces', 'spaceoverview', 'spacelibrary', 'spaceartifact', 'spacefollow', 'amconfig', 'contextbudget', 'ctxpreset', 'ctxmodelpresets', 'compactionreclaim']

function registration(source, name) {
  const ast = ts.createSourceFile('registration.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let found
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(found, `missing registration: ${name}`)
  return found
}

function assertUniqueProperties(object, name) {
  const seen = new Set()
  for (const property of object.properties) {
    const key = property.name.text
    assert.ok(!seen.has(key), `duplicate ${name}: ${key}`)
    seen.add(key)
  }
}

async function checkModelMenuState(source) {
  const states = registration(source, 'STATES')
  const code = states.properties.find((p) => p.name.text === 'modelmenu').initializer.text
  let state = { session: { isStreaming: true, isCompacting: true }, closeSettings() {}, setRailPinned() {} }
  let clicks = 0
  const context = vm.createContext({
    window: { __yanStore: { getState: () => state, setState: (patch) => { state = { ...state, ...patch } } } },
    setTimeout: (callback) => callback(),
    document: {
      querySelector: () => ({ get disabled() { return state.session.isStreaming || state.session.isCompacting }, click() { clicks++ } }),
      querySelectorAll: () => [{}, {}]
    }
  })
  assert.equal(await vm.runInContext(code, context), 'ok(items=2)')
  assert.equal(clicks, 1)
  assert.equal(state.session.isStreaming, false)
  assert.equal(state.session.isCompacting, false)
}

function checkRetiredRegistrations(source) {
  const live = readFileSync(new URL('./test-live.mjs', import.meta.url), 'utf8')
  const cases = registration(live, 'CASES')
  assertUniqueProperties(cases, 'CASES')
  for (const property of cases.properties) {
    assert.ok(!RETIRED_LIVE.includes(property.name.text), `retired live case: ${property.name.text}`)
    const probe = property.initializer.properties.find((p) => p.name.text === 'probe')
    if (probe) assert.doesNotThrow(() => readFileSync(new URL('../' + probe.initializer.text, import.meta.url)))
  }
  for (const name of ['STATES', 'MUST_HAVE', 'AFTER_STATE']) {
    const object = registration(source, name)
    assertUniqueProperties(object, name)
    for (const property of object.properties) {
      assert.ok(!RETIRED_STATES.includes(property.name.text), `retired ${name}: ${property.name.text}`)
    }
  }
  for (const group of registration(source, 'GROUPS').elements) {
    const states = group.properties.find((p) => p.name.text === 'states').initializer.elements
    for (const state of states) assert.ok(!RETIRED_STATES.includes(state.text), `retired matrix state: ${state.text}`)
  }
}
import { MODEL_MENU_GROUPS, selectRunGroups, selectMatrixGroups, hasRequestedStates } from './lib/visual-matrix-selection.mjs'

export async function runVisualMatrixTests() {
  const defaults = ['0', '1', 'onboarding']
  const names = MODEL_MENU_GROUPS.map((group) => group.name)
  assert.deepEqual(selectRunGroups([], [], defaults), defaults)
  assert.deepEqual(selectRunGroups([], ['modelmenufull'], defaults), names)
  assert.deepEqual(selectRunGroups([], ['main', 'modelmenufull'], defaults), [...defaults, ...names])
  assert.deepEqual(selectRunGroups(['0'], ['modelmenufull'], defaults), ['0'])
  const groups = [{ states: ['main'] }, ...MODEL_MENU_GROUPS]
  assert.deepEqual(selectMatrixGroups(groups, [names[1]]), [MODEL_MENU_GROUPS[1]])
  assert.deepEqual(selectMatrixGroups(groups, ['2']), [MODEL_MENU_GROUPS[1]])
  assert.equal(hasRequestedStates(selectMatrixGroups(groups, ['0']), ['modelmenufull']), false)
  assert.equal(hasRequestedStates(selectMatrixGroups(groups, ['bad-group']), []), false)
  assert.equal(hasRequestedStates([{ states: [] }], []), false)
  assert.equal(hasRequestedStates(MODEL_MENU_GROUPS, ['bad-state']), false)
  assert.equal(hasRequestedStates(MODEL_MENU_GROUPS, ['modelmenufull']), true)

  const source = readFileSync(new URL('./visual-matrix.mjs', import.meta.url), 'utf8')
  checkRetiredRegistrations(source)
  await checkModelMenuState(source)
  const start = source.indexOf("if (ONLY.includes('modelmenufull')")
  const end = source.indexOf("if (ONLY.includes('codemode'))", start)
  assert.ok(start >= 0 && end > start)
  const context = vm.createContext({
    ONLY: ['modelmenufull'], MODEL_MENU_GROUPS, GROUPS: [], STATES: {}, AFTER_STATE: {}, MUST_HAVE: {},
    process: { env: {} }
  })
  vm.runInContext(source.slice(start, end), context)
  assert.equal(context.GROUPS.length, 3)

  for (const initiallyOpen of [false, true]) {
    let open = initiallyOpen
    const original = { runners: [], models: [], thinkingLevels: ['off'], session: { model: { id: 'original' } } }
    let state = { ...original, closeSettings() {} }
    context.window = { __yanStore: {
      getState: () => state,
      setState: (patch) => { state = { ...state, ...patch } }
    } }
    context.MouseEvent = class {}
    context.setTimeout = (callback) => callback()
    context.innerWidth = 1280
    context.innerHeight = 680
    context.document = {
      dispatchEvent: () => { open = false },
      querySelector: (selector) => selector === '[data-testid="model-picker"]'
        ? { click: () => { open = !open } }
        : open ? { getBoundingClientRect: () => ({ width: 360, height: 408 }) } : null
    }
    for (let group = 0; group < 3; group++) {
      const result = await vm.runInContext(context.STATES.modelmenufull, context)
      assert.ok(result.startsWith('ok('))
      assert.equal(open, true)
      await vm.runInContext(context.AFTER_STATE.modelmenufull, context)
      assert.equal(open, false)
      for (const key of Object.keys(original)) assert.equal(state[key], original[key])
      assert.equal(context.window.__yanModelMenuFullBaseline, undefined)
    }
  }
  console.log('✓ 视觉矩阵选择与模型菜单复位回归检查通过（含已打开菜单和连续三组）')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runVisualMatrixTests()
