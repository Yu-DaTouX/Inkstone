/**
 * 单独验证「pi 能不能被找到并启动」—— 不启动 Electron 窗口。
 *
 * 用法： npm run probe-pi
 *
 * 应用里连不上 pi 时，先跑这个：它把 resolvePi 的每个候选路径、
 * 实际用的命令、spawn 结果、get_state 的原始返回都打出来。
 */
import { resolvePi } from '../out/main/protocol.js'

const probe = resolvePi({ override: process.env.YAN_PI_BIN })

console.log('=== 1. 定位 pi ===')
console.log('命令      :', probe.cmd)
console.log('参数      :', JSON.stringify(probe.args))
if (probe.error) console.log('警告      :', probe.error)
console.log('候选路径  :')
for (const t of probe.tried) console.log('  -', t)

console.log('\n=== 2. spawn --mode rpc 并问一句 get_state ===')

const { spawn } = await import('node:child_process')
const args = [...probe.args, '--mode', 'rpc', '--no-session']

const child = spawn(probe.cmd, args, {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true
})

let out = ''
let err = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (d) => {
  out += d
})
child.stderr.on('data', (d) => {
  err += d
})

child.stdin.write(JSON.stringify({ id: 'diag', type: 'get_state' }) + '\n')

const code = await new Promise((resolve) => {
  const hardKill = setTimeout(() => {
    child.kill()
    resolve('timeout')
  }, 25_000)

  child.on('exit', (c) => {
    clearTimeout(hardKill)
    resolve(c)
  })

  // 收到响应就收工
  const iv = setInterval(() => {
    if (out.includes('"id":"diag"')) {
      clearInterval(iv)
      clearTimeout(hardKill)
      child.stdin.end()
      setTimeout(() => child.kill(), 800)
    }
  }, 200)
})

const lines = out.split('\n').filter(Boolean)
let state = null
for (const l of lines) {
  try {
    const o = JSON.parse(l)
    if (o.id === 'diag') state = o
  } catch {
    /* 非 JSON 行（扩展 print） */
  }
}

console.log('退出码    :', code)

if (state) {
  console.log('响应      : success =', state.success)
  const d = state.data ?? {}
  console.log('  模型    :', d.model?.name ?? '—', `(${d.model?.provider}/${d.model?.id})`)
  console.log('  上下文窗:', d.model?.contextWindow ?? '—')
  console.log('  思考档  :', d.thinkingLevel)

  // 上下文窗口是这次踩过的坑（HANDOFF §5.5）：128000 就是没回填成功
  if (d.model?.contextWindow === 128000) {
    console.log('\n⚠️  上下文窗口是 128000 —— 说明 models.json 没回填。')
    console.log('   跑：node ~/.pi/agent/.dev/sync-model-context.mjs --write')
  }
} else {
  console.log('❌ 没拿到 get_state 响应')
}

if (err.trim()) {
  console.log('\n--- stderr ---')
  console.log(err.trim().split('\n').slice(-15).join('\n'))
}

process.exit(state?.success ? 0 : 1)
