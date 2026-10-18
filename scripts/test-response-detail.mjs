export async function runResponseDetailTests(ok) {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'yan-detail-'))
  const prev = process.env.YAN_DATA_DIR
  process.env.YAN_DATA_DIR = dir
  try {
    const mod = await import('../resources/pi-extensions/response-detail.js')
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
    const sections = {}
    const sectioned = await list[0]({ systemPrompt: 'BASE PROMPT', systemPromptOptions: { sections } })
    ok(sectioned === undefined && /BRIEF/.test(sections.inkstone_response_detail ?? ''), '有具名分区时只写分区、不返回整段提示')

    await setMode('detailed')
    const detailed = await list[0]({ systemPrompt: 'BASE PROMPT' })
    ok(/DETAILED/.test(detailed?.systemPrompt ?? ''), 'detailed 档写明了 DETAILED')

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
