import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, transform } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'inkstone-turn-model-'))
try {
  await build({
    entryPoints: { turns: 'src/shared/turns.ts', normalize: 'src/main/normalize.ts', display: 'src/renderer/src/components/chat/turn-model-display.ts' },
    bundle: true, platform: 'node', format: 'esm', outdir: temp, outExtension: { '.js': '.mjs' }, logLevel: 'silent'
  })
  const { groupIntoTurns } = await import(pathToFileURL(resolve(temp, 'turns.mjs')).href)
  const { normalizeMessage } = await import(pathToFileURL(resolve(temp, 'normalize.mjs')).href)
  const { resolveTurnModelDisplay, resolveSubagentModelDisplay } = await import(pathToFileURL(resolve(temp, 'display.mjs')).href)
  let count = 0
  const check = (condition, text) => { assert.ok(condition, text); count += 1 }
  const first = normalizeMessage({ role: 'assistant', model: 'physical-first', content: [{ type: 'text', text: '先核对' }], timestamp: 1 }, 0)
  const second = normalizeMessage({ role: 'assistant', model: 'physical-last', content: [{ type: 'text', text: '结论' }], timestamp: 2 }, 1)
  check(first.model === 'physical-first' && second.model === 'physical-last', '归一化保留消息实际model，不借用虚拟选中模型')
  const catalog = [{ provider: 'openai', id: 'gpt-case', name: 'GPT Case Display' }, { provider: 'other', id: 'gpt-case', name: 'Wrong Provider' }]
  check(resolveTurnModelDisplay('openai/gpt-case', catalog).label === 'GPT Case Display', '完整provider/id匹配菜单显示名并保留名称大小写')
  check(resolveTurnModelDisplay('openai/missing-id', catalog).label === 'missing-id', '目录缺失时回退原模型ID')
  check(resolveTurnModelDisplay('missing-id', catalog).label === 'missing-id', '无provider的旧历史不猜测模型名称')
  const named = [{ provider:'commandcode',id:'deepseek/deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash' },
    { provider:'openai-codex',id:'gpt-6.1-sol',name:'GPT-6.1 Sol' }]
  const native = normalizeMessage({role:'assistant',provider:'commandcode',model:'deepseek/deepseek-v4.1-flash',content:[{type:'text',text:'native'}]},2)
  check(native.model === 'commandcode/deepseek/deepseek-v4.1-flash', '历史原生provider和带斜杠id完整保留')
  check(resolveTurnModelDisplay(native.model,named).label === 'DeepSeek V4.1 Flash', '原生消息→目录→菜单名链路一致')
  check(resolveSubagentModelDisplay(native.model,named).label === 'DeepSeek V4.1 Flash · commandcode', '子代理无需展开也能辨认实际供应商')
  const codex = normalizeMessage({role:'assistant',provider:'openai-codex',model:'gpt-6.1-sol',content:[{type:'text',text:'codex'}]},3)
  check(resolveTurnModelDisplay(codex.model,named).label === 'GPT-6.1 Sol', 'ChatGPT菜单大小写一致，不退回小写ID')
  check(resolveTurnModelDisplay('gpt-6.1-sol',named).label === 'GPT-6.1 Sol', '旧裸ID在名字无歧义时恢复菜单名')
  check(resolveTurnModelDisplay('gpt-case',catalog).label === 'gpt-case', '旧裸ID多供应商名字冲突时不猜')
  check(resolveTurnModelDisplay('openai/gpt-case',[],catalog).label === 'GPT Case Display', '未就绪目录使用菜单收藏名')
  check(resolveTurnModelDisplay('openai/gpt-case',catalog,[{provider:'openai',id:'gpt-case',name:'OLD'}]).label === 'GPT Case Display', '新目录名称优先于陈旧收藏名')
  check(resolveSubagentModelDisplay('missing/id',[]).label === 'id · missing', '未知子模型保留ID和供应商，不造名称')
  const nested = normalizeMessage({role:'assistant',provider:'openrouter',model:'openrouter/auto',content:[]},4)
  check(nested.model === 'openrouter/openrouter/auto', 'id本身以provider为前缀也不截断原始id')
  check(groupIntoTurns([first, second])[0].model === 'physical-last', '没有speed/elapsed字段的持久历史也取最后实际模型')
  const error = { id: 'error', role: 'assistant', text: '', error: '旧错误', model: 'physical-error', timestamp: 1 }
  const result = groupIntoTurns([error, second])[0]
  check(result.model === 'physical-last' && result.error === '旧错误', '物理模型更新与保留旧错误互不覆盖')
  const noModel = { id: 'tool', role: 'assistant', text: '', toolCalls: [{ id: 't', name: 'read', status: 'ok' }] }
  check(groupIntoTurns([second, noModel])[0].model === 'physical-last', '工具结果不清掉已知模型')
  check(groupIntoTurns([{ id: 'empty', role: 'assistant', text: '旧历史' }])[0].model === undefined, '缺失模型时不猜')
  const user = { id: 'user', role: 'user', text: '下一轮' }
  const next = { id: 'next', role: 'assistant', text: '新回复' }
  const turns = groupIntoTurns([first, user, next])
  check(turns.at(-1).model === undefined, '下一轮不继承上一轮物理模型')
  check(groupIntoTurns([first, second], second.id)[0].model === 'physical-last', '流式投影也使用最新有模型的消息')
  const source = await readFile('src/renderer/src/components/toolbar/NativeContextSection.tsx', 'utf8')
  const ast = ts.createSourceFile('NativeContextSection.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hook = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useContextUsage')
  assert.ok(hook, '读取实际上下文展示计算，不复制实现')
  const { code } = await transform(hook.getText(ast), { loader: 'ts', format: 'cjs' })
  const selected = { provider: 'vmfix', id: 'auto', contextWindow: 111111 }
  let state = { session: { model: selected }, stats: { contextUsage: { tokens: 16000, contextWindow: 32000, modelKey: 'vmfix/auto' } } }
  const context = vm.createContext({ useStore: selector => selector(state) })
  vm.runInContext(code, context)
  check(context.useContextUsage().windowSize === 32000 && context.useContextUsage().percent === 50, '路由响应后使用原生物理窗口作分母')
  state.stats.contextUsage.modelKey = 'other/model'
  check(!context.useContextUsage().known, '其他模型的迟到快照不显示为当前用量')
  state.stats.contextUsage = { tokens: 100, modelKey: 'vmfix/auto' }
  check(context.useContextUsage().windowSize === 111111, '尚无原生窗口时回退选中声明')
  state.stats.contextUsage.contextWindow = 0
  check(context.useContextUsage().windowSize === 111111, '无效零窗口不作为分母')
  state.stats.contextUsage.contextWindow = Infinity
  check(context.useContextUsage().windowSize === 111111, '非有限窗口不作为分母')
  state.stats.contextUsage = { tokens: null, contextWindow: 32000, modelKey: 'vmfix/auto' }
  check(!context.useContextUsage().known && context.useContextUsage().percent === null, '压缩后用量未知不伪造比例')
  console.log(`turn-model: ${count} 项历史/回合与上下文展示检查通过`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
