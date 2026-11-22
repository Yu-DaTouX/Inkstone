import './lib/test-isolate.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  console.log('\n--- 11. pi 定位：来源分类 ---')
  const { resolvePi, bundledAvailable, piInfo, resetPiVersionCache } = await compile('src/main/protocol.ts')

  const piTmp = await mkdtemp(join(tmpdir(), 'yan-pi-'))
  const previousBin = process.env.YAN_PI_BIN
  const fakeCli = join(piTmp, 'fake-cli.cjs')
  const nextCli = join(piTmp, 'next-cli.cjs')
  const flag = join(piTmp, 'release')
  try {
    await writeFile(fakeCli, 'console.log("1.2.3")\n')
    await writeFile(nextCli, 'console.log("4.5.6")\n')

    process.env.YAN_PI_BIN = fakeCli
    const envProbe = resolvePi()
    ok(envProbe.source === 'env', 'YAN_PI_BIN 命中时来源 = env', `source=${envProbe.source}`)
    ok(envProbe.args.includes(fakeCli), 'env 命中时参数指向该入口')

    const ovProbe = resolvePi({ override: fakeCli })
    ok(ovProbe.source === 'override', 'piBin 优先于 YAN_PI_BIN', `source=${ovProbe.source}`)
    ok(ovProbe.home === undefined || typeof ovProbe.home === 'string', 'home 字段类型正确')

    resetPiVersionCache()
    const piInfoRes = await piInfo(fakeCli, { fresh: true })
    ok(piInfoRes.source === 'override', 'piInfo 透传来源', `source=${piInfoRes.source}`)
    ok(piInfoRes.bin === fakeCli, 'piInfo.bin 为指定入口')
    ok(typeof piInfoRes.bundledAvailable === 'boolean', 'piInfo.bundledAvailable 是布尔')
    ok(piInfoRes.version === '1.2.3', '读到首个入口的版本号')
    const changed = await piInfo(nextCli)
    ok(changed.bin === nextCli && changed.version === '4.5.6', '切换入口时，版本号与新入口匹配', changed.version)

    await writeFile(fakeCli, `const fs = require('node:fs');\nconst timer = setInterval(() => {\n  if (!fs.existsSync(${JSON.stringify(flag)})) return;\n  clearInterval(timer);\n  console.log('1.2.3');\n}, 10);\n`)
    const stale = piInfo(fakeCli, { fresh: true })
    try {
      resetPiVersionCache()
      ok((await piInfo(nextCli, { fresh: true })).version === '4.5.6', '旧探测未完成时，重新探测可先返回新入口版本')
    } finally {
      await writeFile(flag, '')
      await stale
    }
    ok((await stale).version === '1.2.3', '旧探测仍向原调用方返回自己的版本')
    ok((await piInfo(nextCli)).version === '4.5.6', '旧入口迟到的回执不能污染新入口的版本缓存')
  } finally {
    if (previousBin === undefined) delete process.env.YAN_PI_BIN
    else process.env.YAN_PI_BIN = previousBin
    await rm(piTmp, { recursive: true, force: true })
  }
})
