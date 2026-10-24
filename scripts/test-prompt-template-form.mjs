import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

await mkdir('.tmp/prompt-template-form', { recursive: true })
const root = await mkdtemp(resolve('.tmp/prompt-template-form/run-'))
const previousWindow = globalThis.window
const stubs = {
  react: `
    let slots = [], cursor = 0, cleanups = []
    export function beginRender() { cursor = 0 }
    export function dispose() { for (const cleanup of cleanups) cleanup?.(); cleanups = [] }
    export function reset() { dispose(); slots = []; cursor = 0 }
    export function useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { slots[index] = value }]
    }
    export function useRef(initial) {
      const index = cursor++
      return slots[index] ??= { current: initial }
    }
    export function useEffect(effect) {
      const index = cursor++
      if (!(index in slots)) { slots[index] = true; cleanups.push(effect()) }
    }
  `,
  'react/jsx-runtime': 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx',
  '../../../state/store': 'export const state = {}; export const useStore = { getState: () => state }',
  '../../../i18n': 'export const useT = () => key => key; export const useI18n = () => ({ lang: "zh-CN" })',
  '../../../ui': 'export const Button = "Button", Dialog = "Dialog", Modal = "Modal", ModalOverlay = "ModalOverlay", TextArea = "TextArea", TextField = "TextField"',
  './parts': 'export const Meta = "Meta", Note = "Note", Warn = "Warn"'
}

try {
  const outfile = join(root, 'fixture.mjs')
  await build({
    stdin: {
      contents: `export { PromptTemplateForm } from ${JSON.stringify(resolve('src/renderer/src/features/settings/capabilities/PromptTemplateForm.tsx'))}; export { beginRender, reset, dispose } from 'react'; export { state } from '../../../state/store'`,
      sourcefile: 'prompt-template-form-fixture.ts',
      resolveDir: process.cwd()
    },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [{
      name: 'form-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined)
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: stubs[args.path] }))
      }
    }]
  })
  const { PromptTemplateForm, beginRender, reset, dispose, state } = await import(pathToFileURL(outfile).href)
  const find = (node, id) => {
    if (!node || typeof node !== 'object') return undefined
    if (node.props?.['data-testid'] === id) return node
    for (const child of [node.props?.children].flat(Infinity)) {
      const match = find(child, id)
      if (match) return match
    }
    return undefined
  }
  const words = node => {
    if (Array.isArray(node)) return node.map(words).join(' ')
    if (typeof node === 'string') return node
    return node && typeof node === 'object' ? words(node.props?.children) : ''
  }
  const event = { preventDefault() {} }
  function setup(sessionId = 'session-1') {
    reset()
    const calls = { create: [], reload: [], notices: [], created: 0, closed: 0 }
    const props = {
      runnerId: sessionId ? 'runner-1' : null,
      sessionId: sessionId ?? undefined,
      onClose: () => calls.closed++,
      onCreated: () => calls.created++
    }
    Object.assign(state, {
      activeRunnerId: props.runnerId,
      session: sessionId ? { sessionId } : undefined,
      commands: [],
      notify: (...args) => calls.notices.push(args),
      reloadCommands: async () => { state.commands = [{ name: 'translate', source: 'prompt' }] }
    })
    globalThis.window = { yan: {
      capabilities: { createPromptTemplate: async input => {
        calls.create.push(input)
        return { ok: true, path: 'fixture/prompts/translate.md' }
      } },
      nativeSession: async request => { calls.reload.push(request); return { ok: true } }
    } }
    const render = () => { beginRender(); return PromptTemplateForm(props) }
    let tree = render()
    find(tree, 'caps-prompt-create-name').props.onChange(' translate ')
    find(tree, 'caps-prompt-create-content').props.onChange(' 翻译成英文 ')
    const submit = () => {
      tree = render()
      return find(tree, 'caps-prompt-create-form').props.onSubmit(event)
    }
    return { calls, render, submit }
  }

  let fixture = setup()
  await fixture.submit()
  assert.deepEqual(fixture.calls.create, [{ name: 'translate', content: '翻译成英文' }])
  assert.deepEqual(fixture.calls.reload, [{ action: 'reload', expectedSessionId: 'session-1' }])
  assert.equal(fixture.calls.created, 1)
  assert.match(fixture.calls.notices[0][1], /模板 \/translate 已创建并加载/)

  fixture = setup(null)
  await fixture.submit()
  assert.equal(fixture.calls.created, 1, '无会话时仍可保存用户模板')
  assert.equal(fixture.calls.reload.length, 0)
  assert.match(fixture.calls.notices[0][1], /模板已保存，打开新会话/)

  fixture = setup()
  window.yan.capabilities.createPromptTemplate = async () => ({ ok: false, error: 'duplicate template' })
  await fixture.submit()
  assert.equal(fixture.calls.reload.length, 0)
  assert.equal(fixture.calls.created, 0)
  assert.match(words(fixture.render()), /duplicate template/)
  assert.equal(find(fixture.render(), 'caps-prompt-create-name').props.isDisabled, false)

  fixture = setup()
  window.yan.nativeSession = async request => {
    fixture.calls.reload.push(request)
    return fixture.calls.reload.length === 1 ? { ok: false, error: 'session busy' } : { ok: true }
  }
  await fixture.submit()
  assert.equal(fixture.calls.created, 0)
  assert.match(words(fixture.render()), /文件已保存，但暂未加载：session busy/)
  assert.equal(find(fixture.render(), 'caps-prompt-create-name').props.isDisabled, true)
  await fixture.submit()
  assert.equal(fixture.calls.create.length, 1, '保存后重试只重载，不重复创建文件')
  assert.equal(fixture.calls.reload.length, 2)
  assert.equal(fixture.calls.created, 1)

  fixture = setup()
  window.yan.nativeSession = async () => { throw new Error('reload exception') }
  await fixture.submit()
  assert.match(words(fixture.render()), /文件已保存，但暂未加载：reload exception/)
  assert.equal(fixture.calls.created, 0)

  fixture = setup()
  state.reloadCommands = async () => {}
  await fixture.submit()
  assert.equal(fixture.calls.created, 0, '重载后未找到模板时不报告成功')
  assert.match(words(fixture.render()), /重载后未找到模板 \/translate/)

  fixture = setup()
  let release
  window.yan.capabilities.createPromptTemplate = input => {
    fixture.calls.create.push(input)
    return new Promise(resolve => { release = resolve })
  }
  const pending = fixture.submit()
  await fixture.submit()
  assert.equal(fixture.calls.create.length, 1, '提交中的重复事件不重复创建')
  state.activeRunnerId = 'runner-2'
  release({ ok: true, path: 'fixture/prompts/translate.md' })
  await pending
  assert.equal(fixture.calls.reload.length, 0, '切换运行实例后不在新会话发起重载')
  assert.equal(fixture.calls.created, 0)
  assert.deepEqual(fixture.calls.notices, [])

  fixture = setup()
  window.yan.nativeSession = () => new Promise(resolve => { release = resolve })
  const loading = fixture.submit()
  await Promise.resolve()
  state.session = { sessionId: 'session-2' }
  release({ ok: true })
  await loading
  assert.equal(fixture.calls.created, 0, '重载期间切换会话不更新新会话')
  assert.deepEqual(fixture.calls.notices, [])

  fixture = setup()
  window.yan.capabilities.createPromptTemplate = () => new Promise(resolve => { release = resolve })
  const unmounted = fixture.submit()
  dispose()
  release({ ok: true, path: 'fixture/prompts/translate.md' })
  await unmounted
  assert.equal(fixture.calls.reload.length, 0, '离开表单后不再发起重载')
  assert.equal(fixture.calls.created, 0)
  console.log('test-prompt-template-form: ok')
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
  await rm(root, { recursive: true, force: true })
}
