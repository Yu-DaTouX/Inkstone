/**
 * 共享自动压缩缺省（400k）与随包扩展对齐的专项检查（C2 首次引导）。
 *
 * 不构建、不启动 Electron、不读用户真实设置、不调模型：
 *   1. 两端缺省一致：src/shared/context-limits.ts 与 resources/pi-extensions/context-trim.js
 *      的自动压缩缺省都是 400k，裁剪缺省仍是 80k；
 *   2. 未设置（空 desktop.json）时走 400k，UI 依赖的 shared 缺省自动跟随；
 *   3. 用户显式存下的 250k 与 pi 原生「自动压缩关闭」保持，不被新缺省迁移或覆盖；
 *   4. 小窗口的 90% 压缩线 / 30% 裁剪线比例护栏不变。
 *
 * 复用现有纯 helper（readContextSettings / pickTokenStep / autoCompactAt / compactAt），
 * 只在临时目录写合成文件，不触发 Agent、compact 或模型。
 * 可直接运行：node scripts/test-v3-context-default.mjs
 */
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

/* ── 1. 两端缺省值 ─────────────────────────────────────────── */
ok(DEFAULT_AUTO_COMPACT_TOKENS === 400_000, 'shared 自动压缩缺省为 400k', String(DEFAULT_AUTO_COMPACT_TOKENS))
ok(DEFAULT_COMPACT_TOKENS === 400_000, '随包扩展自动压缩缺省为 400k', String(DEFAULT_COMPACT_TOKENS))
ok(DEFAULT_AUTO_COMPACT_TOKENS === DEFAULT_COMPACT_TOKENS, '两端自动压缩缺省一致')
ok(DEFAULT_CONTEXT_TRIM_TOKENS === 80_000 && DEFAULT_TRIM_TOKENS === 80_000, '裁剪缺省仍为 80k 且两端一致')
ok(
  JSON.stringify([...AUTO_COMPACT_STEPS]) === JSON.stringify([100_000, 250_000, 300_000, 400_000, 600_000, 800_000]),
  '自动压缩档位未变'
)
ok(JSON.stringify([...CONTEXT_TRIM_STEPS]) === JSON.stringify([50_000, 80_000, 120_000]), '裁剪档位未变')
/* UI 与 400k 缺省相等即视为“未设置”，不写进设置文件 */
ok(
  pickTokenStep(DEFAULT_AUTO_COMPACT_TOKENS, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS) === undefined,
  '等于缺省值的档位不写入设置（UI 依赖 shared 缺省自动跟随）'
)

/* ── 2/3. readContextSettings：临时目录合成 desktop.json / pi settings.json ── */
const piDir = mkdtempSync(join(tmpdir(), 'yan-v3-ctx-default-'))
const previousPiDir = process.env.PI_CODING_AGENT_DIR
const previousYanDir = process.env.YAN_DATA_DIR
process.env.PI_CODING_AGENT_DIR = piDir
process.env.YAN_DATA_DIR = piDir

try {
  /* 未设置：空 desktop.json + pi settings.json 里没有 compaction → 全部走缺省 */
  writeFileSync(join(piDir, 'settings.json'), JSON.stringify({}))
  writeFileSync(join(piDir, 'desktop.json'), '{}')
  {
    const s = readContextSettings()
    ok(s.compactTokens === 400_000, '未设置 autoCompactTokens 时用 400k', String(s.compactTokens))
    ok(s.trimTokens === 80_000, '未设置 contextTrimTokens 时用 80k', String(s.trimTokens))
    ok(s.compact === true && s.trim === true, '未设置时裁剪与提前压缩默认开启')
  }

  /* 缺省文件不存在（读不到 desktop.json）时也走 400k */
  {
    process.env.YAN_DATA_DIR = join(piDir, 'missing')
    const s = readContextSettings()
    ok(s.compactTokens === 400_000, '读不到 desktop.json 时仍用 400k', String(s.compactTokens))
    process.env.YAN_DATA_DIR = piDir
  }

  /* 显式 250k：必须保持，不被新缺省迁移或覆盖 */
  writeFileSync(join(piDir, 'desktop.json'), JSON.stringify({ autoCompactTokens: 250_000 }))
  {
    const s = readContextSettings()
    ok(s.compactTokens === 250_000, '用户已存 250k 保持不迁移', String(s.compactTokens))
  }
  ok(
    pickTokenStep(250_000, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS) === 250_000,
    '显式 250k 不再被当成缺省抹掉'
  )

  /* pi 原生「自动压缩关闭」：compact 标志保持 false，不因缺省变更重开 */
  writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }))
  {
    const s = readContextSettings()
    ok(s.compact === false, 'pi 关闭自动压缩时 compact=false 保持')
    ok(s.compactTokens === 250_000, '关闭状态下用户 250k 仍原样读出')
  }
  writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ compaction: { enabled: true } }))

  /* 关闭裁剪：同样保持 */
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

/* ── 4. 小窗口比例护栏不变（两端公式一致） ─────────────────── */
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
