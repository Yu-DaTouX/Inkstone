#!/usr/bin/env node
import { existsSync, statSync, readdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (f) => args.includes(f)

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`
}

const say = (...a) => console.log(...a)
const step = (s) => say(`\n${C.b('▸')} ${s}`)

say('')
say(`  ${C.b('砚')} ${C.dim('·')} 个人 agent 桌面端`)
say(`  ${C.dim('─'.repeat(38))}`)

step('检查环境')

if (!existsSync(join(root, 'package.json'))) {
  say(C.err('  找不到 package.json —— 这个脚本要在项目根目录下运行'))
  process.exit(1)
}

if (!existsSync(join(root, 'node_modules', 'electron'))) {
  say(C.warn('  缺 node_modules，开始安装依赖（首次需要几分钟）…'))
  const r = spawnSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    say(C.err('  npm install 失败，请手动跑一次看看报错'))
    process.exit(1)
  }
}
say(`  ${C.ok('✓')} node_modules`)

const { selectedPiRuntime } = await import('./lib/pi-runtime-location.mjs')
const piRuntime = join(selectedPiRuntime(join(root, 'resources', 'pi-runtime')), 'dist', 'bundle', 'cli.js')
if (!existsSync(piRuntime)) {
  say(C.warn('  缺内置 pi 运行时，开始抽取（需要本机装过一个 pi）…'))
  const r = spawnSync('node', [join(root, 'scripts', 'vendor-pi.mjs')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (r.status !== 0) {
    say(C.err('  抽取失败。先装一个 pi：npm i -g @earendil-works/pi-coding-agent'))
    say(C.dim('  （只是抽取时需要它，装好之后最终用户不需要）'))
    process.exit(1)
  }
}
say(`  ${C.ok('✓')} 内置 pi 运行时`)

const launchEnv = { ...process.env }
delete launchEnv.ELECTRON_RUN_AS_NODE

if (has('--dev') || has('-d')) {
  step('开发模式（HMR）')
  say(C.dim('  改 src/renderer/** 即时生效；改 src/main/** 需要重启（或加 --watch）'))
  const child = spawn('npm', ['run', 'dev'], { cwd: root, stdio: 'inherit', shell: true, env: launchEnv })
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  const outMain = join(root, 'out', 'main', 'index.js')

  const newestSource = () => {
    let newest = 0
    const walk = (dir, depth = 0) => {
      if (depth > 6) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'out' || e.name.startsWith('.')) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p, depth + 1)
        else {
          if (!/\.(ts|tsx|css|json|html)$/.test(e.name)) continue
          const m = statSync(p).mtimeMs
          if (m > newest) newest = m
        }
      }
    }
    walk(join(root, 'src'))
    for (const f of ['package.json', 'electron.vite.config.ts']) {
      const p = join(root, f)
      if (existsSync(p)) newest = Math.max(newest, statSync(p).mtimeMs)
    }
    return newest
  }

  const needBuild =
    has('--rebuild') || !existsSync(outMain) || newestSource() > statSync(outMain).mtimeMs

  if (needBuild) {
    step(has('--rebuild') ? '重新构建（--rebuild）' : '构建（产物不存在或比源码旧）')
    const r = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })
    if (r.status !== 0) {
      say(C.err('  构建失败，应用不会启动'))
      process.exit(1)
    }
  } else {
    step('构建产物是最新的')
    say(C.dim('  跳过构建（要强制重建：node scripts/launch.mjs --rebuild）'))
  }

  if (has('--dry')) {
    say(`\n${C.ok('检查通过')} ${C.dim('（--dry：不启动）')}`)
    process.exit(0)
  }

  step('启动')
  const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  const bin = existsSync(electron) ? electron : 'npx'

  const child = spawn(bin, existsSync(electron) ? ['.'] : ['electron', '.'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    shell: !existsSync(electron),
    env: launchEnv
  })
  child.unref()

  say(`  ${C.ok('✓')} 已启动 ${C.dim('（这个窗口稍后会自动关闭）')}`)
  setTimeout(() => process.exit(0), 400)
}
