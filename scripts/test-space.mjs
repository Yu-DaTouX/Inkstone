/**
 * 主题空间（实施-25 P02）的单测：契约纯逻辑 + 存储。
 *
 * 为什么值得单测：
 *   · 「空间 ↔ 项目」的关联是多对多记录（不是外键）—— 写成一对一在界面上看不出来，
 *     只会在「同一个 repo 属于两个空间」时静默丢一边；
 *   · 归档 ≠ 删除（资料引用按 identity+version 绑定）—— 删错了要等资料库片子才暴露。
 */

export function runSpaceTests(ok, mod) {
  const {
    validateSpaceInput,
    makeSpaceId,
    spacesForProject,
    projectsForSpace,
    activeSpaces,
    linkKey,
    MAX_SPACE_NAME
  } = mod

  /* ---- 校验 ---- */
  {
    const good = validateSpaceInput({ name: ' 英语学习 ', description: ' 每天一小时 ' })
    ok(good.ok === true && good.value.name === '英语学习' && good.value.description === '每天一小时', '合法输入去首尾空白')

    ok(validateSpaceInput({ name: '' }).ok === false, '空名称被拒')
    ok(validateSpaceInput({ name: '   ' }).ok === false, '只有空白的名称被拒')
    ok(validateSpaceInput({ name: 'x'.repeat(MAX_SPACE_NAME + 1) }).ok === false, '超长名称被拒')
    ok(validateSpaceInput({ name: 'a\u0000b' }).ok === false, '名称含控制字符被拒')
    ok(validateSpaceInput({ name: 'a', description: 'x'.repeat(500) }).ok === false, '超长描述被拒')
    ok(validateSpaceInput({ name: 'a', description: null }).ok === true, '描述可为空')
    ok(validateSpaceInput(null).ok === false, '非对象输入被拒')
  }

  /* ---- id 生成 ---- */
  {
    const taken = new Set(['sp_fixed'])
    const id = makeSpaceId((x) => taken.has(x), () => 0.5)
    ok(typeof id === 'string' && id.startsWith('sp_'), 'id 带 sp_ 前缀')
    const id2 = makeSpaceId((x) => x === id, () => 0.5)
    ok(id2 !== id, '撞 id 时会重试到不重复', id2)
  }

  /* ---- 关联：多对多 ---- */
  {
    const links = [
      { spaceId: 'sp1', projectId: 'p1', at: 1 },
      { spaceId: 'sp1', projectId: 'p2', at: 2 },
      { spaceId: 'sp2', projectId: 'p1', at: 3 }
    ]
    ok(spacesForProject(links, 'p1').join(',') === 'sp1,sp2', '一个项目可以属于多个空间', spacesForProject(links, 'p1').join(','))
    ok(projectsForSpace(links, 'sp1').join(',') === 'p1,p2', '一个空间可以关联多个项目', projectsForSpace(links, 'sp1').join(','))
    ok(spacesForProject(links, 'nope').length === 0, '没有关联时返回空数组')
    ok(
      linkKey({ spaceId: 'sp1', projectId: 'p1', at: 1 }) !== linkKey({ spaceId: 'sp2', projectId: 'p1', at: 1 }),
      '不同空间 + 同一项目是两条不同的关联'
    )
  }

  /* ---- 活动列表：归档不进列表 ---- */
  {
    const spaces = [
      { id: 'a', name: 'A', archived: false, createdAt: 1, updatedAt: 10 },
      { id: 'b', name: 'B', archived: true, createdAt: 1, updatedAt: 20 },
      { id: 'c', name: 'C', archived: false, createdAt: 1, updatedAt: 30 }
    ]
    const active = activeSpaces(spaces)
    ok(active.length === 2 && active[0].id === 'c' && active[1].id === 'a', '归档空间不在活动列表，其余按更新时间倒序', active.map((s) => s.id).join(','))
  }
}

export async function runSpaceStoreTests(ok, mod, helpers) {
  const { SpaceStore, sanitizeSpaceDocument } = mod
  const { mkdtemp, readFile, rm } = helpers
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'yan-space-'))
  try {
    const store = new SpaceStore({ root, now: () => 1000, random: () => 0.25 })

    /* ---- 建空间 ---- */
    const created = await store.create({ name: '英语学习', description: '每天一小时' })
    ok(created.ok === true && created.space.name === '英语学习', '创建空间')
    ok(created.ok === true && created.space.archived === false, '新建空间默认未归档')
    const id = created.ok ? created.space.id : ''

    ok((await store.create({ name: '' })).ok === false, '空名建空间被拒')
    ok((await store.create({ name: 'x'.repeat(200) })).ok === false, '超长名建空间被拒')

    /* ---- 改 ---- */
    const renamed = await store.update(id, { name: '英语学习 · 进阶' })
    ok(renamed.ok === true && renamed.space.name === '英语学习 · 进阶', '改名')
    const cleared = await store.update(id, { description: null })
    ok(cleared.ok === true && cleared.space.description === undefined, '描述可清空')
    ok((await store.update('nope', { name: 'x' })).error === 'not-found', '改不存在的空间报 not-found')

    /* ---- 归档是唯一移除入口 ---- */
    const archived = await store.update(id, { archived: true })
    ok(archived.ok === true && archived.space.archived === true, '空间可归档')
    ok(store.find(id)?.archived === true, '归档后仍能从存储里查到（不是删除）')
    ok(store.list().length === 1, '归档空间仍在 list（含归档）')

    /* ---- 关联记录 ---- */
    await store.linkProject(id, 'p1')
    await store.linkProject(id, 'p1')
    ok(store.links().length === 1, '同一对关联重复建立是幂等的', String(store.links().length))
    await store.linkProject(id, 'p2')
    ok(store.links().length === 2, '不同项目各自一条关联')
    ok((await store.linkProject('nope', 'p1')).ok === false, '给不存在的空间建关联被拒')
    await store.unlinkProject(id, 'p1')
    ok(store.links().length === 1 && store.links()[0].projectId === 'p2', '解除关联只删那一条')

    /* ---- 落盘 + 读回 ---- */
    {
      const raw = JSON.parse(await readFile(join(root, 'spaces.json'), 'utf8'))
      ok(raw.version === 1, '文档带 schema 版本')
      const reloaded = new SpaceStore({ root })
      await reloaded.load()
      ok(reloaded.find(id)?.name === '英语学习 · 进阶', '重启后空间与改名仍在')
      ok(reloaded.links().length === 1, '重启后关联仍在')
    }

    /* ---- 坏文档：坏条目与孤儿关联都丢掉 ---- */
    {
      const doc = sanitizeSpaceDocument({
        version: 1,
        spaces: [{ id: 'sp9', name: '正常', archived: false, createdAt: 1, updatedAt: 2 }, { id: '', name: 'x' }, 'bad'],
        links: [
          { spaceId: 'sp9', projectId: 'p1', at: 1 },
          { spaceId: 'ghost', projectId: 'p1', at: 1 },
          { spaceId: 'sp9', projectId: 'p1', at: 2 }
        ]
      })
      ok(doc.spaces.length === 1 && doc.spaces[0].id === 'sp9', '坏空间条目被丢弃')
      ok(doc.links.length === 1, '孤儿关联与重复关联被丢弃', String(doc.links.length))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
