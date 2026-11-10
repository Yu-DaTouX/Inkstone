#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-timeline-flight-'))
const outfile = join(dir, 'timeline-flight.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/timeline-flight.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { planFlight, flightTravel, flightPhase, landingIndices, FLIGHT_INSET_PX } = await import(pathToFileURL(outfile).href)

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const VIEW = 900

try {
  check('落点留白是 24px', () => assert.equal(FLIGHT_INSET_PX, 24))

  check('零距离不动', () => {
    const plan = planFlight(0, VIEW)
    assert.equal(plan.duration, 0)
    assert.equal(flightTravel(plan, 0, 0), 0)
  })

  check('近跳走单段缓入缓出，时长 200 到 420ms', () => {
    for (const distance of [40, 300, 900, 1200]) {
      const plan = planFlight(distance, VIEW)
      assert.equal(plan.far, false, `distance ${distance}`)
      assert.ok(plan.duration >= 200 && plan.duration <= 420, `duration ${plan.duration}`)
    }
  })

  check('远跳三段，总时长有上限，与距离无关地封顶', () => {
    const durations = [2000, 20_000, 300_000, 3_000_000].map((distance) => planFlight(distance, VIEW))
    for (const plan of durations) {
      assert.equal(plan.far, true)
      assert.ok(plan.duration <= 520, `duration ${plan.duration}`)
      assert.equal(plan.leadMs + plan.cruiseMs + plan.landMs, plan.duration)
    }
    assert.ok(durations[0].duration <= durations[1].duration)
    assert.equal(durations[2].duration, durations[3].duration)
  })

  check('位移从 0 单调走到终点，不回退', () => {
    for (const distance of [120, 1300, 2000, 9000, 300_000]) {
      const plan = planFlight(distance, VIEW)
      let previous = 0
      for (let elapsed = 0; elapsed <= plan.duration + 20; elapsed += 4) {
        const travel = flightTravel(plan, elapsed, distance)
        assert.ok(travel >= previous - 1e-6, `distance ${distance} elapsed ${elapsed}: ${travel} < ${previous}`)
        assert.ok(travel <= distance + 1e-6)
        previous = travel
      }
      assert.equal(flightTravel(plan, 0, distance), 0)
      assert.equal(flightTravel(plan, plan.duration, distance), distance)
    }
  })

  check('远跳的起步和落地都在可读的速度内', () => {
    const distance = 300_000
    const plan = planFlight(distance, VIEW)
    const leadEnd = flightTravel(plan, plan.leadMs, distance)
    assert.ok(Math.abs(leadEnd - VIEW * 0.35) < 1, `lead ${leadEnd}`)
    const landStart = flightTravel(plan, plan.leadMs + plan.cruiseMs, distance)
    assert.ok(Math.abs(distance - landStart - VIEW * 0.6) < 1, `land ${distance - landStart}`)
    const frame = 1000 / 60
    const firstLandingStep = flightTravel(plan, plan.leadMs + plan.cruiseMs + frame, distance) - landStart
    assert.ok(firstLandingStep < VIEW * 0.12, `first landing step ${firstLandingStep}`)
    const lastStep = distance - flightTravel(plan, plan.duration - frame, distance)
    assert.ok(lastStep < 1, `last step ${lastStep}`)
  })

  check('段与段之间位置连续', () => {
    const distance = 50_000
    const plan = planFlight(distance, VIEW)
    for (const boundary of [plan.leadMs, plan.leadMs + plan.cruiseMs]) {
      const before = flightTravel(plan, boundary - 0.001, distance)
      const after = flightTravel(plan, boundary + 0.001, distance)
      assert.ok(Math.abs(after - before) < 1, `boundary ${boundary}: ${before} -> ${after}`)
    }
  })

  check('终点途中变化时仍收敛到新终点', () => {
    const plan = planFlight(40_000, VIEW)
    assert.equal(flightTravel(plan, plan.duration, 43_000), 43_000)
    const late = flightTravel(plan, plan.duration - 30, 43_000)
    assert.ok(late > 43_000 - VIEW * 0.6 && late < 43_000)
  })

  check('阶段划分', () => {
    const plan = planFlight(100_000, VIEW)
    assert.equal(flightPhase(plan, 0), 'lead')
    assert.equal(flightPhase(plan, plan.leadMs + 1), 'cruise')
    assert.equal(flightPhase(plan, plan.leadMs + plan.cruiseMs + 1), 'land')
    assert.equal(flightPhase(plan, plan.duration), 'done')
    assert.equal(flightPhase(planFlight(300, VIEW), 10), 'land')
  })

  check('预挂载行优先保目标与其后一行，数量有上限', () => {
    assert.deepEqual(landingIndices(10, [], 100), [9, 10, 11, 12])
    assert.deepEqual(landingIndices(0, [], 3), [0, 1, 2])
    assert.deepEqual(landingIndices(99, [97, 98], 100), [97, 98, 99])
    const many = landingIndices(50, Array.from({ length: 40 }, (_, i) => 30 + i), 100)
    assert.equal(many.length, 12)
    assert.ok(many.includes(50) && many.includes(51) && many.includes(49))
  })

  process.stdout.write(`timeline-flight: ${pass} 项通过\n`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
