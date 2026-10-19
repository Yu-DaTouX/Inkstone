export async function runRailSectionsTests(ok, rail) {
  const {
    RAIL_SECTION_IDS,
    resolveRailOrder,
    moveRailSection,
    isRailSectionOpen,
    isRailSectionHidden,
    railSectionsAreDefault,
    withRailSectionOpen,
    parseRailSections,
    canHideRailSection
  } = rail
  const base = { order: [], hidden: [], foldsBySession: {} }

  ok(resolveRailOrder([]).join() === RAIL_SECTION_IDS.join(), '没有保存顺序时使用默认顺序')
  const partial = resolveRailOrder(['changes', 'environment'])
  ok(partial.length === RAIL_SECTION_IDS.length, '保存顺序缺分区时补齐')
  ok(partial.indexOf('changes') < partial.indexOf('environment'), '保留用户保存的相对顺序')
  ok(partial.indexOf('backgroundTasks') > partial.indexOf('environment'), '缺失分区插回默认位置附近')
  ok(resolveRailOrder(['bogus', 'context', 'context']).filter((id) => id === 'context').length === 1, '去重并丢弃未知分区')

  const moved = moveRailSection(RAIL_SECTION_IDS, 'changes', 'environment', 'before')
  ok(moved[0] === 'changes' && moved.length === RAIL_SECTION_IDS.length, '移到目标之前')
  const after = moveRailSection(RAIL_SECTION_IDS, 'environment', 'settings', 'after')
  ok(after[0] === 'settings' && after[1] === 'environment', '移到目标之后')
  ok(moveRailSection(RAIL_SECTION_IDS, 'context', 'context', 'before').join() === RAIL_SECTION_IDS.join(), '移到自己不变')

  ok(isRailSectionOpen(base, 's1', 'environment') === true, '环境默认展开')
  ok(isRailSectionOpen(base, 's1', 'context') === false, '上下文默认折叠')
  ok(isRailSectionOpen(base, 's1', 'connectors') === false, '连接器默认折叠')
  const folds = withRailSectionOpen(base, 's1', 'context', true)
  ok(isRailSectionOpen({ ...base, foldsBySession: folds }, 's1', 'context') === true, '展开默认折叠的分区')
  ok(isRailSectionOpen({ ...base, foldsBySession: folds }, 's2', 'context') === false, '折叠状态按会话隔离')
  const closed = withRailSectionOpen(base, 's1', 'outputs', false)
  ok(isRailSectionOpen({ ...base, foldsBySession: closed }, 's1', 'outputs') === false, '折叠默认展开的分区')
  const reverted = withRailSectionOpen({ ...base, foldsBySession: closed }, 's1', 'outputs', true)
  ok(!('s1' in reverted), '回到默认状态时不留记录')

  let many = {}
  for (let i = 0; i < 105; i++) many = withRailSectionOpen({ ...base, foldsBySession: many }, 's' + i, 'outputs', false)
  ok(Object.keys(many).length === 100 && !('s0' in many) && 's104' in many, '最多记住 100 个会话并淘汰最旧')

  ok(canHideRailSection('environment') === false, '环境分区不可隐藏')
  ok(isRailSectionHidden({ hidden: ['environment'] }, 'environment') === false, '隐藏列表里的环境也不生效')
  ok(isRailSectionHidden({ hidden: ['usage'] }, 'usage') === true, '可隐藏其他分区')

  ok(railSectionsAreDefault(base) === true, '初始为默认')
  ok(railSectionsAreDefault({ order: [], hidden: ['usage'] }) === false, '隐藏分区后不是默认')
  ok(railSectionsAreDefault({ order: moved, hidden: [] }) === false, '调整顺序后不是默认')
  ok(railSectionsAreDefault({ order: [...RAIL_SECTION_IDS], hidden: [] }) === true, '顺序与默认一致仍算默认')

  const parsed = parseRailSections(JSON.stringify({ order: ['changes', 'x'], hidden: ['environment', 'usage'], foldsBySession: { a: { collapsed: ['outputs'], expanded: [] }, b: 3 } }))
  ok(parsed.order.join() === 'changes', '读取存储时丢弃未知分区')
  ok(parsed.hidden.join() === 'usage', '读取存储时丢弃不可隐藏的分区')
  ok(Object.keys(parsed.foldsBySession).join() === 'a', '读取存储时丢弃坏的折叠记录')
  ok(parseRailSections('{bad').order.length === 0, '存储损坏时回到空状态')
}
