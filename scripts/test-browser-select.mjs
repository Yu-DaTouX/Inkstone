export async function runBrowserSelectTests(ok, mod, errors) {
  const { SELECT_VALUE_FN } = mod
  const { NotSelectElementError, SelectOptionNotFoundError } = errors
  const registry = new errors.ElementRegistry()
  const element = { backendNodeId: 7, role: 'button', name: 'fixture', box: [0, 0, 20, 20] }
  const { refs: [ref] } = registry.refresh([element])
  ok(registry.resolve(ref).backendNodeId === 7, 'observe 返回含目标身份的有效引用')
  let crossTargetDenied = false
  const other = new errors.ElementRegistry()
  other.refresh([element])
  try { other.resolve(ref) } catch (error) { crossTargetDenied = error.code === 'STALE_ELEMENT' }
  ok(crossTargetDenied, '另一浏览器目标拒绝相同代次的引用')
  ok(registry.refresh([element]).refs[0] === ref && registry.resolve(ref).backendNodeId === 7, '同一文档重新观察时同一节点保持原引用')
  registry.clear()
  registry.refresh([element])
  let oldGenerationDenied = false
  try { registry.resolve(ref) } catch (error) { oldGenerationDenied = error.code === 'STALE_ELEMENT' }
  ok(oldGenerationDenied, '页面导航（清空登记）后旧引用失效')

  let pageFn
  try {
    pageFn = new Function(`return (${SELECT_VALUE_FN})`)()
  } catch (error) {
    ok(false, `SELECT_VALUE_FN 必须是合法的函数声明：${error?.message}`)
    return
  }
  ok(typeof pageFn === 'function', 'SELECT_VALUE_FN 能还原成函数')

  const makeSelect = (options, { value = '', tag = 'SELECT' } = {}) => {
    const el = {
      tagName: tag,
      value,
      options: options.map(([v, label]) => ({ value: v, label: label ?? '', text: label ?? '' })),
      events: [],
      dispatchEvent(event) {
        this.events.push(event.type)
        return true
      }
    }
    return el
  }

  const originalEvent = globalThis.Event
  globalThis.Event = class {
    constructor(type, init = {}) {
      this.type = type
      this.bubbles = Boolean(init.bubbles)
    }
  }

  try {
    {
      const el = makeSelect([['cn', '中国'], ['us', '美国']])
      const out = pageFn.call(el, 'us')
      ok(out?.ok === true && out.value === 'us', '按 value 选中')
      ok(out?.label === '美国', '成功时回报可见文案（人能核对选对了没有）')
      ok(el.value === 'us', '元素的值真的被改了')
      ok(el.events.includes('input') && el.events.includes('change'), '派发 input + change（受控组件不看 value 只看事件）')
    }

    {
      const el = makeSelect([['cn', '中国'], ['us', '美国']])
      const out = pageFn.call(el, '美国')
      ok(out?.ok === true && out.value === 'us', '找不到 value 时按可见文案匹配（模型常直接给"美国"）')
    }

    {
      const el = makeSelect([['cn', '中国'], ['us', '美国']])
      const out = pageFn.call(el, 'jp')
      ok(out?.ok === false && out.reason === 'no_option', '没有这个值时回 no_option')
      ok(Array.isArray(out.options) && out.options.join(',') === 'cn,us', 'no_option 时附上可选值（省一次 observe）')
      ok(el.value === '', '失败时不动元素的值')
      ok(el.events.length === 0, '失败时不派发事件（不触发半截提交）')
    }

    {
      const el = makeSelect([], { tag: 'INPUT' })
      const out = pageFn.call(el, 'x')
      ok(out?.ok === false && out.reason === 'not_select', '目标不是 select 时回 not_select')
      ok(out?.tag === 'input', 'not_select 时带上标签名；页面侧统一转小写（<input> 而不是 <INPUT>）')
    }

    {
      const el = makeSelect([['', '请选择'], ['cn', '中国']])
      const out = pageFn.call(el, '')
      ok(out?.ok === true && out.value === '', '空串能匹配到空值选项（不是"没传参数"）')
    }
  } finally {
    globalThis.Event = originalEvent
  }

  {
    const notSelect = new NotSelectElementError('e3', 'INPUT')
    ok(notSelect.code === 'NOT_SELECT', 'NOT_SELECT 是可读的业务 code')
    ok(/type|click/.test(notSelect.message), '提示里告诉模型该改用哪个动作')
    ok(notSelect.message.includes('e3'), '报错点名是哪个 ref')

    const missing = new SelectOptionNotFoundError('e3', 'jp', ['cn', 'us'])
    ok(missing.code === 'OPTION_NOT_FOUND', 'OPTION_NOT_FOUND 是可读的业务 code')
    ok(missing.message.includes('jp') && missing.message.includes('cn'), '报错里既有要找的值也有可选值')

    const many = new SelectOptionNotFoundError('e4', 'x', Array.from({ length: 30 }, (_, i) => `v${i}`))
    ok(many.message.includes('共 30 个'), '可选项很多时只列前 20 个并说明总数（别把回执撑爆）')
    ok(!many.message.includes('v25'), '第 25 个不在列举里')

    const none = new SelectOptionNotFoundError('e5', 'x', [])
    ok(none.message.includes('（空）'), '一个可选项都没有时也要说清楚（否则看起来像 bug）')
  }
}
