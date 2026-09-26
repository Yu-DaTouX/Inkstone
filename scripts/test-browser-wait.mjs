/**
 * `yan browser wait` 条件判定的单元测试（实施-27 S5）。
 *
 * 等待循环本身要连着浏览器，测不了；这里钉的是最容易出错的部分：
 *   · 没有条件要**拒绝**（一个"什么都不等"的 wait 会白等满超时）；
 *   · `--gone` 必须配 `--ref`（文本/地址"消失"没法可靠判定）；
 *   · 叠加条件是**且**，不是或；
 *   · 超时被夹在 [100, 60000]，非数字回落默认值。
 */

export async function runBrowserWaitTests(ok, mod) {
  const { parseWaitCondition, waitSatisfied, describeWait, WAIT_TIMEOUT_MAX_MS, WAIT_TIMEOUT_MIN_MS, WAIT_TIMEOUT_DEFAULT_MS } = mod

  const obs = (over = {}) => ({
    url: 'https://example.com/a',
    text: '加载完成',
    elements: [{ ref: 'e1' }, { ref: 'e2' }],
    ...over
  })

  /* ---- ① 参数校验 ---- */
  {
    const none = parseWaitCondition({})
    ok(none.ok === false && none.code === 'missing_condition', '没有任何条件时拒绝（不白等）')

    const gone = parseWaitCondition({ gone: true, text: 'x' })
    ok(gone.ok === false && gone.code === 'missing_ref', '--gone 单配文本时拒绝（缺少 ref）')

    const onlyGone = parseWaitCondition({ gone: true })
    ok(onlyGone.ok === false, '只有 --gone 也算没有条件')

    const byRef = parseWaitCondition({ ref: 'e1' })
    ok(byRef.ok === true && byRef.condition.ref === 'e1', '按 ref 等待可解析')

    const trimmed = parseWaitCondition({ text: '  完成  ' })
    ok(trimmed.ok === true && trimmed.condition.text === '完成', '条件文本会 trim（不把空白当条件）')

    const blank = parseWaitCondition({ text: '   ', ref: 'e1' })
    ok(blank.ok === true && blank.condition.text === undefined, '全空白文本不算条件（不会因它永不满足）')
  }

  /* ---- ② 超时夹取 ---- */
  {
    ok(parseWaitCondition({ ref: 'e1' }).timeoutMs === WAIT_TIMEOUT_DEFAULT_MS, `不传 timeout 用默认 ${WAIT_TIMEOUT_DEFAULT_MS}ms`)
    ok(parseWaitCondition({ ref: 'e1', timeout: 1 }).timeoutMs === WAIT_TIMEOUT_MIN_MS, `过小的 timeout 抬到下限 ${WAIT_TIMEOUT_MIN_MS}`)
    ok(
      parseWaitCondition({ ref: 'e1', timeout: 10 * 60_000 }).timeoutMs === WAIT_TIMEOUT_MAX_MS,
      `过大的 timeout 压到上限 ${WAIT_TIMEOUT_MAX_MS}`
    )
    ok(parseWaitCondition({ ref: 'e1', timeout: 'nope' }).timeoutMs === WAIT_TIMEOUT_DEFAULT_MS, '非数字 timeout 回落默认值')
    ok(parseWaitCondition({ ref: 'e1', 'timeout-ms': 3000 }).timeoutMs === 3000, '也认 --timeout-ms 这种写法')
  }

  /* ---- ③ 判定 ---- */
  {
    ok(waitSatisfied({ ref: 'e1' }, obs()) === true, 'ref 出现 → 满足')
    ok(waitSatisfied({ ref: 'e9' }, obs()) === false, 'ref 不在 → 不满足')
    ok(waitSatisfied({ ref: 'e1', gone: true }, obs()) === false, '等消失但还在 → 不满足')
    ok(waitSatisfied({ ref: 'e9', gone: true }, obs()) === true, '等消失且已不在 → 满足')

    ok(waitSatisfied({ text: '加载' }, obs()) === true, '文本包含 → 满足')
    ok(waitSatisfied({ text: '加载中' }, obs()) === false, '文本不包含 → 不满足')
    ok(waitSatisfied({ url: '/a' }, obs()) === true, '地址包含 → 满足')
    ok(waitSatisfied({ url: '/b' }, obs()) === false, '地址不包含 → 不满足')
  }

  /* ---- ④ 叠加是「且」 ---- */
  {
    ok(waitSatisfied({ ref: 'e1', text: '加载完成' }, obs()) === true, '两个都满足 → 满足')
    ok(waitSatisfied({ ref: 'e1', text: '不存在的字' }, obs()) === false, '一个满足一个不满足 → 不满足（是「且」不是「或」）')
    /*
     * 最容易写错的一条：`gone` 与 `text` 叠加。
     * 「元素消失」+「出现了别的东西」= 这两个都要成立才继续。
     */
    ok(
      waitSatisfied({ ref: 'e9', gone: true, text: '加载完成' }, obs()) === true,
      '消失条件与文本条件同时成立 → 满足'
    )
    ok(
      waitSatisfied({ ref: 'e9', gone: true, text: '还在加载' }, obs()) === false,
      '元素已消失但文本还没出现 → 仍不满足'
    )
  }

  /* ---- ⑤ 描述文案（超时报错要用） ---- */
  {
    const d = describeWait({ ref: 'e1', text: '完成', url: '/done' })
    ok(d.includes('e1') && d.includes('完成') && d.includes('/done'), '描述把三个条件都写出来')
    ok(d.includes('且'), '描述里说明是「且」关系')
    ok(describeWait({ ref: 'e1', gone: true }).includes('消失'), 'gone 的描述是「消失」而不是「出现」')
  }
}
