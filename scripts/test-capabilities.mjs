import { readYanCliGroups } from './helpers/yan-cli-groups.mjs'

export async function runCapabilityCatalogTests(ok, modules) {
  const caps = modules.capabilities
  const skill = modules.skill
  const catalog = modules.catalog

  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'yan-capabilities-'))

  const cap = (id, extra = {}) => ({
    id,
    kind: 'skill',
    title: id.replace(/^skill:/, ''),
    description: '默认描述文字',
    source: { owner: 'user', location: `C:\\skills\\${id}.md` },
    availability: 'ready',
    effect: 'read',
    ...extra
  })

  {
    const tokens = caps.tokenizeCapabilityQuery('压缩上下文 compaction')
    ok(tokens.includes('compaction'), 'tokenize：ASCII 词进词元')
    ok(tokens.includes('压缩') && tokens.includes('缩上'), 'tokenize：CJK 单字与 bigram 进词元')
    ok(!tokens.includes(' '), 'tokenize：空白不进词元')
  }

  {
    const result = caps.searchCapabilities(
      [
        cap('skill:compaction', { title: '上下文压缩', description: '把长会话压成摘要' }),
        cap('skill:docx', { title: '文档导出', description: '导出 Word 文档' })
      ],
      { queryText: '压缩' }
    )
    ok(result.hits.length === 1, 'search：只命中相关能力')
    ok(result.hits[0].capability.id === 'skill:compaction', 'search：命中正确的 id')
    ok(result.hits[0].matched.includes('title'), 'search：报告命中位置（title）')
  }

  {
    const result = caps.searchCapabilities([cap('skill:a')], { queryText: '完全不存在的词' })
    ok(result.hits.length === 0, 'search：无命中时 hits 为空')
    ok(typeof result.reason === 'string' && result.reason.length > 0, 'search：无命中时给出可读 reason')
    ok(result.considered === 1, 'search：reason 里带上检查条数')
  }

  {
    const many = Array.from({ length: 30 }, (_, i) => cap(`skill:s${i}`, { title: `工具 ${i}` }))
    const result = caps.searchCapabilities(many, { queryText: '工具', limit: 5 })
    ok(result.hits.length === 5, 'search：limit 生效')
  }

  {
    const list = [cap('skill:z'), cap('skill:a'), cap('skill:m')]
    const first = caps.searchCapabilities(list, { queryText: '' })
    const second = caps.searchCapabilities([...list].reverse(), { queryText: '' })
    ok(first.hits.length === 3, 'search：空 query 列出全部')
    ok(
      first.hits.map((h) => h.capability.id).join(',') === second.hits.map((h) => h.capability.id).join(','),
      'search：空 query 的顺序与输入顺序无关（稳定排序）'
    )
  }

  {
    const result = caps.searchCapabilities(
      [
        cap('skill:mine', { projectScope: 'proj-a' }),
        cap('skill:other', { projectScope: 'proj-b' }),
        cap('skill:global')
      ],
      { queryText: '', projectId: 'proj-a' }
    )
    const ids = result.hits.map((h) => h.capability.id)
    ok(ids.includes('skill:mine'), 'isolation：本项目的能力可见')
    ok(!ids.includes('skill:other'), 'isolation：别的项目的能力不可见')
    ok(ids.includes('skill:global'), 'isolation：无 projectScope 的能力对所有项目可见')
  }

  {
    const result = caps.searchCapabilities([cap('skill:private', { projectScope: 'proj-b' })], {
      queryText: '',
      projectId: undefined
    })
    ok(result.hits.length === 0, 'isolation：没有项目身份时看不到别人的私有能力')
  }

  {
    const result = caps.searchCapabilities(
      [cap('skill:off', { availability: 'disabled' }), cap('skill:thin', { description: '  ' })],
      { queryText: '' }
    )
    ok(result.hits.length === 0, 'quality：禁用与空描述的能力都不进候选')
  }

  {
    const result = caps.searchCapabilities([cap('skill:auth', { availability: 'needs-auth' })], { queryText: '' })
    ok(result.hits.length === 1, 'quality：needs-auth 的能力仍然可见（不可用 ≠ 不存在）')
  }

  {
    const a = cap('skill:dup', { source: { owner: 'user', location: 'C:\\u\\dup.md' } })
    const b = cap('skill:dup', { source: { owner: 'project', location: 'C:\\p\\dup.md' } })
    const { capabilities, conflicts } = caps.dedupeCapabilities([a, b])
    ok(capabilities.length === 1, 'dedupe：同 ID 只留一份')
    ok(capabilities[0].source.location === 'C:\\u\\dup.md', 'dedupe：先到先得')
    ok(conflicts.includes('skill:dup'), 'dedupe：来源不同的冲突被记录')
  }

  {
    const { conflicts } = caps.dedupeCapabilities([cap('skill:same'), cap('skill:same')])
    ok(conflicts.length === 0, 'dedupe：同一来源的重复不算冲突')
  }

  {
    const commands = [
      { name: 'help', source: 'pi', executable: true },
      { name: 'skill:probe-skill', source: 'skill', location: 'C:\\agent\\skills\\probe-skill\\SKILL.md', description: '探测技能', executable: false },
      { name: 'skill:no-path', source: 'skill', description: '没有路径', executable: false },
      { name: 'skill:not-md', source: 'skill', location: 'C:\\agent\\skills\\x\\README.md', description: '不是 SKILL.md', executable: false },
      { name: 'skill:relative', source: 'skill', location: 'skills\\rel\\SKILL.md', description: '相对路径', executable: false },
      {
        name: 'skill:sqlite',
        source: 'skill',
        sourceInfo: { path: 'C:\\agent\\skills\\sqlite\\SKILL.md', source: 'auto', scope: 'user' },
        description: 'SQLite 技能',
        executable: false
      }
    ]
    const records = skill.skillsFromCommands(commands)
    const ids = records.map((r) => r.capability.id)
    ok(
      ids.length === 2 && ids.includes('skill:probe-skill') && ids.includes('skill:sqlite'),
      'skill 投影：只认 source=skill 且有绝对 SKILL.md 路径的项，且能从 sourceInfo.path 取路径'
    )
    const probe = records.find((r) => r.capability.id === 'skill:probe-skill')
    ok(probe && probe.capability.effect === 'read', 'skill 投影：技能是只读材料，不是可调用 API')
    ok(
      probe && probe.baseDir === 'C:\\agent\\skills\\probe-skill',
      'skill 投影：baseDir 取 SKILL.md 所在目录'
    )
    ok(
      records.find((r) => r.capability.id === 'skill:sqlite')?.baseDir === 'C:\\agent\\skills\\sqlite',
      'skill 投影：sourceInfo.path 的 baseDir 也正确'
    )
  }

  {
    const body = skill.stripSkillFrontmatter('---\nname: x\ndescription: y\n---\n\n# 标题\n正文\n')
    ok(body === '# 标题\n正文', 'frontmatter：被剥掉，正文保留')
    const noFm = skill.stripSkillFrontmatter('# 标题\n\n---\n\n还有一段\n')
    ok(noFm.includes('还有一段'), 'frontmatter：正文里的 --- 不被当成分隔符吃掉')
    const unterminated = skill.stripSkillFrontmatter('---\nname: x\n没有结束')
    ok(unterminated.length > 0, 'frontmatter：没有结束标记时不把正文吞光')
  }

  {
    const agentsDir = join(root, 'agent')
    const skillDir = join(agentsDir, 'skills', 'demo-skill')
    await mkdir(skillDir, { recursive: true })
    const file = join(skillDir, 'SKILL.md')
    await writeFile(file, '---\nname: demo-skill\ndescription: 单测用技能\n---\n\n# demo-skill\n\n按步骤做。\n', 'utf8')
    const commands = [
      { name: 'skill:demo-skill', source: 'skill', location: file, description: '单测用技能', executable: false }
    ]
    const read = await skill.readSkillById(commands, 'skill:demo-skill')
    ok(read.body.startsWith('# demo-skill'), 'read：读到正文（frontmatter 已剥离）')
    ok(/^[0-9a-f]{64}$/.test(read.contentHash), 'read：给出 sha256 内容 hash')
    const again = await skill.readSkillById(commands, 'skill:demo-skill')
    ok(again.contentHash === read.contentHash, 'read：同一内容 hash 稳定')

    await writeFile(file, '---\nname: demo-skill\ndescription: 单测用技能\n---\n\n# demo-skill v2\n', 'utf8')
    const changed = await skill.readSkillById(commands, 'skill:demo-skill')
    ok(changed.contentHash !== read.contentHash, 'read：正文变化后 hash 变化')

    let notFound = null
    try {
      await skill.readSkillById(commands, 'skill:nope')
    } catch (error) {
      notFound = error
    }
    ok(notFound instanceof Error, 'read：找不到技能时抛错（不静默返回空）')
  }

  {
    const built = catalog.buildCatalog([
      { name: 'skill:x', source: 'skill', location: 'C:\\agent\\skills\\x\\SKILL.md', description: '技能 X', executable: false }
    ])
    ok(built.capabilities.some((c) => c.id === 'builtin:tasks.apply'), 'catalog：包含内置能力')
    ok(built.capabilities.some((c) => c.id === 'skill:x'), 'catalog：包含已加载技能')
    ok(
      built.capabilities.every((c) => c.source.owner === 'yan' || c.source.owner === 'user'),
      'catalog：来源只由宿主赋予'
    )
    ok(built.conflicts.length === 0, 'catalog：无冲突时 conflicts 为空')
  }

  {
    const mcpEntries = [
      { serverId: 'alpha', toolName: 'search', description: '在 alpha 里搜', schemaRevision: 'rev-a' },
      { serverId: 'beta', toolName: 'search', description: '在 beta 里搜', schemaRevision: 'rev-b' },
      { serverId: 'alpha', toolName: 'silent' }
    ]
    const built = catalog.buildCatalog([], mcpEntries)
    const mcpIds = built.capabilities.filter((c) => c.kind === 'mcp-tool').map((c) => c.id)
    ok(mcpIds.length === 3, 'MCP：三条工具都进了目录', mcpIds.join(','))
    ok(mcpIds.includes('mcp:alpha/search') && mcpIds.includes('mcp:beta/search'), 'MCP：同名工具不合并')
    ok(built.conflicts.length === 0, 'MCP：不同服务的同名工具不算冲突')

    const alpha = built.capabilities.find((c) => c.id === 'mcp:alpha/search')
    ok(alpha?.title === 'alpha · search', 'MCP：标题带服务名', String(alpha?.title))
    ok(/在 alpha 里搜（MCP 服务 alpha 的工具 search）/.test(alpha?.description ?? ''), 'MCP：描述拼上归属，不丢来源')
    ok(alpha?.schemaRevision === 'rev-a', 'MCP：schemaRevision 进目录（供 describe 对齐版本）')
    ok(built.capabilities.filter((c) => c.kind === 'mcp-tool').every((c) => c.effect === 'unknown'), 'MCP：默认 effect 为 unknown（不自报权限）')
    ok(
      alpha?.source.location === 'yan mcp describe --server alpha --tool search',
      'MCP：location 是可直接执行的命令形状',
      String(alpha?.source.location)
    )

    const silent = built.capabilities.find((c) => c.id === 'mcp:alpha/silent')
    ok((silent?.description.length ?? 0) >= 4, 'MCP：缺描述时补齐归属，不变成不可发现')
    ok(silent?.schemaRevision === undefined, 'MCP：没有 inputSchema 时不给假的 schemaRevision')

    const usables = built.capabilities.filter((c) => c.kind === 'mcp-tool').length
    ok(usables === 3, 'MCP：三条都通过可用性过滤（真的能被搜到）')

    const search = caps.searchCapabilities(built.capabilities, { queryText: 'alpha 里搜索' })
    ok(search.hits.some((h) => h.capability.id === 'mcp:alpha/search'), 'MCP：按目标能搜到工具', search.hits.map((h) => h.capability.id).join(','))
  }

  {
    const groups = readYanCliGroups()
    const builtins = catalog.BUILTIN_CAPABILITIES
    const uncovered = groups
      .map((group) => group.group)
      .filter((group) => !builtins.some((c) => String(c.source.location).startsWith(`yan ${group}`)))
    ok(uncovered.length === 0, `能力目录覆盖 yan CLI 的每个命令组（缺：${uncovered.join(', ') || '无'}）`)

    const catalogIds = builtins.map((c) => c.id)
    ok(new Set(catalogIds).size === catalogIds.length, '内置能力 id 不重复')
    ok(builtins.every((c) => c.kind === 'builtin' && c.source.owner === 'yan'), '内置能力来源与类型一致')

    const built = catalog.buildCatalog([])
    const search = caps.searchCapabilities(built.capabilities, { queryText: '联网搜索 网页' })
    ok(search.hits.some((h) => h.capability.id === 'builtin:search'), '搜「联网搜索」能命中 search 组', search.hits.map((h) => h.capability.id).join(','))
    const docs = caps.searchCapabilities(built.capabilities, { queryText: '开发文档 文档库' })
    ok(docs.hits.some((h) => h.capability.id === 'builtin:search'), '搜「文档库」也能命中 search 组（含 search docs）', docs.hits.map((h) => h.capability.id).join(','))
  }

  await rm(root, { recursive: true, force: true })
}
