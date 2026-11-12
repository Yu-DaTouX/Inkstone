import { runSuite } from './lib/test-suite.mjs'

const META = `export const meta = { name: 't', description: 'd' }\n`

await runSuite(import.meta.url, async (ok, compile) => {
  const { runWorkflowSandbox } = await compile('src/main/workflows/sandbox.ts')
  const { checkWorkflowScript } = await compile('src/main/workflows/script.ts')

  const run = async (body, { reply, argsJson, maxAgents = 200, maxItems = 1000 } = {}) => {
    const checked = checkWorkflowScript(META + body)
    if (!checked.ok) throw new Error(checked.error)
    const calls = []
    const phases = []
    const logs = []
    const fatals = []
    const outcome = await runWorkflowSandbox({ code: checked.code, argsJson, maxAgents, maxItems }, {
      agent: async (seq, prompt, options) => {
        calls.push({ seq, prompt, options })
        const answer = reply ? await reply(seq, prompt, options) : { ok: true, json: JSON.stringify(`r${seq}`) }
        return answer
      },
      phase: (title) => phases.push(title),
      log: (text) => logs.push(text),
      fatal: (error) => fatals.push(error)
    })
    return { outcome, calls, phases, logs, fatals }
  }
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  {
    const { outcome, calls, phases, logs } = await run(`phase('一')\nconst a = await agent('A', { label: 'x' })\nphase('二')\nlog('进度')\nlog({ n: 1 })\nreturn { a, n: args.n }`, { argsJson: '{"n":3}' })
    ok(outcome.ok && JSON.parse(outcome.json).a === 'r0' && JSON.parse(outcome.json).n === 3, '顶层 await、args 与 return 值', JSON.stringify(outcome))
    ok(calls.length === 1 && calls[0].options.label === 'x' && phases.join() === '一,二' && logs.join('|') === '进度|{"n":1}', 'agent/phase/log 转给宿主')
  }

  {
    const { outcome } = await run(`return typeof args`)
    ok(outcome.ok && JSON.parse(outcome.json) === 'undefined', '没传 args 时是 undefined')
  }

  {
    const { outcome } = await run(`return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof globalThis.agent]`)
    ok(outcome.ok && outcome.json === '["undefined","undefined","undefined","undefined","function"]', '只注入 agent/parallel/pipeline/phase/log/args，没有 require、process、fetch、定时器', outcome.ok ? outcome.json : outcome.error)
  }

  for (const [label, body, pattern] of [
    ['Date.now()', 'return Date.now()', /Date\.now\(\)/],
    ['Math.random()', 'return Math.random()', /Math\.random\(\)/],
    ['无参 new Date()', 'return new Date().getTime()', /new Date\(\)/],
    ['Date()', 'return Date()', /Date\(\)/],
    ['eval', 'return eval("1+1")', /Code generation from strings disallowed|EvalError/i],
    ['new Function', 'return new Function("return 1")()', /Code generation from strings disallowed|EvalError/i]
  ]) {
    const { outcome } = await run(body)
    ok(!outcome.ok && pattern.test(outcome.error), `${label} 让运行失败`, JSON.stringify(outcome))
  }
  {
    const { outcome } = await run(`return [new Date(0).toISOString(), new Date('2026-01-01T00:00:00Z').getUTCFullYear(), Date.UTC(2020, 0, 1)]`)
    ok(outcome.ok && JSON.parse(outcome.json)[1] === 2026, '带参数的 new Date 与 Date.UTC 照常可用', outcome.ok ? outcome.json : outcome.error)
  }
  {
    const { outcome, fatals } = await run(`try { Date.now() } catch {}\nreturn 1`)
    ok(!outcome.ok && fatals.length === 1, '脚本捕获了 Date.now() 的异常也照样失败（不静默）')
  }

  {
    const reply = async (seq, prompt) => {
      await delay(prompt === 'a' ? 30 : 1)
      if (prompt === 'b' || prompt === 'y') return { ok: false, error: '子代理失败' }
      if (prompt === 'c') return { ok: false, stopped: true, error: '已停止' }
      return { ok: true, json: JSON.stringify({ seq, prompt }) }
    }
    const { outcome, calls } = await run(`const items = await parallel([agent('a'), agent('b'), () => agent('c'), () => agent('d')])\nconst piped = await pipeline(['x', 'y', 'z', 'w'], (item, i) => i < 2 ? agent(item) : item.toUpperCase())\nreturn { items, piped }`, { reply })
    const value = outcome.ok ? JSON.parse(outcome.json) : null
    ok(value && value.items.length === 4 && value.items[0].prompt === 'a' && value.items[1] === null && value.items[2] === null && value.items[3].prompt === 'd', 'parallel 按原顺序返回（先完成的不插队），失败和被停的位置是 null', JSON.stringify(outcome))
    ok(value && value.piped.length === 4 && value.piped[0].prompt === 'x' && value.piped[1] === null && value.piped[2] === 'Z' && value.piped[3] === 'W', 'pipeline 按原顺序返回、保留 null 位置', JSON.stringify(value?.piped))
    ok(calls.map((call) => `${call.seq}:${call.prompt}`).join() === '0:a,1:b,2:c,3:d,4:x,5:y', 'agent() 序号按调用顺序分配', calls.map((call) => `${call.seq}:${call.prompt}`).join())
  }

  {
    const { outcome } = await run(`const r = await agent('a')\nreturn r`, { reply: async () => ({ ok: false, error: '子代理失败：额度用完' }) })
    ok(!outcome.ok && /额度用完/.test(outcome.error), '直接 await 的失败抛错并结束运行', JSON.stringify(outcome))
  }
  {
    const { outcome } = await run(`try { await agent('a') } catch (error) { return 'caught:' + (error instanceof Error) }`, { reply: async () => ({ ok: false, error: 'x' }) })
    ok(outcome.ok && JSON.parse(outcome.json) === 'caught:true', '脚本可以捕获失败，错误对象是脚本自己的 Error')
  }
  {
    const { outcome } = await run(`return await agent('a')`, { reply: async () => ({ ok: false, stopped: true, error: '已停止' }) })
    ok(outcome.ok && outcome.json === 'null', '直接 await 的被停调用返回 null')
  }
  {
    const { outcome } = await run(`const r = await agent('a', { schema: { type: 'object' } })\nreturn Object.getPrototypeOf(r) === Object.prototype`, { reply: async () => ({ ok: true, json: '{"x":1}' }) })
    ok(outcome.ok && outcome.json === 'true', '结构化结果是脚本自己的普通对象')
  }

  {
    const { outcome, calls } = await run(`return await parallel(Array.from({ length: 1001 }, (_, i) => () => agent('x' + i)))`)
    ok(!outcome.ok && /1000/.test(outcome.error) && calls.length === 0, 'parallel 超过 1000 项直接报错、不截断、一个也不派', outcome.error)
  }
  {
    const { outcome } = await run(`return await pipeline(Array.from({ length: 1001 }, (_, i) => i), (i) => i)`)
    ok(!outcome.ok && /1000/.test(outcome.error), 'pipeline 超过 1000 项直接报错')
  }
  {
    const { outcome } = await run(`return (await pipeline(Array.from({ length: 1000 }, (_, i) => i), (i) => i * 2)).length`)
    ok(outcome.ok && outcome.json === '1000', '正好 1000 项可以')
  }
  {
    const { outcome, calls } = await run(`return await parallel(Array.from({ length: 6 }, (_, i) => () => agent('x' + i)))`, { maxAgents: 5 })
    ok(!outcome.ok && /最多 5 个/.test(outcome.error) && calls.length === 5, '超过单次运行的代理上限直接报错，parallel 里也不变成 null', JSON.stringify(outcome))
  }
  {
    const { outcome } = await run(`const list = []\nfor (let i = 0; i < 201; i += 1) list.push(agent('x' + i))\nreturn (await Promise.all(list)).length`)
    ok(!outcome.ok && /200/.test(outcome.error), '默认上限 200 个 agent() 调用')
  }
  {
    const { outcome, calls } = await run(`return await parallel([agent('ok'), agent('x', { bogus: 1 })])`)
    ok(!outcome.ok && /bogus/.test(outcome.error) && calls.length === 1, 'agent() 参数不合法让整个运行失败，不悄悄变成 null', JSON.stringify(outcome))
  }
  {
    const { outcome } = await run(`return await agent(42)`)
    ok(!outcome.ok && /prompt/.test(outcome.error), 'prompt 不是字符串时报错')
  }
  {
    const { outcome } = await run(`return { f() {} }.f`)
    ok(outcome.ok && outcome.json === 'null', '不能转成 JSON 的返回值记为 null')
  }
  {
    const { outcome } = await run(`const a = {}\na.self = a\nreturn a`)
    ok(!outcome.ok && /JSON/.test(outcome.error), '循环引用的返回值报错')
  }
  {
    const { outcome } = await run(`\nthrow new Error('boom')`)
    ok(!outcome.ok && /boom/.test(outcome.error) && /第 3 行/.test(outcome.error), '脚本抛错带行号', outcome.error)
  }
})
