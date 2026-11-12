import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { ensureYanLauncher } = await compile('src/main/yan-cli.ts')
  const dir = mkdtempSync(join(tmpdir(), 'yan-launcher-'))
  try {
    const binDir = join(dir, 'bin')
    const first = ensureYanLauncher({ devResourcesDir: 'resources', execPath: 'C:/fake/electron.exe', binDir })
    ok(!!first && readFileSync(first.launcher, 'utf8').includes('C:/fake/electron.exe'), '首次生成启动器')
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(binDir, 'yan.cmd'), old, old)
    const before = statSync(join(binDir, 'yan.cmd')).mtimeMs
    ensureYanLauncher({ devResourcesDir: 'resources', execPath: 'C:/fake/electron.exe', binDir })
    ok(statSync(join(binDir, 'yan.cmd')).mtimeMs === before, '内容没变时不重写启动器')
    ensureYanLauncher({ devResourcesDir: 'resources', execPath: 'C:/other/electron.exe', binDir })
    ok(readFileSync(join(binDir, 'yan.cmd'), 'utf8').includes('C:/other/electron.exe'), '内容变化时替换启动器')
    ok(!readdirSync(binDir).some((name) => name.endsWith('.tmp')), '替换后不留临时文件')

    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'not a dir')
    let threw = false
    try {
      ensureYanLauncher({ devResourcesDir: 'resources', execPath: 'x', binDir: join(blocked, 'bin') })
    } catch {
      threw = true
    }
    ok(threw, '启动器写不进去时抛错交给调用方回收能力服务')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const { CapabilityServer, CAPABILITY_API_VERSION, CAPABILITY_RESULT_MAX_BYTES } = await compile('src/main/capability-server.ts')
  const opsDir = mkdtempSync(join(tmpdir(), 'yan-ops-write-'))
  const payloads = { small: { a: 1, b: [1, 2] }, big: { big: 'x'.repeat(CAPABILITY_RESULT_MAX_BYTES + 10) } }
  const server = new CapabilityServer({
    opsDir,
    handlers: { async run(_command, params) { return { data: payloads[params.kind], summary: { kind: 'probe' } } } }
  })
  try {
    const { url, token } = await server.start({ sessionId: 's', projectId: 'p' })
    const call = async (kind) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ apiVersion: CAPABILITY_API_VERSION, sessionId: 's', projectId: 'p', command: 'capabilities.search', params: { kind } })
      })
      return res.json()
    }
    const small = await call('small')
    const smallText = readFileSync(small.resultFile, 'utf8')
    ok(smallText.includes('\n') && JSON.parse(smallText).b.length === 2, '小结果仍按缩进格式落盘')
    const big = await call('big')
    const bigBody = JSON.parse(readFileSync(big.resultFile, 'utf8'))
    ok(bigBody.truncated === true && bigBody.bytes > CAPABILITY_RESULT_MAX_BYTES, '超限结果按紧凑长度判断并截断')
  } finally {
    server.stop()
    rmSync(opsDir, { recursive: true, force: true })
  }

  const raceDir = mkdtempSync(join(tmpdir(), 'yan-ops-race-'))
  try {
    const racer = new CapabilityServer({ opsDir: raceDir })
    const starting = racer.start({ sessionId: 's', projectId: 'p' })
    let second = ''
    try {
      await racer.start({ sessionId: 's', projectId: 'p' })
    } catch (error) {
      second = error instanceof Error ? error.message : String(error)
    }
    ok(/只服务一个会话/.test(second), '启动进行中的重复 start 也被拒绝', second)
    racer.stop()
    let stopped = ''
    try {
      await starting
    } catch (error) {
      stopped = error instanceof Error ? error.message : String(error)
    }
    ok(/已停止/.test(stopped) && !racer.ready, '启动期间被停止时不再开端口', stopped)
  } finally {
    rmSync(raceDir, { recursive: true, force: true })
  }
})
