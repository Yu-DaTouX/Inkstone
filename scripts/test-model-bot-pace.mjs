import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { paintDue } = await compile('src/renderer/src/patterns/model-bot/clock.ts')
  const run = (steps) => {
    const entry = { dirty: false, moved: false }
    return steps.map(([active, paced]) => paintDue(entry, active, paced))
  }

  const settled = run([[true, true], [true, false], [false, false], [false, false]])
  ok(settled[0] && !settled[1], '在动时只在节拍上画')
  ok(settled[2], '从在动变静止的那一帧即使不在节拍上也补画一次静止姿态')
  ok(!settled[3], '静止后不再重画')

  const onBeat = run([[true, true], [false, true], [false, true]])
  ok(onBeat[1] && !onBeat[2], '停下的那一帧恰在节拍上时只画一次')

  const idle = run([[false, true], [false, false]])
  ok(!idle[0] && !idle[1], '一直静止且没有标脏时不画')

  const entry = { dirty: true, moved: false }
  ok(paintDue(entry, false, false) && !entry.dirty, '标脏时立即画并清除标记')
  ok(paintDue({ dirty: true, moved: false }, true, false), '在动但不在节拍上时，标脏仍立即画')
  const marked = { dirty: true, moved: false }
  paintDue(marked, true, false)
  ok(paintDue(marked, false, false), '标脏画的是运动中的姿态时，停下后仍补画静止姿态')
})
