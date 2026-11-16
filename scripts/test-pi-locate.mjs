import './lib/test-isolate.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  console.log('\n--- 11. pi 定位：来源分类 ---')
  const { resolvePi, bundledAvailable, piInfo, resetPiVersionCache } = await compile('src/main/protocol.ts')

  const piTmp = await mkdtemp(join(tmpdir(), 'yan-pi-'))
  const fakeCli = join(piTmp, 'fake-cli.js')
  await writeFile(fakeCli, '// stub\n', 'utf8')

  process.env.YAN_PI_BIN = fakeCli
  const envProbe = resolvePi()
  ok(envProbe.source === 'env', 'YAN_PI_BIN 命中时来源 = env', `source=${envProbe.source}`)
  ok(envProbe.args.includes(fakeCli), 'env 命中时参数指向该入口')

  const ovProbe = resolvePi({ override: fakeCli })
  ok(ovProbe.source === 'override', 'piBin 优先于 YAN_PI_BIN', `source=${ovProbe.source}`)
  ok(ovProbe.home === undefined || typeof ovProbe.home === 'string', 'home 字段类型正确')

  delete process.env.YAN_PI_BIN

  resetPiVersionCache()
  const piInfoRes = await piInfo(fakeCli, { fresh: true })
  ok(piInfoRes.source === 'override', 'piInfo 透传来源', `source=${piInfoRes.source}`)
  ok(piInfoRes.bin === fakeCli, 'piInfo.bin 为指定入口')
  ok(typeof piInfoRes.bundledAvailable === 'boolean', 'piInfo.bundledAvailable 是布尔')

  await rm(piTmp, { recursive: true, force: true })
})
