import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-oauth-boundary-'))
const piDir = join(root, 'pi')
const oauthDir = join(root, 'runtime', 'chunks')
await mkdir(piDir, { recursive: true })
await mkdir(oauthDir, { recursive: true })

const LOGIN_MODULE = `
export const xaiOAuth = {
  async login(interaction) {
    interaction.notify({ type: 'auth_url', url: 'https://login.example/device', instructions: 'follow the link' })
    interaction.notify({ type: 'progress', message: 'waiting' })
    const code = await interaction.prompt({ type: 'manual_code', message: 'code?', placeholder: '123456' })
    return { access: 'fixture-access', refresh: 'fixture-refresh', code, expires: 1 }
  }
}
`
await writeFile(join(oauthDir, 'xai.js'), LOGIN_MODULE, 'utf8')

const originalEnv = { ...process.env }
let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail === undefined ? '' : `: ${detail}`}`)
  checks++
}

const built = await build({
  entryPoints: ['src/main/oauth-providers.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'silent',
  plugins: [
    {
      name: 'oauth-stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'oauth-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'oauth-stub' }, () => ({
          contents: `export const shell = { openExternal: async (url) => { globalThis.__oauthOpenedUrl = url } }`,
          loader: 'js'
        }))
      }
    }
  ]
})

try {
  process.env.YAN_PI_DIR = piDir
  process.env.YAN_DATA_DIR = join(root, 'yan')
  const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const { startOAuthLogin, answerOAuthPrompt, cancelOAuthLogin } = mod
  const piEntry = join(root, 'runtime', 'cli.js')

  {
    const events = []
    const result = await startOAuthLogin({ provider: 'nobody', piEntry, send: (event) => events.push(event) })
    ok(!result.ok && events.length === 0, '不支持的服务直接拒绝，不产生登录事件')
  }

  {
    const events = []
    const result = await startOAuthLogin({ provider: 'anthropic', piEntry, send: (event) => events.push(event) })
    ok(!result.ok && /找不到|no sign-in module/.test(result.error ?? ''), '缺少登录模块时给出可操作的失败说明', result.error)
  }

  {
    const events = []
    let promptEvent
    const promptArrived = new Promise((resolve) => { promptEvent = resolve })
    const run = startOAuthLogin({
      provider: 'xai',
      piEntry,
      send: (event) => {
        events.push(event)
        if (event.type === 'prompt') promptEvent(event)
      }
    })
    await promptArrived
    const duplicate = await startOAuthLogin({ provider: 'xai', piEntry, send: () => undefined })
    ok(!duplicate.ok, '同一时间只允许一个登录进行')
    ok(globalThis.__oauthOpenedUrl === 'https://login.example/device', 'auth_url 交给系统浏览器，并使用校验后的地址')
    ok(events.some((event) => event.type === 'auth_url') && events.some((event) => event.type === 'progress'), '登录进度事件转给界面')
    const promptId = events.find((event) => event.type === 'prompt').promptId
    ok(answerOAuthPrompt('xai', promptId + 1, 'wrong') === false, '错误的 prompt id 不会被接受')
    ok(answerOAuthPrompt('other', promptId, 'wrong') === false, '其他服务的 prompt id 不会被接受')
    ok(answerOAuthPrompt('xai', promptId, '123456') === true, '正确的 prompt id 收到答复')
    const result = await run
    ok(result.ok, '登录完成后返回成功', result.error)
    ok(events.at(-1).type === 'done', '登录完成发送 done')
    const auth = JSON.parse(await readFile(join(piDir, 'auth.json'), 'utf8'))
    ok(auth.xai?.type === 'oauth' && auth.xai?.access === 'fixture-access' && auth.xai?.code === '123456', '登录凭证写入受管目录')
  }

  {
    const events = []
    let promptEvent
    const promptArrived = new Promise((resolve) => { promptEvent = resolve })
    const run = startOAuthLogin({
      provider: 'xai',
      piEntry,
      send: (event) => {
        events.push(event)
        if (event.type === 'prompt') promptEvent(event)
      }
    })
    await promptArrived
    cancelOAuthLogin('xai')
    const result = await run
    ok(!result.ok && result.cancelled === true, '取消登录返回 cancelled', result.error)
    ok(events.some((event) => event.type === 'prompt_closed'), '取消时通知界面关闭提问卡')
    const auth = JSON.parse(await readFile(join(piDir, 'auth.json'), 'utf8'))
    ok(auth.xai?.access === 'fixture-access', '取消不会覆盖已有凭证')
    ok(answerOAuthPrompt('xai', 999, 'late') === false, '取消后的迟到答复被拒绝')
  }

  console.log(`oauth-provider-boundary: ${checks} assertions passed (fake pi module, temp auth dir)`)
} finally {
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
  Object.assign(process.env, originalEnv)
  delete globalThis.__oauthOpenedUrl
  await rm(root, { recursive: true, force: true })
}
