import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
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
  assert.equal(hasRequestedStates(MODEL_MENU_GROUPS, ['bad-state']), false)
  assert.equal(hasRequestedStates(MODEL_MENU_GROUPS, ['modelmenufull']), true)

  // 执行真实场景字符串；这里只模拟菜单开关和 store，DOM/截图另跑 Electron 验证。
  const source = readFileSync(new URL('./visual-matrix.mjs', import.meta.url), 'utf8')
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
