export async function runQuestionFrequencyTests(ok) {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { transform, build } = await import('esbuild')

  const root = mkdtempSync(join(tmpdir(), 'yan-question-freq-'))
  const buildDir = mkdtempSync(join(tmpdir(), 'yan-question-freq-build-'))
  const previous = {
    YAN_DATA_DIR: process.env.YAN_DATA_DIR,
    YAN_PI_DIR: process.env.YAN_PI_DIR,
    YAN_SESSION_ID: process.env.YAN_SESSION_ID
  }
  process.env.YAN_DATA_DIR = root
  process.env.YAN_PI_DIR = join(root, 'pi')
  process.env.YAN_SESSION_ID = 'freq-test'
  mkdirSync(process.env.YAN_PI_DIR, { recursive: true })

  const restoreEnv = () => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }

  try {
    const sharedSource = await readFile(new URL('../src/shared/question-frequency.ts', import.meta.url), 'utf8')
    const transformed = await transform(sharedSource, { loader: 'ts', format: 'esm' })
    const shared = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`)

    const ext = await import('../resources/pi-extensions/question.js')
    const { default: extension, QUESTION_FREQUENCIES, DEFAULT_QUESTION_FREQUENCY, normalizeQuestionFrequency, currentQuestionFrequency } = ext

    ok(JSON.stringify(QUESTION_FREQUENCIES) === JSON.stringify(shared.QUESTION_FREQUENCIES), 'ext/shared：三档列表一致', JSON.stringify(QUESTION_FREQUENCIES))
    ok(DEFAULT_QUESTION_FREQUENCY === shared.DEFAULT_QUESTION_FREQUENCY && DEFAULT_QUESTION_FREQUENCY === 'balanced', 'ext/shared：默认档都是 balanced')
    const samples = [undefined, null, 0, 1, '', 'sparse', 'balanced', 'eager', 'loud', 'BALANCED', {}, [], ['eager']]
    for (const value of samples) {
      const a = normalizeQuestionFrequency(value)
      const b = shared.normalizeQuestionFrequency(value)
      ok(a === b, `ext/shared：非法 / 合法值归一化一致（${JSON.stringify(value)}）`, `${a} vs ${b}`)
    }

    const desktop = join(root, 'desktop.json')
    const handlers = {}
    extension({ on: (name, fn) => (handlers[name] = fn) })
    ok(typeof handlers.before_agent_start === 'function', '扩展：注册了 before_agent_start')

    const turn = (settings) => {
      if (settings === undefined) rmSync(desktop, { force: true })
      else writeFileSync(desktop, JSON.stringify(settings), 'utf8')
      const event = { systemPrompt: 'BASE', systemPromptOptions: { sections: {} } }
      const out = handlers.before_agent_start(event)
      return { prompt: String(out.systemPrompt ?? ''), extra: event.systemPromptOptions.sections.inkstone_question }
    }

    {
      const { prompt, extra } = turn(undefined)
      ok(prompt.includes('Question frequency: BALANCED'), '默认：desktop.json 缺失时按适中', prompt.slice(0, 80))
      ok(/^BASE\n\n/.test(prompt) && prompt === `BASE\n\n${extra}`, '拼接：只把指引追加在基础提示之后一次')
      ok(prompt.split('Question frequency:').length - 1 === 1, '拼接：频率指引只出现一份')
      ok(extra.split('Question frequency:').length - 1 === 1, '分区：具名分区里也只有一份')
      ok(prompt.includes('never relaxes approvals'), '边界：适中档也声明不放宽审批与高风险确认')
    }

    for (const bad of ['loud', '', 0, null, {}, ['eager']]) {
      const { prompt } = turn({ questionFrequency: bad })
      ok(prompt.includes('BALANCED') && !prompt.includes('SPARSE') && !prompt.includes('EAGER'), `非法值：${JSON.stringify(bad)} 归到适中`)
    }
    ok(currentQuestionFrequency() === 'balanced', 'direct：非法 fixture 读回来是适中')

    {
      const sparse = turn({ questionFrequency: 'sparse' })
      ok(sparse.prompt.includes('Question frequency: SPARSE') && !sparse.prompt.includes('EAGER'), '三档：少问给出少问指引')
      ok(/infer a reasonable reading/i.test(sparse.prompt), '少问：能合理推断就继续')
      const eager = turn({ questionFrequency: 'eager' })
      ok(eager.prompt.includes('Question frequency: EAGER') && !eager.prompt.includes('SPARSE'), '三档：多问给出多问指引')
      ok(/never ask every few steps/i.test(eager.prompt), '多问：不每几步硬提问、不重复已明确信息')
      ok(currentQuestionFrequency() === 'eager', 'direct：合法 fixture 读回来是多问')
    }

    {
      const auto = turn({ defaultWorkMode: 'autonomous', questionFrequency: 'eager' })
      ok(auto.prompt.includes('Do NOT ask the user questions'), '工作模式优先：自主档仍然不问')
      ok(!auto.prompt.includes('Question frequency:') && !auto.prompt.includes('EAGER'), '工作模式优先：自主档不叠加频率指引')
      const plan = turn({ defaultWorkMode: 'clarify', questionFrequency: 'sparse' })
      ok(plan.prompt.includes('Plan mode is ON') && plan.prompt.includes('READ-ONLY'), '工作模式优先：计划档保留只读约束')
      ok(plan.prompt.includes('Question frequency: SPARSE'), '工作模式优先：计划档叠加频率指引')
      ok(plan.prompt.includes('never relaxes approvals'), '计划档：同样保留审批边界')
    }

    {
      const first = turn({ questionFrequency: 'sparse' })
      const second = turn({ questionFrequency: 'eager' })
      ok(first.prompt.includes('SPARSE') && second.prompt.includes('EAGER') && !second.prompt.includes('SPARSE'), '热更新：下一轮读到新频率')
      const third = turn({ questionFrequency: 'loud' })
      ok(third.prompt.includes('BALANCED') && !third.prompt.includes('EAGER'), '热更新：改回非法 / 删除后回到适中')
      const removed = turn(undefined)
      ok(removed.prompt.includes('BALANCED'), '热更新：文件删除也不崩，回到适中')
    }

    const outfile = join(buildDir, 'settings.mjs')
    await build({
      entryPoints: ['src/main/settings.ts'],
      outfile,
      bundle: true,
      packages: 'external',
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
      plugins: [
        {
          name: 'electron-stub',
          setup(b) {
            b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
            b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
              contents: `export const app = { getLocale: () => 'zh-CN', getPath: () => ${JSON.stringify(root)} }`,
              loader: 'js'
            }))
          }
        }
      ]
    })
    const { getSettings, patchSettings, validateRendererSettingsPatch } = await import(pathToFileURL(outfile).href)

    ok((await getSettings()).questionFrequency === 'balanced', 'settings：缺省归一化为适中')
    ok((await patchSettings({ questionFrequency: 'sparse' })).questionFrequency === 'sparse', 'settings：合法值 sparse 保留')
    ok((await patchSettings(validateRendererSettingsPatch({ questionFrequency: 'eager' }))).questionFrequency === 'eager', 'settings：renderer allowlist 放行 questionFrequency')
    for (const bad of ['loud', '', 0, null, {}, []]) {
      ok((await patchSettings({ questionFrequency: bad })).questionFrequency === 'balanced', `settings：非法值 ${JSON.stringify(bad)} 归到适中`)
    }
    await patchSettings({ autoArchiveDays: 7 })
    await patchSettings({ questionFrequency: 'sparse' })
    const disk = JSON.parse(readFileSync(join(root, 'desktop.json'), 'utf8'))
    ok(disk.questionFrequency === 'sparse', 'settings：归一化结果落盘')
    ok(disk.autoArchiveDays === 7, 'settings：不覆盖无关设置')
    ok(JSON.parse(readFileSync(join(root, 'desktop.json'), 'utf8')).questionFrequency === 'sparse', 'settings：磁盘值与内存一致')

    ok(currentQuestionFrequency() === 'sparse', '端到端：设置写入后扩展下一轮读到 sparse')

    let blocked = false
    try {
      validateRendererSettingsPatch({ questionFrequencyX: 'eager' })
    } catch {
      blocked = true
    }
    ok(blocked, 'settings：未知设置键仍被 allowlist 拒绝')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(buildDir, { recursive: true, force: true })
    restoreEnv()
  }
}

if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  let passed = 0
  let failed = 0
  await runQuestionFrequencyTests((condition, label, detail) => {
    if (condition) passed++
    else {
      failed++
      console.error(`FAIL ${label} ${detail ?? ''}`)
    }
  })
  console.log(JSON.stringify({ passed, failed }))
  if (failed) process.exitCode = 1
}
