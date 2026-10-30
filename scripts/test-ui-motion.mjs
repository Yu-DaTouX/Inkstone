import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const m = await load('src/renderer/src/ui/motion-model.ts')

{
  const fold = 120
  const compact = 28
  assert.deepEqual(m.condenseStep({ condensed: false, top: 0, foldHeight: fold, compactHeight: compact }), { condensed: false, scrollTo: null }, '顶部保持展开')
  assert.deepEqual(m.condenseStep({ condensed: false, top: fold + 32, foldHeight: fold, compactHeight: compact }), { condensed: false, scrollTo: null }, '恰好到进入阈值不收缩')
  const enter = m.condenseStep({ condensed: false, top: fold + 33, foldHeight: fold, compactHeight: compact })
  assert.equal(enter.condensed, true, '越过 fold+32 收缩')
  assert.equal(enter.scrollTo, fold + 33 - (fold - compact), '补偿后的 scrollTop 等于原位减去头部缩短量')
  assert.ok(enter.scrollTo >= m.CONDENSE_EXIT_AT, '补偿后的位置不会立刻触发展开（滞回）')
  for (const top of [4, 10, 50, fold + 100]) {
    assert.deepEqual(m.condenseStep({ condensed: true, top, foldHeight: fold, compactHeight: compact }), { condensed: true, scrollTo: null }, `收缩态在 ${top} 保持`)
  }
  assert.deepEqual(m.condenseStep({ condensed: true, top: 3, foldHeight: fold, compactHeight: compact }), { condensed: false, scrollTo: null }, '回到顶部 4px 内展开')
  assert.deepEqual(m.condenseStep({ condensed: false, top: 999, foldHeight: 0, compactHeight: 0 }), { condensed: false, scrollTo: null }, '没有可收内容时不动')
  assert.deepEqual(m.condenseStep({ condensed: true, top: 0, foldHeight: 0, compactHeight: 0 }), { condensed: true, scrollTo: null }, '测量为零时保持原状态')
  assert.equal(m.condenseStep({ condensed: false, top: 50, foldHeight: 10, compactHeight: 40 }).scrollTo, 80, '紧凑态更高时补偿向下')
  assert.equal(m.condenseStep({ condensed: false, top: 30, foldHeight: 1, compactHeight: 0, enterSlack: 4 }).scrollTo, 29, '自定义进入余量')
  assert.equal(m.condenseStep({ condensed: false, top: 41, foldHeight: 100, compactHeight: 0, enterSlack: -60 }).scrollTo, 0, '补偿结果不小于 0')
}

{
  assert.equal(m.compensatedScrollTop(200, 180, 88), 108, '头部变矮 92px，滚动位置同步回退 92px，正文不跳')
  assert.equal(m.compensatedScrollTop(200, 120, 120), 200, '头部高度不变（固定高度路径条）时不补偿')
  assert.equal(m.compensatedScrollTop(30, 180, 88), 0, '补偿不小于 0')
  assert.equal(m.compensatedScrollTop(50, 100, 110), 60, '紧凑态更高时向下补偿')
}

{
  assert.equal(m.rowTravel(28), 28)
  assert.equal(m.rowTravel(120), 40, '行位移封顶 40px')
  assert.equal(m.rowTravel(-3), 0)
  assert.equal(m.remainingShare(30, 0), 30)
  assert.equal(m.remainingShare(30, 0.5), 15)
  assert.equal(m.remainingShare(30, 1), 0)
  assert.equal(m.remainingShare(30, 1.4), 0, '进度越界按完成计')
  assert.equal(m.flipOffset(100, 0, 60), 40, '上移 40 的行从 +40 起播')
  assert.equal(m.flipOffset(60, 0, 100), -40)
  assert.equal(m.flipOffset(100, -12, 100), -12, '未播完的偏移会接续，不跳回原位')
}

{
  const prev = new Map([['a', { height: 28 }], ['b', { height: 28 }], ['c', { height: 0 }]])
  const next = new Map([['b', { height: 28 }], ['d', { height: 28 }], ['e', { height: 0 }]])
  assert.equal(m.listChurn(prev, next), 2, '零高行不计入进出数')
  const gate = { animate: true, measured: true, reduced: false, held: false, churn: 2 }
  assert.equal(m.listMotionAllowed(gate), true)
  assert.equal(m.listMotionAllowed({ ...gate, measured: false }), false, '首次测量不播')
  assert.equal(m.listMotionAllowed({ ...gate, reduced: true }), false, '减少动效不播')
  assert.equal(m.listMotionAllowed({ ...gate, held: true }), false, '切会话抑制窗口内不播')
  assert.equal(m.listMotionAllowed({ ...gate, animate: false }), false, '拖拽等调用方关闭时不播')
  assert.equal(m.listMotionAllowed({ ...gate, churn: 41 }), false, '一次进出超过 40 行不播')
  assert.equal(m.listMotionAllowed({ ...gate, churn: 40 }), true)
  const moved = new Map([['b', -28]])
  assert.equal(m.ridingDelta(['a', 'b', 'c'], 2, moved, () => undefined), -28, '新行跟随上方移动行的位移')
  assert.equal(m.ridingDelta(['a', 'b', 'c'], 2, new Map(), (key) => (key === 'a' ? 6 : undefined)), 6, '没有移动时取保留行的剩余位移')
  assert.equal(m.ridingDelta(['a'], 0, moved, () => 0), undefined, '首行没有可跟随的位移')
}

{
  assert.equal(m.presenceNext('closed', true, true), 'open')
  assert.equal(m.presenceNext('open', false, true), 'closing', '关闭先进入退场')
  assert.equal(m.presenceNext('open', false, false), 'closed', '不播动画时立即卸载')
  assert.equal(m.presenceNext('closing', true, true), 'open', '退场中重新打开')
  assert.equal(m.presenceNext('closing', false, false), 'closed')
  assert.equal(m.presenceNext('closed', false, true), 'closed')
}

{
  assert.equal(m.parseDuration('200ms'), 200)
  assert.equal(m.parseDuration(' 0.8s '), 800)
  assert.equal(m.parseDuration('.5s'), 500)
  assert.equal(m.parseDuration('', 150), 150)
  assert.equal(m.parseDuration('ease', 7), 7)
}

{
  const queue = []
  let id = 0
  const clock = {
    frame(callback) {
      id += 1
      queue.push({ id, callback })
      return id
    },
    cancel(target) {
      const index = queue.findIndex((item) => item.id === target)
      if (index >= 0) queue.splice(index, 1)
    }
  }
  const step = () => {
    const batch = queue.splice(0)
    for (const item of batch) item.callback()
  }
  const hold = m.createMotionHold(clock)
  const seen = []
  hold.subscribe((held) => seen.push(held))
  assert.equal(hold.held(), false)
  hold.hold()
  assert.equal(hold.held(), true, '导航当帧立即抑制')
  step()
  assert.equal(hold.held(), true, '第一帧仍抑制')
  step()
  assert.equal(hold.held(), false, '第二帧画完后放开')
  hold.hold()
  step()
  hold.hold()
  step()
  assert.equal(hold.held(), true, '窗口内再次导航会重新计两帧')
  step()
  assert.equal(hold.held(), false)
  assert.deepEqual(seen, [true, false, true, false], '只在进入与离开抑制时通知')
}

{
  assert.deepEqual(m.inkGeometry({ left: 140, width: 80 }, { left: 100, width: 400 }, 30), { x: 70, width: 80 }, '指示条位置含滚动偏移')
  assert.deepEqual(m.inkGeometry({ left: 0, width: 10 }, { left: 0, width: 10 }, 0, 6), { x: 6, width: 0 }, '内缩不出负宽度')
  assert.equal(m.staggerDelay(0, 20), 0)
  assert.equal(m.staggerDelay(3, 20), 60)
  assert.equal(m.staggerDelay(30, 20), 120, '错峰封顶 6 级')
}

const read = (path) => readFileSync(path, 'utf8')
const motionCss = read('src/renderer/src/ui/Motion.css')
assert.ok(!/\d+ms|\d\.?\d*s\b(?![-\w])/.test(motionCss.replace(/--dur-[\w-]+/g, '').replace(/\b0s\b/g, '')), 'Motion.css 只用时长令牌')
assert.ok(!/cubic-bezier|ease-in-out|\bease-out\b/.test(motionCss), 'Motion.css 只用缓动令牌')
assert.ok(motionCss.includes(':root[data-motion-hold]'), '切会话两帧抑制覆盖新基元')
const tokens = JSON.parse(read('src/renderer/src/design/tokens.json')).motion
for (const name of ['quick', 'lag', 'ease-glide', 'ease-exit']) assert.ok(tokens[name], `令牌 ${name} 存在`)
const tokenCss = read('src/renderer/src/design/tokens.css')
for (const name of ['--dur-quick', '--dur-lag', '--ease-glide', '--ease-exit']) assert.ok(tokenCss.includes(name), `生成物含 ${name}`)
const base = read('src/renderer/src/design/base.css')
assert.ok(base.includes("data-reduce-motion='true'") && base.includes('prefers-reduced-motion: reduce'), '两路减少动效仍在全局生效')
const listMotion = read('src/renderer/src/ui/list-motion.ts')
assert.ok(listMotion.includes('prefersReducedMotion()') && listMotion.includes('motionHeld()'), '脚本动画同时检查减少动效与抑制窗口')
const hold = read('src/renderer/src/features/sidebar/use-navigation-motion-hold.ts')
assert.ok(hold.includes('holdMotion()') && hold.includes('sessionFile') && hold.includes('next.key !== prev.key') && hold.includes('next.route !== prev.route'), '切会话、切面板归属与换路由时触发抑制')
assert.ok(read('src/renderer/src/features/sidebar/Sidebar.tsx').includes('useNavigationMotionHold()'), '常驻的侧栏挂上导航抑制')

console.log('ui-motion: 通过（滞回与补偿、FLIP 位移、抑制窗口、出场保留、令牌与减少动效契约）')
