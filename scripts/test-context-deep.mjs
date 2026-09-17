/**
 * Deep Context（N21-8）的单测。
 *
 * 为什么值得钉住：它是**唯一**会在用户提问前同步阻塞一次模型调用的部分。
 * 它的失败模式是两头都静默的 ——
 *   · 「该跑的时候没跑」：用户以为打开了，其实没生效；
 *   · 「不该跑的时候跑了」：每一轮都多花一次调用、多等最多 30 秒。
 * 两者都不会让应用崩，只是让一个可选优化变成隐形负担或隐形失效，
 * 所以只能靠这里的断言 + live 场景里的诊断行（`hook: 'deep'`）发现。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runContextDeepTests(ok, { deep, extension }) {
  const {
    DEEP_MIN_TOKENS,
    DEEP_INPUT_TOKENS,
    WORKING_TRACE_MAX_CHARS,
    WORKING_TRACE_CUSTOM_TYPE,
    DEEP_SYSTEM_PROMPT,
    deepEligible,
    deepSwitches,
    messageText,
    turnKeyOf,
    buildDeepInput,
    buildDeepPrompt,
    parseDeepOutput,
    renderWorkingTrace,
    injectWorkingTrace,
    hasWorkingTrace
  } = deep

  /* ---------------- 闸门：四道缺一不可 ---------------- */
  ok(deepEligible({ enabled: false, tokens: 9e9, hasNewTurn: true }).reason === 'disabled', 'deep·默认（未开）不跑')
  ok(DEEP_MIN_TOKENS === 150_000, 'deep·默认门槛是 150k（参考方案 §14 的 >200k 按可用上下文折算）')
  ok(
    deepEligible({ enabled: true, tokens: 1e6, hasNewTurn: false }).reason === 'no-new-user-turn',
    'deep·没有新的用户消息不跑（否则就是为同一次提问重复烧钱）'
  )
  ok(
    deepEligible({ enabled: true, tokens: 1e6, hasNewTurn: true, ranForTurn: true }).reason === 'already-ran-this-turn',
    'deep·同一条用户消息只跑一次'
  )
  ok(
    deepEligible({ enabled: true, tokens: DEEP_MIN_TOKENS - 1, hasNewTurn: true }).reason === 'below-threshold',
    'deep·差 1 token 不跑（短会话里归纳出来的东西没有价值）'
  )
  ok(deepEligible({ enabled: true, tokens: DEEP_MIN_TOKENS, hasNewTurn: true }).ok === true, 'deep·够门槛就跑')
  ok(
    deepEligible({ enabled: true, tokens: 1e6, hasNewTurn: true, minTokens: 20_000 }).ok === true,
    'deep·门槛可被策略下调'
  )

  /* ---------------- 策略解析 ---------------- */
  ok(deepSwitches(undefined).enabled === false, 'deep·策略缺失 = 关闭')
  ok(deepSwitches({ enabled: 'yes' }).enabled === false, 'deep·只有布尔 true 才算开（不认真值字符串）')
  ok(deepSwitches({ enabled: true }).enabled === true, 'deep·enabled:true 生效')
  ok(deepSwitches({ enabled: true, minTokens: '5' }).minTokens === 0, 'deep·非法 minTokens 被忽略（回落默认门槛）')
  ok(deepSwitches({ enabled: true, minTokens: 20_000 }).minTokens === 20_000, 'deep·合法 minTokens 生效')

  /* ---------------- 消息文本与回合标识 ---------------- */
  ok(messageText({ content: 'abc' }) === 'abc', 'deep·字符串 content')
  ok(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'a\nb', 'deep·块数组 content')
  ok(messageText({ content: [{ type: 'image' }] }) === '', 'deep·非文本块被忽略')

  const turn = [
    { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
    { role: 'user', content: [{ type: 'text', text: '第二轮：修一下 gate' }] }
  ]
  ok(turnKeyOf(turn).includes('第二轮'), 'deep·回合标识取**最后一条** user 消息')
  ok(turnKeyOf([]) === '', 'deep·没有 user 消息时标识为空')
  ok(turnKeyOf([{ role: 'user', content: [{ type: 'text', text: '   ' }] }]) === '', 'deep·空白 user 消息不算一个回合')

  /* ---------------- Pass 1 输入：有界 + 截头留尾 + 从尾部装 ---------------- */
  const long = 'y'.repeat(5000)
  const input = buildDeepInput([
    { role: 'toolResult', content: [{ type: 'text', text: long }] },
    { role: 'user', content: [{ type: 'text', text: '最后的问题' }] }
  ])
  ok(input.text.includes('（前略）'), 'deep·长工具输出截**头**留尾（结论在后面）')
  ok(input.text.includes('最后的问题'), 'deep·从尾部往前装（越近的越重要）')
  ok(input.text.indexOf('工具结果') < input.text.indexOf('最后的问题'), 'deep·装完仍是时间顺序（渲染要能读）')
  ok(input.tokens <= DEEP_INPUT_TOKENS, `deep·输入有界（${input.tokens} ≤ ${DEEP_INPUT_TOKENS}）`)
  ok(buildDeepInput([]).text === '', 'deep·没有材料时不编造')

  const many = Array.from({ length: 200 }, (_, i) => ({
    role: 'user',
    content: [{ type: 'text', text: `第 ${i} 条 ` + 'z'.repeat(400) }]
  }))
  /* 明确传一个小上限：这条验的是「有界」这个性质，不该依赖默认值与输入长度的巧合 */
  const bounded = buildDeepInput(many, { limitTokens: 2_000 })
  ok(bounded.tokens <= 2_000, `deep·超长转录被截到给定上限（${bounded.tokens}）`)
  ok(bounded.text.includes('第 199 条'), 'deep·被保留的是最新的那些')
  ok(!bounded.text.includes('第 0 条'), 'deep·最旧的进了截断的那一侧')

  ok(buildDeepPrompt('材料').includes('<materials>'), 'deep·材料与要求分开（模型要能分清两者）')
  ok(buildDeepPrompt('').includes('（没有材料）'), 'deep·空材料也有明确占位')
  ok(DEEP_SYSTEM_PROMPT.includes('不要编造'), 'deep·系统提示明确禁止编造（与状态生成器同一条约束）')

  /* ---------------- 解析：容忍围栏 / "无" / 超长 ---------------- */
  ok(parseDeepOutput('```md\n- 目标：X\n```').text === '- 目标：X', 'deep·去掉代码围栏')
  ok(parseDeepOutput('').ok === false, 'deep·空输出不注入')
  ok(parseDeepOutput('  \n ').ok === false, 'deep·纯空白不注入')
  ok(parseDeepOutput('无').ok === false, 'deep·「无」= 没什么可归纳（不注入而不是报错）')
  ok(parseDeepOutput('N/A').reason === 'nothing', 'deep·英文 none 也认')
  const huge = parseDeepOutput('- x'.repeat(3000))
  ok(huge.text.length <= WORKING_TRACE_MAX_CHARS + 1, `deep·超长输出被截断（${huge.text.length}）`)

  /* ---------------- 渲染：authority 契约 ---------------- */
  const block = renderWorkingTrace('- 目标：修压缩', { sourceHead: 42, turns: 7 })
  ok(block.includes('derived="true"'), 'deep·注入块声明是派生的')
  ok(block.includes('authoritative="false"'), 'deep·注入块声明不是用户指令（它以 user 角色到达模型）')
  ok(block.includes('sourceHead="42"') && block.includes('turns="7"'), 'deep·可选水位写进契约头')
  ok(renderWorkingTrace('') === '', 'deep·空文本渲染出空串')
  ok(!renderWorkingTrace('- x').includes('sourceHead'), 'deep·拿不到水位就不写这一项（不编造）')

  /* ---------------- 注入：幂等 + 插到最前 ---------------- */
  const before = [
    { role: 'user', content: [{ type: 'text', text: '历史' }] },
    { role: 'custom', customType: 'yan-task-state', content: [{ type: 'text', text: '<TASK_STATE/>' }] }
  ]
  const injected = injectWorkingTrace(before, block)
  ok(injected.injected === true, 'deep·注入标记为真')
  ok(injected.messages[0].customType === WORKING_TRACE_CUSTOM_TYPE, 'deep·插到最前（与 <TASK_STATE> 位置一致）')
  ok(injected.messages.length === before.length + 1, 'deep·只多一条消息')
  ok(hasWorkingTrace(injected.messages), 'deep·hasWorkingTrace 认得出来')
  ok(
    injected.messages.some((m) => m.customType === 'yan-task-state'),
    'deep·与 <TASK_STATE> 共存（两者不是互相替换的关系）'
  )
  const twice = injectWorkingTrace(injected.messages, block)
  ok(twice.messages.length === injected.messages.length, 'deep·重复注入是幂等的（摘掉旧的再插）')
  const cleared = injectWorkingTrace(injected.messages, '')
  ok(cleared.injected === false && !hasWorkingTrace(cleared.messages), 'deep·空文本 = 摘掉旧块且不注入')
  ok(cleared.messages.length === before.length, 'deep·摘掉后回到原长度')

  /*
   * ---------------- 开关的第二个来源：`YAN_CONTEXT_DEEP` ----------------
   * 用户设置走这个专用 env（砚不会把设置写进 `YAN_CONTEXT_POLICY`，因为后者是
   * 优先级高于设置面板的测试通道）。这里把两种来源的**优先关系**也钉住：
   * 顺序写反的话，场景会被用户设置静默改掉，而现象是「测试莫名其妙失效」。
   */
  const prevDeep = process.env.YAN_CONTEXT_DEEP
  const prevPolicyEnv = process.env.YAN_CONTEXT_POLICY
  const prevDataDir = process.env.YAN_DATA_DIR
  const restore = () => {
    if (prevDeep === undefined) delete process.env.YAN_CONTEXT_DEEP
    else process.env.YAN_CONTEXT_DEEP = prevDeep
    if (prevPolicyEnv === undefined) delete process.env.YAN_CONTEXT_POLICY
    else process.env.YAN_CONTEXT_POLICY = prevPolicyEnv
    if (prevDataDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = prevDataDir
    extension.__internals.resetDeepCache()
  }
  try {
    delete process.env.YAN_CONTEXT_POLICY
    process.env.YAN_CONTEXT_DEEP = '1'
    ok(extension.__internals.policy().deep.enabled === true, 'deep·YAN_CONTEXT_DEEP=1 打开（用户设置走这条路）')
    process.env.YAN_CONTEXT_DEEP = 'true'
    ok(extension.__internals.policy().deep.enabled === true, 'deep·也认 true')
    process.env.YAN_CONTEXT_DEEP = '0'
    ok(extension.__internals.policy().deep.enabled === false, 'deep·YAN_CONTEXT_DEEP=0 关闭')
    process.env.YAN_CONTEXT_DEEP = 'yes'
    ok(extension.__internals.policy().deep.enabled === false, 'deep·认不出的值当没表态（宁可不开）')
    delete process.env.YAN_CONTEXT_DEEP
    ok(extension.__internals.policy().deep.enabled === false, 'deep·两个来源都没表态时是关的（默认值）')

    process.env.YAN_CONTEXT_POLICY = '{"deep":{"enabled":true}}'
    process.env.YAN_CONTEXT_DEEP = '0'
    ok(
      extension.__internals.policy().deep.enabled === true,
      'deep·测试通道（YAN_CONTEXT_POLICY）优先于用户开关 —— 否则场景会被用户设置静默改掉'
    )

    /*
     * 第三个来源：桌面端设置（`desktop.json` 的 `contextDeep.enabled`）。
     * 这是**用户真正能按到的那个开关**，所以重点验两件事：
     *   ① 「改完立即生效」（不重建 pi 实例）—— 它是每轮读文件换来的性质；
     *   ② env 里的 `0` 是**明确关**，不该被设置里的 `true` 盖掉。
     * 另外真的要往磁盘写：所以用临时 `YAN_DATA_DIR`，并在最后删掉缓存。
     */
    delete process.env.YAN_CONTEXT_POLICY
    delete process.env.YAN_CONTEXT_DEEP
    const tmpDir = mkdtempSync(join(tmpdir(), 'yan-deep-'))
    try {
      process.env.YAN_DATA_DIR = tmpDir
      extension.__internals.resetDeepCache()
      ok(extension.__internals.policy().deep.enabled === false, 'deep·设置文件不存在时是关的')

      writeFileSync(join(tmpDir, 'desktop.json'), JSON.stringify({ contextDeep: { enabled: true } }))
      extension.__internals.resetDeepCache()
      ok(
        extension.__internals.policy().deep.enabled === true,
        'deep·设置里 enabled:true 打开（用户开关，无需重建实例）'
      )

      writeFileSync(join(tmpDir, 'desktop.json'), JSON.stringify({ contextDeep: { enabled: false } }))
      extension.__internals.resetDeepCache()
      ok(extension.__internals.policy().deep.enabled === false, 'deep·设置里 enabled:false 关闭')

      writeFileSync(join(tmpDir, 'desktop.json'), '{ 环掉的 JSON')
      extension.__internals.resetDeepCache()
      ok(extension.__internals.policy().deep.enabled === false, 'deep·设置文件坏了当没表态（宁可不开）')

      writeFileSync(join(tmpDir, 'desktop.json'), JSON.stringify({ contextDeep: { enabled: true } }))
      process.env.YAN_CONTEXT_DEEP = '0'
      extension.__internals.resetDeepCache()
      ok(extension.__internals.policy().deep.enabled === false, 'deep·env 的 0 是明确关（不被设置里的 true 盖掉）')
      delete process.env.YAN_CONTEXT_DEEP
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  } finally {
    restore()
  }
}
