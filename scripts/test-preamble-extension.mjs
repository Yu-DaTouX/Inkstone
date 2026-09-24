/**
 * 系统提示开场白扩展（resources/pi-extensions/preamble.js）的单测。
 *
 * 为什么值得钉住：它做的是**定点字符串替换**，替换失败有两种坏法：
 *   ① 认不出原生句 → 静默不生效（用户看到英文开场白，却以为改了）；
 *   ② 替换范围失控 → 把 pi 自己维护的段落一起改掉/删掉。
 * 两种都只能在真实请求里才看得出来，所以这里把机制确定性地测掉。
 */
export async function runPreambleExtensionTests(ok, mod) {
  const { NATIVE_PREAMBLE, YAN_PREAMBLE, default: extension } = mod

  ok(typeof NATIVE_PREAMBLE === 'string' && NATIVE_PREAMBLE.startsWith('You are an expert coding assistant'), '导出的原生句就是 pi 的英文 preamble')
  ok(typeof YAN_PREAMBLE === 'string' && YAN_PREAMBLE.includes('Yan'), '导出的砚开场白包含产品名 Yan')
  ok(YAN_PREAMBLE.includes('coding agent harness') && !YAN_PREAMBLE.includes('inside pi,'), '开场白保持英文措辞，只换产品名')

  const handlers = {}
  extension({ on: (name, fn) => (handlers[name] = fn) })
  ok(typeof handlers.before_agent_start === 'function', '扩展注册了 before_agent_start')

  const run = (base) => handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: base }, {})

  const base = `${NATIVE_PREAMBLE}\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise\n</rules>`
  const out = run(base)
  ok(out?.systemPrompt?.startsWith(YAN_PREAMBLE), '原生开场白被替换成砚的英文开场白', String(out?.systemPrompt).slice(0, 60))
  ok(out.systemPrompt === `${YAN_PREAMBLE}\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise\n</rules>`, '只替换开场白这一句，其余段落逐字保留')
  ok(!out.systemPrompt.includes(NATIVE_PREAMBLE), '替换后不再包含原生英文句')

  ok(run('BASE') === undefined, '认不出原生开场白时不改动（返回 undefined）')
  ok(run('') === undefined, '空系统提示也不改动')
  ok(run(`${YAN_PREAMBLE}\n\n<tools>`) === undefined, '幂等：已替换过的提示不再重复替换')
}
