import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const load = async (code) => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

let passed = 0
let failed = 0
function ok(condition, label, detail) {
  if (condition) {
    passed++
  } else {
    failed++
    console.error(`FAIL ${label}${detail === undefined ? '' : ` ${detail}`}`)
  }
}

const limitsSource = await readFile(here('../src/shared/context-limits.ts'), 'utf8')
const { code: limitsCode } = await transform(limitsSource, { loader: 'ts', format: 'esm' })
const limits = await load(limitsCode)
const ext = await import('../resources/pi-extensions/context-trim.js')

const {
  DEFAULT_AUTO_COMPACT_TOKENS,
  DEFAULT_CONTEXT_TRIM_TOKENS,
  AUTO_COMPACT_STEPS,
  CONTEXT_TRIM_STEPS,
  pickTokenStep,
  autoCompactAt,
  contextTrimAt
} = limits
const { DEFAULT_COMPACT_TOKENS, DEFAULT_TRIM_TOKENS, readContextSettings, compactAt, trimAt } = ext

ok(DEFAULT_AUTO_COMPACT_TOKENS === 400_000, 'shared 自动压缩缺省为 400k', String(DEFAULT_AUTO_COMPACT_TOKENS))
ok(DEFAULT_COMPACT_TOKENS === 400_000, '随包扩展自动压缩缺省为 400k', String(DEFAULT_COMPACT_TOKENS))
ok(DEFAULT_AUTO_COMPACT_TOKENS === DEFAULT_COMPACT_TOKENS, '两端自动压缩缺省一致')
ok(DEFAULT_CONTEXT_TRIM_TOKENS === 80_000 && DEFAULT_TRIM_TOKENS === 80_000, '裁剪缺省仍为 80k 且两端一致')
ok(
  JSON.stringify([...AUTO_COMPACT_STEPS]) === JSON.stringify([100_000, 250_000, 300_000, 400_000, 600_000, 800_000]),
  '自动压缩档位未变'
)
ok(JSON.stringify([...CONTEXT_TRIM_STEPS]) === JSON.stringify([50_000, 80_000, 120_000]), '裁剪档位未变')
ok(
  pickTokenStep(DEFAULT_AUTO_COMPACT_TOKENS, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS) === undefined,
  '等于缺省值的档位不写入设置（UI 依赖 shared 缺省自动跟随）'
)

const piDir = mkdtempSync(join(tmpdir(), 'yan-v3-ctx-default-'))
const previousPiDir = process.env.PI_CODING_AGENT_DIR
const previousYanDir = process.env.YAN_DATA_DIR
process.env.PI_CODING_AGENT_DIR = piDir
process.env.YAN_DATA_DIR = piDir

try {
  writeFileSync(join(piDir, 'settings.json'), JSON.stringify({}))
  writeFileSync(join(piDir, 'desktop.json'), '{}')
  {
    const s = readContextSettings()
    ok(s.compactTokens === 400_000, '未设置 autoCompactTokens 时用 400k', String(s.compactTokens))
    ok(s.trimTokens === 80_000, '未设置 contextTrimTokens 时用 80k', String(s.trimTokens))
    ok(s.compact === true && s.trim === true, '未设置时裁剪与提前压缩默认开启')
  }

  {
    process.env.YAN_DATA_DIR = join(piDir, 'missing')
    const s = readContextSettings()
    ok(s.compactTokens === 400_000, '读不到 desktop.json 时仍用 400k', String(s.compactTokens))
    process.env.YAN_DATA_DIR = piDir
  }

  writeFileSync(join(piDir, 'desktop.json'), JSON.stringify({ autoCompactTokens: 250_000 }))
  {
    const s = readContextSettings()
    ok(s.compactTokens === 250_000, '用户已存 250k 保持不迁移', String(s.compactTokens))
  }
  ok(
    pickTokenStep(250_000, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS) === 250_000,
    '显式 250k 不再被当成缺省抹掉'
  )

  writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }))
  {
    const s = readContextSettings()
    ok(s.compact === false, 'pi 关闭自动压缩时 compact=false 保持')
    ok(s.compactTokens === 250_000, '关闭状态下用户 250k 仍原样读出')
  }
  writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ compaction: { enabled: true } }))

  writeFileSync(join(piDir, 'desktop.json'), JSON.stringify({ contextTrim: false }))
  {
    const s = readContextSettings()
    ok(s.trim === false, '用户关闭裁剪保持')
    ok(s.compactTokens === 400_000, '关闭裁剪不影响自动压缩缺省')
  }
} finally {
  if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousPiDir
  if (previousYanDir === undefined) delete process.env.YAN_DATA_DIR
  else process.env.YAN_DATA_DIR = previousYanDir
}

ok(autoCompactAt(400_000, 1_050_000) === 400_000, '大窗口不提前，按缺省 400k')
ok(autoCompactAt(400_000, 300_000) === 270_000, '小窗口压缩线按 90% 提前')
ok(autoCompactAt(400_000, 272_000) === 244_800, 'Codex 272K 窗口压到约 245K')
ok(autoCompactAt(400_000, 0) === 400_000, '窗口未知时用设置值')
ok(contextTrimAt(120_000, 300_000) === 90_000, '裁剪线不超过窗口 30%')
ok(compactAt(400_000, 300_000) === 270_000, '随包扩展压缩线与 shared 一致')
ok(trimAt(120_000, 300_000) === 90_000, '随包扩展裁剪线与 shared 一致')
for (const [win, a, b] of [[272_000, 80_000, 400_000], [128_000, 50_000, 600_000], [1_050_000, 120_000, 400_000], [0, 80_000, 400_000]]) {
  ok(
    trimAt(a, win) === contextTrimAt(a, win) && compactAt(b, win) === autoCompactAt(b, win),
    `阈值：扩展与 shared 公式一致（窗口 ${win}）`
  )
}

console.log(JSON.stringify({ passed, failed }))
if (failed) process.exitCode = 1
