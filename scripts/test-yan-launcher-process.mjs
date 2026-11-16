import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { runSuite } from './lib/test-suite.mjs'

const win = process.platform === 'win32'
const nonAscii = /[^\x00-\x7f]/

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((done) => setTimeout(done, 40))
  }
  return check()
}

const inner = (launcher, args) => [launcher, ...args].map((part) => `"${part}"`).join(' ')

const cmdLine = (launcher, args) => `"${inner(launcher, args)}"`

const viaCmd = (launcher, args) =>
  spawnSync('cmd.exe', ['/d', '/s', '/c', cmdLine(launcher, args)], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000 })

await runSuite(import.meta.url, async (ok, compile) => {
  const cli = await compile('src/main/yan-cli.ts')

  const asciiText = cli.cmdLauncherText('C:/fake/electron.exe', 'C:/fake/yan.mjs')
  ok(!asciiText.includes('chcp') && asciiText.includes('"C:/fake/electron.exe" "C:/fake/yan.mjs" %* & call exit /b %%ERRORLEVEL%%'), '纯 ASCII 路径的 cmd 启动器不碰代码页，调用 exe 的那一行以 exit /b 结尾')
  const wideText = cli.cmdLauncherText('C:/Program Files/砚/砚.exe')
  const lines = wideText.split('\r\n')
  ok(wideText.endsWith('\r\n') && !wideText.includes('\n\n') && lines.findIndex((line) => line.startsWith('chcp 65001')) < lines.findIndex((line) => line.includes('砚.exe')), '含中文的路径只出现在 chcp 65001 之后的行里')
  ok(cli.cmdLauncherText('C:/100%/electron.exe').includes('"C:/100%%/electron.exe"'), '路径里的百分号按批处理转义')

  const failDir = join(tmpdir(), `yan-launcher-fail-${process.pid}`)
  rmSync(failDir, { recursive: true, force: true })
  try {
    const failBin = join(failDir, 'bin')
    mkdirSync(join(failBin, 'yan-node.cmd'), { recursive: true })
    const reported = []
    const result = cli.ensureYanLauncher({ devResourcesDir: resolve('resources'), execPath: 'C:/fake/electron.exe', binDir: failBin, onNodeLauncherError: (error) => reported.push(error) })
    ok(!!result && readFileSync(result.launcher, 'utf8').includes('C:/fake/electron.exe') && existsSync(join(failBin, 'yan')), 'yan-node 启动器写不进去时 yan 启动器照常生成并返回，能力服务不受牵连')
    ok(reported.length === 1, 'yan-node 写失败只通知日志回调一次', String(reported.length))
    ok(!readdirSync(failBin).some((name) => name.endsWith('.tmp')), '写失败不留临时文件')
    let direct = false
    try {
      cli.ensureNodeLauncher({ execPath: 'C:/fake/electron.exe', binDir: failBin })
    } catch {
      direct = true
    }
    ok(direct, '直接生成 yan-node 入口失败时仍抛错，供 Minecraft 插件安装与刷新报告')

    if (win) {
      const lockBin = join(failDir, 'lock')
      cli.ensureNodeLauncher({ execPath: 'C:/old/electron.exe', binDir: lockBin })
      const target = join(lockBin, 'yan-node.cmd')
      const holder = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${target}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 150; $f.Close()`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      const held = await new Promise((done) => {
        const timer = setTimeout(() => done(false), 20_000)
        holder.stdout.on('data', (data) => {
          if (String(data).includes('locked')) {
            clearTimeout(timer)
            done(true)
          }
        })
        holder.on('error', () => done(false))
      })
      if (held) {
        cli.ensureNodeLauncher({ execPath: 'C:/new/electron.exe', binDir: lockBin })
        ok(readFileSync(target, 'utf8').includes('C:/new/electron.exe'), '目标文件被短暂占用（杀毒、另一实例）时改名重试后成功')
      } else {
        ok(true, '本机没有 pwsh，跳过占用重试用例')
      }
      holder.kill()
    }
  } finally {
    rmSync(failDir, { recursive: true, force: true })
  }

  if (!win) return

  const root = join(tmpdir(), `砚 中文用户-${process.pid}`)
  rmSync(root, { recursive: true, force: true })
  const pending = []
  try {
    const installDir = join(root, '安装 目录')
    const binDir = join(root, 'yan', 'bin')
    mkdirSync(installDir, { recursive: true })
    const wideExe = join(installDir, '砚.exe')
    copyFileSync(process.execPath, wideExe)
    const probe = join(root, 'probe.mjs')
    writeFileSync(probe, 'const args = process.argv.slice(2)\nprocess.stdout.write(JSON.stringify(args))\nprocess.exit(args[0] === "fail" ? 7 : 0)\n')

    const made = cli.ensureYanLauncher({ devResourcesDir: resolve('resources'), execPath: wideExe, binDir })
    ok(!!made && nonAscii.test(made.launcher + wideExe), '中文用户目录与中文 exe 名下生成启动器')
    const nodeCmd = cli.nodeLauncherPath(binDir)

    const plain = viaCmd(nodeCmd, [probe, 'x'])
    ok(plain.status === 0 && plain.stdout === '["x"]', 'yan-node.cmd 在中文路径下用 cmd.exe 能真正启动 exe', `${plain.status} ${plain.stdout} ${plain.stderr}`)
    const special = viaCmd(nodeCmd, [probe, 'a b', '50%', 'x&y', 'hi!'])
    ok(special.status === 0 && special.stdout === JSON.stringify(['a b', '50%', 'x&y', 'hi!']), '含空格、百分号、&、! 的参数原样传到', `${special.stdout} ${special.stderr}`)
    const failing = viaCmd(nodeCmd, [probe, 'fail'])
    ok(failing.status === 7 && failing.stdout === '["fail"]', 'exe 的退出码原样传给调用方', `${failing.status}`)

    const help = viaCmd(made.launcher, ['--help'])
    ok(help.status === 0 && help.stdout.length > 100, 'yan.cmd 在中文路径下也能启动并跑起 yan CLI', `${help.status} ${help.stderr}`)

    const probeCp = join(root, 'cp.cmd')
    writeFileSync(probeCp, '@echo off\r\nchcp\r\n')
    const cpNumber = (text) => text.split(/\r?\n/).filter(Boolean).map((line) => /(\d+)\s*$/.exec(line)?.[1])
    const cp = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${probeCp}" & ${inner(nodeCmd, [probe, 'x'])} & "${probeCp}""`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
    const seen = cpNumber(cp.stdout.replace('["x"]', '\n'))
    ok(seen.length === 2 && seen[0] === seen[1], '启动器结束后控制台代码页恢复原值，不留给用户终端', JSON.stringify(seen))

    const scratch = join(root, 'asciicheck')
    mkdirSync(scratch, { recursive: true })
    const slow = join(root, 'slow.mjs')
    writeFileSync(slow, 'import { writeFileSync } from "node:fs"\nwriteFileSync(process.argv[2], String(process.pid))\nsetTimeout(() => { process.stdout.write("done\\n"); process.exit(3) }, 1500)\n')
    const runSlow = async (launcher, rewrite) => {
      const mark = join(scratch, `slow-${Math.random().toString(16).slice(2)}.pid`)
      const child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine(launcher, [slow, mark])], { windowsHide: true, windowsVerbatimArguments: true })
      let out = ''
      let err = ''
      child.stdout.on('data', (data) => (out += data))
      child.stderr.on('data', (data) => (err += data))
      const closed = new Promise((done) => child.on('close', done))
      pending.push(child)
      await waitFor(() => existsSync(mark), 15_000)
      rewrite()
      const code = await closed
      return { code, out, err }
    }
    const longer = join(root, 'x& echo LEAKED &', `${'z'.repeat(60)}.exe`)
    const during = await runSlow(nodeCmd, () => cli.ensureNodeLauncher({ execPath: longer, binDir }))
    ok(during.code === 3 && during.out === 'done\n' && during.err === '', '另一个实例在 exe 运行期间改写 yan-node.cmd，当前这次调用结束后不会执行到新文件的残段', `${during.code} ${JSON.stringify(during.out)} ${JSON.stringify(during.err)}`)
    ok(readFileSync(nodeCmd, 'utf8').includes('zzzz') && !readdirSync(binDir).some((name) => name.endsWith('.tmp')), '改写走临时文件加改名，不留临时文件')

    if (!nonAscii.test(tmpdir())) {
      const asciiRoot = join(tmpdir(), `yan-launcher-ascii-${process.pid}`)
      try {
        const asciiBin = join(asciiRoot, 'bin')
        mkdirSync(join(asciiRoot, 'app'), { recursive: true })
        const asciiExe = join(asciiRoot, 'app', 'node.exe')
        copyFileSync(process.execPath, asciiExe)
        cli.ensureNodeLauncher({ execPath: asciiExe, binDir: asciiBin })
        const asciiCmd = cli.nodeLauncherPath(asciiBin)
        const asciiRun = viaCmd(asciiCmd, [probe, 'fail'])
        ok(!readFileSync(asciiCmd, 'utf8').includes('chcp') && asciiRun.status === 7 && asciiRun.stdout === '["fail"]', 'ASCII 路径的启动器直接运行，退出码原样传出')
        const asciiDuring = await runSlow(asciiCmd, () => cli.ensureNodeLauncher({ execPath: longer.replace(root, asciiRoot).replace(/[^\x00-\x7f]/g, 'x'), binDir: asciiBin }))
        ok(asciiDuring.code === 3 && asciiDuring.out === 'done\n' && asciiDuring.err === '', 'ASCII 启动器运行期间被改写同样不会执行到残段', `${asciiDuring.code} ${JSON.stringify(asciiDuring.err)}`)
      } finally {
        rmSync(asciiRoot, { recursive: true, force: true })
      }
    }

    cli.ensureNodeLauncher({ execPath: wideExe, binDir })
    const server = join(root, 'server.mjs')
    const serverSource = (exitOnEof) => [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(join(root, 'server.pid'))}, String(process.pid))`,
      'process.stdin.on("data", () => {})',
      exitOnEof ? 'process.stdin.on("end", () => process.exit(0))' : '',
      'setInterval(() => {}, 1000)'
    ].join('\n')
    const startServer = async (exitOnEof) => {
      const pidFile = join(root, 'server.pid')
      rmSync(pidFile, { force: true })
      writeFileSync(server, serverSource(exitOnEof))
      const transport = new StdioClientTransport({ command: nodeCmd, args: ['--no-warnings', server], env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '' }, stderr: 'ignore' })
      await transport.start()
      await waitFor(() => existsSync(pidFile), 15_000)
      return { transport, pid: Number(readFileSync(pidFile, 'utf8')) }
    }
    const polite = await startServer(true)
    pending.push({ kill: () => { try { process.kill(polite.pid) } catch {} } })
    ok(alive(polite.pid) && polite.pid !== polite.transport.pid, '经 yan-node.cmd 启动的服务进程在 cmd.exe 之下运行')
    await polite.transport.close()
    ok(await waitFor(() => !alive(polite.pid), 4000), '客户端关闭 stdin 后按 stdin 结束退出的服务（Minecraft MCP 的写法）不会成为孤儿')
  } finally {
    for (const child of pending) {
      try {
        child.kill()
      } catch {
      }
    }
    await new Promise((done) => setTimeout(done, 200))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
