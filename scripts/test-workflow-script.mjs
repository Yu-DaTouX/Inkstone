import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const script = await compile('src/main/workflows/script.ts')
  const options = await compile('src/main/workflows/agent-options.ts')
  const { checkWorkflowScript, validateMeta, forbiddenImportAt } = script
  const { normalizeAgentCall, promptHash, subagentStartParams, MAX_PROMPT_CHARS } = options
  const throws = (fn, pattern) => {
    try {
      fn()
      return false
    } catch (error) {
      return pattern.test(String(error?.message ?? error))
    }
  }

  const good = `export const meta = {
  name: 'audit',
  description: "逐个审计",
  phases: ['侦察', \`复核\`],
}
phase('侦察')
const r = await agent('看一下', { readOnly: true })
return r
`
  const checked = checkWorkflowScript(good)
  ok(checked.ok && checked.meta.name === 'audit' && checked.meta.description === '逐个审计', '合法脚本通过并取出 meta', JSON.stringify(checked))
  ok(checked.ok && checked.meta.phases.join('|') === '侦察|复核', 'phases 支持无插值的模板字符串')
  ok(checked.ok && checked.code.length === good.length && checked.code.startsWith('       const meta'), 'export 替换成等长空白，行列号不变')
  ok(checkWorkflowScript(`// 头注释\n/* 块注释 */\n${good}`).ok, 'meta 前可以有注释')
  ok(checkWorkflowScript(`\uFEFF${good}`).ok, '容忍 BOM')

  const bad = (source, pattern, label) => {
    const result = checkWorkflowScript(source)
    ok(!result.ok && pattern.test(result.error), label, JSON.stringify(result))
  }
  bad('', /空/, '空脚本报错')
  bad(`const x = 1\nexport const meta = { name: 'a', description: 'b' }`, /首条语句/, 'meta 不是首条语句时报错')
  bad(`export const meta = { name: NAME, description: 'b' }`, /纯字面量/, 'meta 用变量报错')
  bad(`export const meta = { name: make(), description: 'b' }`, /纯字面量/, 'meta 用函数调用报错')
  bad(`export const meta = { ...base, name: 'a', description: 'b' }`, /展开/, 'meta 用展开报错')
  bad(`export const meta = { [k]: 'a', description: 'b' }`, /计算属性/, 'meta 用计算属性名报错')
  bad(`export const meta = { name, description: 'b' }`, /简写/, 'meta 用简写属性报错')
  bad('export const meta = { name: `a${x}`, description: \'b\' }', /模板字符串/, 'meta 模板字符串带插值报错')
  bad(`export const meta = { name: 'a' }`, /description/, '缺 description 报错')
  bad(`export const meta = { description: 'b' }`, /name/, '缺 name 报错')
  bad(`export const meta = { name: 'a', description: 'b', version: 1 }`, /version/, '多余的 meta 键报错')
  bad(`export const meta = { name: 'a', description: 'b', phases: ['x', 'x'] }`, /重复/, '重复阶段名报错')
  bad(`export const meta = { name: 'a', description: 'b', phases: 'x' }`, /phases/, 'phases 不是数组报错')
  bad(`export const meta = { name: '${'n'.repeat(81)}', description: 'b' }`, /80/, 'name 超长报错')
  bad(`export const meta = { name: 'a', description: 'b' }\nconst m = await import('node:fs')`, /第 2 行用了 import/, '动态 import() 被拒并给出行号')
  bad(`export const meta = { name: 'a', description: 'b' }\nimport fs from 'node:fs'`, /import/, '静态 import 被拒')
  bad(`export const meta = { name: 'a', description: 'b' }\nconst = 1`, /语法错误/, '语法错误在启动前报出')
  bad(`export const meta = { name: 'a', description: 'b' }\n${'x'.repeat(200_001)}`, /200000/, '脚本超长报错')

  ok(checkWorkflowScript(`export const meta = { name: 'a', description: 'b' }\nconst s = 'import x'\n// import y\nconst o = { important: 1 }\nconst re = /import/\nreturn \`import \${s}\``).ok, '字符串、注释、正则、模板里的 import 字样不误报')
  ok(forbiddenImportAt('a.import(1)') < 0, '属性名 .import 不算 import')
  ok(forbiddenImportAt('const x = `${ import("a") }`') >= 0, '模板插值里的 import() 仍会拦下')
  ok(validateMeta({ name: ' a ', description: ' b ' }).ok, 'name 与 description 会去掉首尾空白')

  const call = normalizeAgentCall('  看一下  ', { label: '标题', model: 'openai/gpt-x', thinking: 'HIGH', readOnly: true, timeoutMinutes: 5, goal: 'g', deliverables: ['d1', ' '], sources: ['s'], boundary: 'b' })
  ok(call.prompt === '看一下' && call.options.thinking === 'high' && call.options.deliverables.length === 1, '选项规范化', JSON.stringify(call))
  ok(throws(() => normalizeAgentCall('x', { stallMs: 1 }), /不认识的选项：stallMs/), '未知选项报错')
  ok(throws(() => normalizeAgentCall('', {}), /prompt/), '空 prompt 报错')
  ok(throws(() => normalizeAgentCall('x'.repeat(MAX_PROMPT_CHARS + 1), {}), /12000/), '超长 prompt 报错')
  ok(throws(() => normalizeAgentCall('x', { readOnly: true, isolation: 'worktree' }), /不能同时用/), 'readOnly 与 worktree 冲突报错')
  ok(throws(() => normalizeAgentCall('x', { isolation: 'docker' }), /isolation/), '不支持的 isolation 报错')
  ok(throws(() => normalizeAgentCall('x', { timeoutMinutes: 0 }), /1–60/) && throws(() => normalizeAgentCall('x', { timeoutMinutes: 61 }), /1–60/), 'timeoutMinutes 超范围报错')
  ok(throws(() => normalizeAgentCall('x', { thinking: 'ultra' }), /thinking/), '不认识的 thinking 报错')
  ok(throws(() => normalizeAgentCall('x', { schema: { type: 'object', minProperties: 1 } }), /minProperties 不支持/), 'schema 不支持的关键字报错')
  ok(throws(() => normalizeAgentCall('x'.repeat(MAX_PROMPT_CHARS - 20), { schema: { type: 'object' } }), /schema 说明/), 'prompt 加 schema 说明超过子代理任务上限时报错')
  ok(normalizeAgentCall('x', { isolation: 'none' }).options.isolation === undefined, "isolation: 'none' 等于不隔离")

  const params = subagentStartParams('看一下', { label: 'L', model: 'm', thinking: 'low', isolation: 'worktree', timeoutMinutes: 9, goal: 'g', sources: ['s'], deliverables: ['d'], boundary: 'b' })
  ok(params.task === '看一下' && params.title === 'L' && params.model === 'm' && params.thinking === 'low' && params.isolation === 'worktree' && params.readOnly === undefined, '选项映射到子代理启动参数', JSON.stringify(params))
  ok(params.brief.goal === 'g' && params.brief.timeoutMinutes === 9 && params.brief.sources[0] === 's' && params.brief.deliverables[0] === 'd' && params.brief.boundary === 'b', 'goal/deliverables/sources/boundary/timeoutMinutes 进 brief')
  ok(subagentStartParams('x', { readOnly: true }).readOnly === true, 'readOnly 映射为只读子代理')
  const withSchema = subagentStartParams('x', { schema: { type: 'object', required: ['a'] } })
  ok(withSchema.task.startsWith('x\n\n') && withSchema.task.includes('```json') && withSchema.task.includes('"required":["a"]'), 'schema 时任务末尾要求只交一个 JSON 代码块')

  const base = promptHash('p', { readOnly: true, schema: { b: 1, a: 2 } })
  ok(base === promptHash('p', { schema: { a: 2, b: 1 }, readOnly: true, label: '别的标题', timeoutMinutes: 30 }), '哈希不受键顺序、label、timeoutMinutes 影响')
  ok(base !== promptHash('q', { readOnly: true, schema: { b: 1, a: 2 } }) && base !== promptHash('p', { schema: { b: 1, a: 2 } }) && base !== promptHash('p', { readOnly: true, schema: { b: 1, a: 2 }, model: 'm' }), '提示词、只读、模型变化会改变哈希')
})
