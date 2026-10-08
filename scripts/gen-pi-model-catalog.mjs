/**
 * 从随包 pi 的内置模型目录生成「模型能力表」：resources/pi-extensions/generated/pi-model-catalog.json。
 *
 * 用途：用户接入自定义服务（中转站、聚合网关）时，端点的 /models 往往只给 ID，
 * 不说哪个模型能思考、输出上限多少。pi 自带的目录里有这些数据，按模型 ID 对照即可补上，
 * 砚不另维护一份模型表。
 *
 * 做法：在隔离的 PI_CODING_AGENT_DIR 里以 RPC 模式启动 pi，挂一个临时扩展，
 * 在 session_start 时读 `ctx.modelRegistry.getAll()` 写出来。不登录、不发模型请求。
 *
 * 同一个模型在多家服务里各有一条（anthropic / openrouter / bedrock …），这里按归一化 ID
 * 合并，取最接近原厂的那条作为代表（见 PROVIDER_RANK）。
 *
 * 用法：
 *   node scripts/gen-pi-model-catalog.mjs          # 重新生成
 *   node scripts/gen-pi-model-catalog.mjs --check  # 与当前 pi 运行时比对，不一致则失败
 * 升级 pi（npm run upgrade:pi）后要重新生成。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
/* 与查找时同一个归一化函数（生成自 src/shared/custom-provider.ts） */
import { catalogKey } from '../resources/pi-extensions/generated/model-capabilities.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'resources/pi-extensions/generated/pi-model-catalog.json')
const check = process.argv.includes('--check')

/** 越靠前越接近原厂；不在表里的排在后面，聚合网关最后 */
const PROVIDER_RANK = [
  'anthropic', 'openai', 'google', 'deepseek', 'moonshotai', 'zai', 'xai', 'mistral', 'minimax',
  'xiaomi', 'meta', 'qwen-token-plan', 'nvidia', 'groq', 'fireworks', 'together', 'baseten',
  'huggingface', 'openrouter', 'vercel-ai-gateway', 'opencode', 'opencode-go', 'github-copilot'
]
const rank = (provider) => {
  const i = PROVIDER_RANK.indexOf(provider)
  return i === -1 ? PROVIDER_RANK.length - 4 : i
}

function piRuntime() {
  const base = join(root, 'resources/pi-runtime')
  const manifest = join(base, 'current.json')
  const generation = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).generation : ''
  const dir = generation ? join(base, generation) : base
  const cli = join(dir, 'dist/bundle/cli.js')
  if (!existsSync(cli)) throw new Error(`找不到 pi：${cli}（先 npm run vendor:pi）`)
  return { cli, version: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version }
}

async function dumpRegistry(cli) {
  const work = mkdtempSync(join(tmpdir(), 'pi-catalog-'))
  const dump = join(work, 'models.json.out')
  const ext = join(work, 'dump.mjs')
  writeFileSync(ext, `import { writeFileSync } from 'node:fs'
export default function dump(pi) {
  pi.on('session_start', (_e, ctx) => { writeFileSync(${JSON.stringify(dump)}, JSON.stringify(ctx.modelRegistry.getAll())) })
}
`)
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(work, 'agent') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--extension', ext], { env, windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  child.stdin.write(JSON.stringify({ id: 'catalog', type: 'get_state' }) + '\n')
  const started = Date.now()
  while (!existsSync(dump) && Date.now() - started < 30_000) await new Promise((r) => setTimeout(r, 200))
  child.kill()
  try {
    if (!existsSync(dump)) throw new Error(`pi 没有导出模型目录：${stderr.slice(0, 800)}`)
    await new Promise((r) => setTimeout(r, 200))
    return JSON.parse(readFileSync(dump, 'utf8'))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function compact(models) {
  const groups = new Map()
  for (const m of models) {
    if (m.type && m.type !== 'chat') continue
    if (typeof m.id !== 'string' || !m.id) continue
    const key = catalogKey(m.id)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(m)
  }
  const out = {}
  for (const key of [...groups.keys()].sort()) {
    const ranked = groups.get(key).sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider))
    const best = ranked[0]
    const entry = { provider: best.provider, api: best.api, reasoning: best.reasoning === true }
    if (Array.isArray(best.input) && best.input.includes('image')) entry.input = ['text', 'image']
    if (typeof best.contextWindow === 'number') entry.contextWindow = best.contextWindow
    if (typeof best.maxTokens === 'number') entry.maxTokens = best.maxTokens
    if (best.reasoning && best.thinkingLevelMap && typeof best.thinkingLevelMap === 'object') entry.thinkingLevelMap = best.thinkingLevelMap
    /* 报价（美元 / 百万 token）：会话花费按它估算，订阅制服务也能看到「折合 API 价」 */
    /* 代表那条可能是套餐里标 0 的（如 qwen-token-plan）：报价取排名最靠前的、真有标价的那条 */
    const c = ranked.find((m) => m.cost && (m.cost.input > 0 || m.cost.output > 0))?.cost
    if (c && (c.input > 0 || c.output > 0)) {
      entry.cost = { input: c.input ?? 0, output: c.output ?? 0, cacheRead: c.cacheRead ?? 0, cacheWrite: c.cacheWrite ?? 0 }
    }
    out[key] = entry
  }
  return out
}

const { cli, version } = piRuntime()
const models = compact(await dumpRegistry(cli))
/* 每个模型一行：体积小，升级 pi 后的 diff 也看得清 */
const lines = Object.entries(models).map(([key, entry]) => `  ${JSON.stringify(key)}: ${JSON.stringify(entry)}`)
const text = `{\n "piVersion": ${JSON.stringify(version)},\n "models": {\n${lines.join(',\n')}\n }\n}\n`
if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : ''
  if (current !== text) {
    console.error(`✗ ${OUT} 与 pi ${version} 的模型目录不一致 —— 跑 node scripts/gen-pi-model-catalog.mjs 重新生成`)
    process.exit(1)
  }
  console.log(`✓ 模型能力表与 pi ${version} 一致（${Object.keys(models).length} 个模型）`)
} else {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text)
  console.log(`已写入 ${OUT}：pi ${version}，${Object.keys(models).length} 个模型`)
}
