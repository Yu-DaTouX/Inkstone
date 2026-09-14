/**
 * 回复详细程度扩展（resources/pi-extensions/response-detail.js）。
 *
 * 为什么单独测：它是**系统提示注入** —— 写错了要么把 standard 档也改掉
 * （缓存前缀全变、行为漂移），要么三档根本没区别（用户点了没反应）。
 * 这里用假的 pi API 直接调 handler，不启动 pi、不花 token。
 */
export async function runResponseDetailTests(ok) {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'yan-detail-'))
  const prev = process.env.YAN_DATA_DIR
  process.env.YAN_DATA_DIR = dir
  try {
    const mod = await import('../resources/pi-extensions/response-detail.js')
    /** 收 handler 的假 pi */
    const handlers = {}
    const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn) } }
    mod.default(pi)

    const list = handlers['before_agent_start'] ?? []
    ok(list.length === 1, '注册了一个 before_agent_start handler')

    const setMode = (v) =>
      writeFile(join(dir, 'desktop.json'), JSON.stringify({ responseDetail: v }), 'utf8')

    await setMode('standard')
    const std = await list[0]({ systemPrompt: 'BASE PROMPT' })
    ok(std === undefined || std?.systemPrompt === undefined, 'standard 档不注入任何东西（提示与缓存不变）')

    await setMode('brief')
    const brief = await list[0]({ systemPrompt: 'BASE PROMPT' })
    ok(
      typeof brief?.systemPrompt === 'string' && brief.systemPrompt.startsWith('BASE PROMPT'),
      'brief 档在原提示后面追加（不覆盖）'
    )
    ok(/BRIEF/.test(brief?.systemPrompt ?? ''), 'brief 档写明了 BRIEF')
    ok(!/DETAILED/.test(brief?.systemPrompt ?? ''), 'brief 档不含 DETAILED')

    await setMode('detailed')
    const detailed = await list[0]({ systemPrompt: 'BASE PROMPT' })
    ok(/DETAILED/.test(detailed?.systemPrompt ?? ''), 'detailed 档写明了 DETAILED')

    /* 脏值 / 缺失都回落 standard（不能让一个坏设置改变输出风格） */
    await setMode('whatever')
    const dirty = await list[0]({ systemPrompt: 'BASE PROMPT' })
    ok(dirty === undefined || dirty?.systemPrompt === undefined, '脏值回落到 standard')

    await writeFile(join(dir, 'desktop.json'), '{ not json', 'utf8')
    const broken = await list[0]({ systemPrompt: 'BASE PROMPT' })
    ok(broken === undefined || broken?.systemPrompt === undefined, '设置文件坏了也不炸，按 standard 处理')
  } finally {
    if (prev === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
}
