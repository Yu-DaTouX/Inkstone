/*
 * 工具磁贴布局契约（实施-12 U-0，cost 0）。
 *
 * 验证：旧字段迁移出来的 toolLayout 覆盖全部已知分区；写入 floating 后经过一次
 * 「不相关 patch」触发主进程重新读盘，toolLayout 仍在 —— 证明它真的落了盘，
 * 不是只停在渲染端内存里。最后恢复原布局，不污染真实设置。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    const yan = window.yan
    const before = await yan.getSettings()
    const layout = before.toolLayout
    ok(!!layout && layout.version === 2 && Array.isArray(layout.tiles), 'settings 里有版本化 toolLayout')
    const ids = (layout?.tiles ?? []).map((t) => t.id)
    ok(ids.length >= 8 && new Set(ids).size === ids.length, `迁移后覆盖全部已知分区且无重复（${ids.length}）`)
    ok(layout?.tiles.every((t) => t.placement === 'docked'), '默认只有停靠，没有浮动/库位（实施-20 U5 后不再产生 library）')

    /* 写一个浮动态，再触发一次不相关 patch 让主进程重新读盘 */
    const target = 'queue'
    const floated = {
      version: 2,
      revision: (layout?.revision ?? 0) + 1,
      tiles: layout.tiles.map((t) => (t.id === target ? { ...t, placement: 'floating', rect: { x: 0.7, y: 0.7, w: 0.25, h: 0.25 } } : t))
    }
    await yan.patchSettings({ toolLayout: floated })
    await yan.patchSettings({}) // 空 patch：invalidate + 重读文件
    const after = await yan.getSettings()
    const q = after.toolLayout?.tiles.find((t) => t.id === target)
    ok(q?.placement === 'floating', `写入后经重新读盘仍在（${target}=${q?.placement}）`)
    ok(q?.rect && q.rect.x <= 0.75 && q.rect.y <= 0.75, '浮动 rect 落在可用区内')

    /* 非法坐标归一化：越界 rect 会被读盘归一夹回 */
    await yan.patchSettings({
      toolLayout: {
        version: 2,
        revision: after.toolLayout.revision + 1,
        tiles: after.toolLayout.tiles.map((t) => (t.id === target ? { ...t, placement: 'floating', rect: { x: 9, y: -9, w: 0.2, h: 0.2 } } : t))
      }
    })
    await yan.patchSettings({})
    const clamped = (await yan.getSettings()).toolLayout.tiles.find((t) => t.id === target)
    ok(clamped?.rect.x === 0.8 && clamped?.rect.y === 0, '越界坐标读盘时夹回可见区')

    /* 恢复原布局 */
    await yan.patchSettings({ toolLayout: layout })
    await yan.patchSettings({})
    const restored = (await yan.getSettings()).toolLayout.tiles.find((t) => t.id === target)
    ok(restored?.placement === (layout.tiles.find((t) => t.id === target)?.placement ?? 'docked'), '恢复默认不动业务数据')

    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
