/**
 * 画布轮次层单测（实施-26 R3）：几何与分支对齐。
 *
 * 重点不是「算得对」，而是**失败时也不出错**：对不上就不对齐、会撞就放弃、
 * 空轮次不产生层。这些都是画布上没人会读日志、只能靠规则兜住的地方。
 */
export async function runTurnLayerTests(ok, mod) {
  const { planTurnLayers, matchOriginTurn, normalizeOriginText } = mod

  const card = (id, question) => ({ id, question })
  const NODE_H = 26
  const CARD_H = 54
  const GAP = 6
  const LAYER_GAP = 6
  const opts = { nodeH: NODE_H, cardH: CARD_H, gap: GAP, layerGap: LAYER_GAP }

  /*
   * 1. 规范化与匹配：这一层决定「子会话挂到哪一轮」，错一次就是挂错地方。
   */
  ok(normalizeOriginText('  你好\n世界 ') === '你好 世界', '规范化折叠空白与换行')

  const turns = [card('t1', '帮我读一下这段'), card('t2', '那第二段呢')]
  ok(matchOriginTurn(turns, '帮我读一下这段')?.id === 't1', '精确匹配到对应轮次')
  ok(matchOriginTurn(turns, '那第二段呢\n')?.id === 't2', '尾随换行不影响匹配')
  const truncated = [card('t1', '这是一段很长的问题原文，用来验证摘要截断时的匹配')]
  ok(
    matchOriginTurn(truncated, '这是一段很长的问题原文')?.id === 't1',
    '摘要被截断时按前缀命中'
  )
  ok(matchOriginTurn(turns, '帮我读') === undefined, '锚点太短时不做包含匹配（避免误挂）')
  ok(
    matchOriginTurn(turns, '帮我读一下这段材料里的第三句') === undefined,
    '锚点比原文还长时不猜（那不是被截断的摘要）'
  )
  ok(matchOriginTurn(turns, '完全不相干的话') === undefined, '对不上返回 undefined')
  ok(matchOriginTurn(turns, '   ') === undefined, '空锚点不做匹配')
  ok(matchOriginTurn([], 'x') === undefined, '父轮次为空时不做匹配')

  /*
   * 2. 轮次层几何：卡从节点下方开始，一层高度含卡与间距。
   */
  const simple = planTurnLayers(
    [{ path: 'a', laneKey: 'global', depth: 0, y: 100, turns: [card('t1', 'q1'), card('t2', 'q2')] }],
    opts
  )
  const layer = simple.layers.a
  ok(layer.cards.length === 2, '两张轮次卡')
  ok(layer.cards[0].y === 100 + NODE_H + LAYER_GAP, '第一张卡紧贴节点下方')
  ok(layer.cards[1].y === layer.cards[0].y + CARD_H + GAP, '第二张卡按卡高 + 间距递推')
  ok(layer.height === 2 * CARD_H + GAP, '层高含卡与卡之间距、不含首尾外间距')
  ok(layer.shift === 0 && layer.alignedTurnId === undefined, '没对齐时 shift 为 0 且不带对齐标记')
  ok(simple.nodeY.a === 100, '没有对齐时节点 y 不变')

  const four = planTurnLayers(
    [
      {
        path: 'a',
        laneKey: 'global',
        depth: 0,
        y: 0,
        turns: [1, 2, 3, 4].map((i) => card(`t${i}`, `q${i}`))
      }
    ],
    opts
  )
  ok(four.layers.a.cards[3].y === 3 * (CARD_H + GAP) + NODE_H + LAYER_GAP, '四轮时末卡 y 正确')

  /*
   * 3. 没展开的会话不产生层；展开但没有轮次也不产生层。
   */
  const none = planTurnLayers([{ path: 'a', laneKey: 'global', depth: 0, y: 0 }], opts)
  ok(Object.keys(none.layers).length === 0, '未展开的会话不进轮次层')
  const empty = planTurnLayers([{ path: 'a', laneKey: 'global', depth: 0, y: 0, turns: [] }], opts)
  ok(Object.keys(empty.layers).length === 0, '展开但没有轮次时不产生空层')
  ok(empty.align.length === 0, '空层不产生对齐报告')

  /*
   * 4. 对齐：子会话首轮落到父会话那一轮上，子节点整体上移。
   */
  const parentTurns = [card('p1', '第一轮问题'), card('p2', '分叉的那句话'), card('p3', '第三轮')]
  const aligned = planTurnLayers(
    [
      { path: 'p', laneKey: 'global', depth: 0, y: 300, turns: parentTurns },
      {
        path: 'c',
        laneKey: 'global',
        depth: 1,
        parentPath: 'p',
        y: 700,
        branchOrigin: '分叉的那句话',
        turns: [card('c1', '分叉后的第一轮'), card('c2', '第二轮')]
      }
    ],
    opts
  )
  const parentCard2 = 300 + NODE_H + LAYER_GAP + 1 * (CARD_H + GAP)
  ok(aligned.layers.c.cards[0].y === parentCard2, '子会话首轮与父会话对应轮次同 y（对齐）')
  ok(aligned.layers.c.alignedTurnId === 'p2', '对齐报告里写明对上了哪一轮')
  ok(aligned.layers.c.shift < 0, '对齐需要子会话上移（shift 为负，如实记录）')
  ok(aligned.nodeY.c === parentCard2 - NODE_H - LAYER_GAP, '节点被移到「首轮正好落位」的位置')
  ok(aligned.nodeY.p === 300, '父节点本身不动（对齐只移动子会话一侧）')
  ok(
    aligned.align.some((r) => r.path === 'c' && r.ok),
    '对齐成功的报告可见'
  )

  /*
   * 5. 对齐的失败出口：没有父 / 父没展开 / 对不上 —— 三种都要如实说，且不移动。
   */
  const noParent = planTurnLayers(
    [{ path: 'a', laneKey: 'global', depth: 0, y: 50, branchOrigin: 'x', turns: [card('t1', 'x')] }],
    opts
  )
  ok(noParent.align[0]?.reason === 'no-parent', '根会话带 branchOrigin 时报告 no-parent')
  ok(noParent.nodeY.a === 50, 'no-parent 不移动节点')

  const noLayer = planTurnLayers(
    [
      { path: 'p', laneKey: 'global', depth: 0, y: 0 },
      {
        path: 'c',
        laneKey: 'global',
        depth: 1,
        parentPath: 'p',
        y: 400,
        branchOrigin: 'x',
        turns: [card('t1', 'x')]
      }
    ],
    opts
  )
  ok(noLayer.align[0]?.reason === 'no-layer', '父未展开时报告 no-layer')
  ok(noLayer.nodeY.c === 400, 'no-layer 不移动节点')

  const noMatch = planTurnLayers(
    [
      { path: 'p', laneKey: 'global', depth: 0, y: 0, turns: [card('p1', '另一句话')] },
      {
        path: 'c',
        laneKey: 'global',
        depth: 1,
        parentPath: 'p',
        y: 400,
        branchOrigin: '对不上的话',
        turns: [card('t1', 'x')]
      }
    ],
    opts
  )
  ok(noMatch.align[0]?.reason === 'no-match', '对不上时报告 no-match')
  ok(noMatch.layers.c.cards[0].y === 400 + NODE_H + LAYER_GAP, 'no-match 时子轮次仍贴在自己节点下方')

  /*
   * 6. 防重叠：对齐会把子会话推上去，撞到同列别的会话就整条放弃。
   */
  const clash = planTurnLayers(
    [
      { path: 'p', laneKey: 'global', depth: 0, y: 0, turns: parentTurns },
      { path: 'other', laneKey: 'global', depth: 1, y: 80 },
      {
        path: 'c',
        laneKey: 'global',
        depth: 1,
        parentPath: 'p',
        y: 700,
        branchOrigin: '分叉的那句话',
        turns: [card('c1', '分叉后')]
      }
    ],
    opts
  )
  ok(clash.align[0]?.reason === 'overlap', '会撞上同列会话时报告 overlap')
  ok(clash.nodeY.c === 700, 'overlap 时放弃对齐、节点留在原位')
  ok(clash.layers.c.shift === 0, 'overlap 时 shift 为 0')
  ok(
    typeof clash.align[0]?.triedY === 'number',
    'overlap 报告里保留「本来想去的 y」便于诊断'
  )

  /* 另一个泳道的同列会话不算撞：泳道之间本来就不共享行 */
  const otherLane = planTurnLayers(
    [
      { path: 'p', laneKey: 'global', depth: 0, y: 0, turns: parentTurns },
      { path: 'other', laneKey: 'project:p1', depth: 1, y: 80 },
      {
        path: 'c',
        laneKey: 'global',
        depth: 1,
        parentPath: 'p',
        y: 700,
        branchOrigin: '分叉的那句话',
        turns: [card('c1', '分叉后')]
      }
    ],
    opts
  )
  ok(otherLane.align[0]?.ok === true, '别的泳道同列不算撞，对齐照做')

  /*
   * 7. 后代一起移动：对齐一个会话，它的（可见）子会话跟着走，相对关系不变。
   */
  const withGrand = planTurnLayers(
    [
      { path: 'p', laneKey: 'global', depth: 0, y: 0, turns: parentTurns },
      {
        path: 'c',
        laneKey: 'global',
        depth: 1,
        parentPath: 'p',
        y: 700,
        branchOrigin: '分叉的那句话',
        turns: [card('c1', '分叉后')]
      },
      { path: 'g', laneKey: 'global', depth: 2, parentPath: 'c', y: 900 }
    ],
    opts
  )
  const cShift = withGrand.nodeY.c - 700
  ok(cShift !== 0, '子会话被对齐移动了')
  ok(withGrand.nodeY.g - 900 === cShift, '后代跟着一起平移，父子相对位置不变')

  /*
   * 8. 对齐只移动子会话一侧：父的轮次卡位置完全不受影响。
   */
  ok(
    aligned.layers.p.cards[0].y === 300 + NODE_H + LAYER_GAP &&
      aligned.layers.p.cards[2].y === 300 + NODE_H + LAYER_GAP + 2 * (CARD_H + GAP),
    '父会话轮次卡不受子会话对齐影响'
  )

  /*
   * 9. 链式对齐：孙会话对齐子会话时，用的是**对齐之后**的父位置。
   */
  const chainTurns = [card('c1', '分叉后'), card('c2', '第二轮')]
  const chained = planTurnLayers(
    [
      { path: 'p', laneKey: 'global', depth: 0, y: 0, turns: parentTurns },
      {
        path: 'c',
        laneKey: 'global',
        depth: 1,
        parentPath: 'p',
        y: 700,
        branchOrigin: '分叉的那句话',
        turns: chainTurns
      },
      {
        path: 'g',
        laneKey: 'global',
        depth: 2,
        parentPath: 'c',
        y: 900,
        branchOrigin: '第二轮',
        turns: [card('g1', '孙的第一轮')]
      }
    ],
    opts
  )
  ok(chained.layers.g.alignedTurnId === 'c2', '孙会话对到子会话的第二轮')
  ok(
    chained.layers.g.cards[0].y === chained.layers.c.cards[1].y,
    '链式对齐用的是对齐后的父位置（先算父、再算子）'
  )
  ok(
    chained.nodeY.g === chained.layers.c.cards[1].y - NODE_H - LAYER_GAP,
    '孙节点位置与子会话卡位置一致'
  )
}
