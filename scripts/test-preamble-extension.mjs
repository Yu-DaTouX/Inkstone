/**
 * 系统提示开场白扩展（resources/pi-extensions/preamble.js）的单测。
 *
 * 为什么值得钉住：它做的是**定点字符串替换**，替换失败有两种坏法：
 *   ① 认不出原生句 → 静默不生效（用户看到英文开场白，却以为改了）；
 *   ② 替换范围失控 → 把 pi 自己维护的段落一起改掉/删掉。
 * 两种都只能在真实请求里才看得出来，所以这里把机制确定性地测掉。
 */
export async function runPreambleExtensionTests(ok, mod) {
  const { NATIVE_PREAMBLE, YAN_PREAMBLE, PROGRESS_GUIDANCE, default: extension } = mod

  ok(typeof NATIVE_PREAMBLE === 'string' && NATIVE_PREAMBLE.startsWith('You are an expert coding assistant'), '导出的原生句就是 pi 的英文 preamble')
  ok(typeof YAN_PREAMBLE === 'string' && YAN_PREAMBLE.includes('Inkstone'), '导出的砚开场白包含产品名 Inkstone')
  ok(YAN_PREAMBLE.includes('underlying execution engine') && !YAN_PREAMBLE.includes('inside pi,'), '开场白保持英文措辞，只换产品名')

  const handlers = {}
  extension({ on: (name, fn) => (handlers[name] = fn) })
  ok(typeof handlers.before_agent_start === 'function', '扩展注册了 before_agent_start')

  const run = (base) => handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: base }, {})

  const base = `${NATIVE_PREAMBLE}\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise\n</rules>`
  const out = run(base)
  ok(out?.systemPrompt?.startsWith(YAN_PREAMBLE), '原生开场白被替换成砚的英文开场白', String(out?.systemPrompt).slice(0, 60))
  ok(out.systemPrompt === `${YAN_PREAMBLE}\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise\n</rules>\n\n${PROGRESS_GUIDANCE}`, '原生规则逐字保留，末尾追加简短进展约定')
  ok(!out.systemPrompt.includes(NATIVE_PREAMBLE), '替换后不再包含原生英文句')

  ok(run('BASE').systemPrompt === `BASE\n\n${YAN_PREAMBLE}\n\n${PROGRESS_GUIDANCE}`, '未知原生开场白保留原文并补充砚身份和进展约定')
  ok(run('').systemPrompt.includes(YAN_PREAMBLE), '空系统提示仍包含砚身份')
  ok(run(out.systemPrompt) === undefined, '幂等：身份和进展约定不重复追加')
  ok(run(`${YAN_PREAMBLE}\n\n<tools>`).systemPrompt.endsWith(PROGRESS_GUIDANCE), '旧身份提示补齐进展约定')
  ok(PROGRESS_GUIDANCE.includes('requests silence') && PROGRESS_GUIDANCE.includes('without narrating each routine call'), '进展约定尊重静默要求，不逐条播报工具')
}
