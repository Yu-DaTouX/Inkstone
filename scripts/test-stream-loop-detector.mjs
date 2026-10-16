import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const THINKING_REPEAT = 512
const TEXT_REPEAT = 256
const CHECK_INTERVAL = 32

function feedChunks(feed, content, sizes) {
  let pos = 0
  let i = 0
  let emitted = 0
  while (pos < content.length) {
    const chunk = content.slice(pos, pos + sizes[i % sizes.length])
    if (chunk.length === 0) break
    pos += chunk.length
    emitted += chunk.length
    const hit = feed(chunk)
    if (hit) return { hit, at: emitted }
    i++
  }
  return { hit: null, at: emitted }
}

function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function shuffled(list, random) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export async function runStreamLoopDetectorTests(ok) {
  const { build } = await import('esbuild')
  const dir = await mkdtemp(join(tmpdir(), 'yan-loop-detector-'))
  const outfile = join(dir, 'stream-loop-detector.mjs')
  try {
    await build({
      entryPoints: ['src/shared/stream-loop-detector.ts'],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent'
    })
    const { createStreamLoopDetector } = await import(pathToFileURL(outfile).href)

    const det = () => createStreamLoopDetector()
    const CYCLE = '好。\n\n'

    {
      const content = CYCLE.repeat(200)
      const ref = feedChunks((c) => det().onThinking(c), content, [100000])
      const runs = [[1], [3], [7], [32], [5, 3, 17], [31, 1], [100000]].map((sizes) => {
        const d = det()
        return feedChunks((c) => d.onThinking(c), content, sizes)
      })
      const at = runs[0].hit && runs[0].hit.emittedChars
      ok(ref.hit && ref.hit.rule === 'reasoning-cycle', '周期：thinking 合成循环命中 reasoning-cycle', JSON.stringify(ref.hit))
      ok(runs.every((r) => r.hit && r.hit.rule === 'reasoning-cycle' && r.hit.emittedChars === at), '周期：7 种分块命中规则与内部位置完全一致', runs.map((r) => (r.hit ? r.hit.emittedChars : 'null')).join(','))
      ok(at % CHECK_INTERVAL === 0 && at >= THINKING_REPEAT, '周期：命中落在 32 的整数倍且不小于最短重复', String(at))
      ok(at === 544, '周期：思考最快命中点为 544（512 门槛 + 4 字符模板对齐）', String(at))
    }

    {
      const prefix = '思考开始。'.repeat(20)
      const loop = CYCLE.repeat(150)
      const suffix = '接下来换一段完全不同的正常内容继续展开。'.repeat(60)
      const whole = prefix + loop + suffix
      const d = det()
      const r = feedChunks((c) => d.onThinking(c), whole, [whole.length])
      ok(r.hit && r.hit.rule === 'reasoning-cycle', '大 delta：中间循环也能命中', JSON.stringify(r.hit))
      const midAt = r.hit && r.hit.emittedChars
      ok(midAt > prefix.length && midAt < prefix.length + loop.length, '大 delta：命中发生在循环段内（不是靠最终尾巴）', `${midAt} ∈ (${prefix.length},${prefix.length + loop.length})`)
      const d2 = det()
      const r2 = feedChunks((c) => d2.onThinking(c), loop + suffix, [loop.length + suffix.length])
      ok(r2.hit && r2.hit.rule === 'reasoning-cycle' && r2.hit.emittedChars <= loop.length, '大 delta：循环在前、正常尾部在后仍命中', `${r2.hit && r2.hit.emittedChars}`)
    }

    {
      const content = CYCLE.repeat(200)
      const d = det()
      const r = feedChunks((c) => d.onThinking(c), content, [1])
      ok(r.hit && r.hit.rule === 'reasoning-cycle' && r.hit.emittedChars === 544, '跨 delta：逐字符喂入仍命中 544', JSON.stringify(r.hit))
      const d2 = det()
      const r2 = feedChunks((c) => d2.onThinking(c), content, [4, 1, 1, 2, 8, 3])
      ok(r2.hit && r2.hit.rule === 'reasoning-cycle' && r2.hit.emittedChars === 544, '跨 delta：不规则切分仍命中 544', JSON.stringify(r2.hit))
    }

    {
      const rotated = '。\n\n好'.repeat(200)
      const d = det()
      const r = feedChunks((c) => d.onThinking(c), rotated, [1, 2, 3, 5, 7])
      ok(r.hit && r.hit.rule === 'reasoning-cycle' && r.hit.emittedChars === 544, '旋转相位：半行切片不再误排除', JSON.stringify(r.hit))
      const rotated2 = '\n\n好。'.repeat(200)
      const d2 = det()
      const r2 = feedChunks((c) => d2.onThinking(c), rotated2, [13])
      ok(r2.hit && r2.hit.rule === 'reasoning-cycle', '旋转相位：另一种相位也命中', JSON.stringify(r2.hit))
    }

    {
      const content = 'abc123XYZ'.repeat(100)
      const d = det()
      ok(d.onThinking('这是一段普通的思考内容，没有循环。') === null, '正文：普通思考不命中')
      const r = feedChunks((c) => d.onText(c), content, [11])
      ok(r.hit && r.hit.rule === 'text-cycle', '正文：text-cycle 命中', JSON.stringify(r.hit))
      ok(r.hit && r.hit.emittedChars === 288, '正文：text 最快命中点为 288（256 门槛 + 9 字符模板对齐）', r.hit && String(r.hit.emittedChars))

      const d2 = det()
      const r2 = feedChunks((c) => d2.onThinking(c), content, [11])
      ok(r2.hit === null || r2.hit.emittedChars >= THINKING_REPEAT, '正文：同一内容按思考门槛不会过早命中')
    }

    {
      const lines = ['我们先看源码。', '接下来写测试。', '继续检查边界。', '请确认这个点。', '然后再做验证。', '最后整理结果。', '还需要补一个例。', '这里先停一下。']
      const random = makeRandom(20261015)
      const ordered = []
      for (let round = 0; round < 40; round++) ordered.push(...lines)
      const content = shuffled(ordered, random).join('\n') + '\n'
      const d = det()
      const r = feedChunks((c) => d.onThinking(c), content, [9, 1, 14])
      ok(r.hit && r.hit.rule === 'reasoning-lines', '短语池：洗牌小词汇池命中 reasoning-lines', JSON.stringify(r.hit))
      ok(r.hit && r.hit.repeatedChars >= 2048, '短语池：重复质量达到 2048 门槛', r.hit && String(r.hit.repeatedChars))
    }

    {
      const cases = [
        ['代码块', 'function tick() {\n  return value + 1;\n}\n'],
        ['Markdown 表格', '| name | value |\n| --- | --- |\n'],
        ['JSON', '{"name":"alpha","count":3}\n'],
        ['日志', 'INFO 2026-10-15 service started ok\n'],
        ['分隔线', '--------------------------------\n']
      ]
      for (const [name, unit] of cases) {
        const d = det()
        const r = feedChunks((c) => d.onThinking(c), unit.repeat(300), [37])
        ok(r.hit === null, `排除：重复${name}不命中`, r.hit && JSON.stringify(r.hit))
      }
    }

    {
      for (const marker of ['```', '~~~~']) {
        for (const sizes of [[1], [31, 7], [100000]]) {
          const d = det()
          const content = `${marker}text\n${CYCLE.repeat(700)}${marker}\n`
          const r = feedChunks((c) => d.onThinking(c), content, sizes)
          ok(r.hit === null, `围栏：${marker} 纯文本重复，分块 ${sizes} 不命中`, JSON.stringify(r.hit))
        }
      }
      const d = det()
      const fenced = `\`\`\`text\n${CYCLE.repeat(700)}\`\`\`\n`
      ok(d.onThinking(fenced) === null, '围栏：代码内容不参与短语池和周期')
      const outside = feedChunks((c) => d.onThinking(c), CYCLE.repeat(200), [13])
      ok(outside.hit?.rule === 'reasoning-cycle', '围栏：关闭后正文恢复检测')
      const unclosed = det()
      ok(unclosed.onText(`\`\`\`text\n${CYCLE.repeat(1000)}`) === null, '围栏：未关闭正文围栏保守排除')
      const longOpener = det()
      ok(longOpener.onText(`\`\`\`${'language'.repeat(50)}\n${CYCLE.repeat(1000)}\`\`\`\n`) === null, '围栏：超长起始行仍保留状态')
    }

    {
      const d = det()
      let text = ''
      for (let i = 0; text.length < 120000; i++) text += `第 ${i} 段内容用于确认长流不会误报，行与行互不相同。\n`
      const r = feedChunks((c) => d.onThinking(c), text, [4096])
      ok(r.hit === null, '正常：12 万字符互异长流不命中', r.hit && JSON.stringify(r.hit))
    }

    {
      const d = det()
      const r1 = feedChunks((c) => d.onThinking(c), CYCLE.repeat(200), [64])
      ok(r1.hit && r1.hit.rule === 'reasoning-cycle', '一次性：首次循环命中')
      ok(d.onThinking('好。\n\n') === null && d.onText('abc123XYZ') === null, '一次性：命中后同消息不再重复上报')
      d.reset()
      ok(d.onThinking('这段内容正常且没有循环。') === null, 'reset：复位后普通内容不命中')
      const r2 = feedChunks((c) => d.onText(c), 'abc123XYZ'.repeat(100), [64])
      ok(r2.hit && r2.hit.rule === 'text-cycle', 'reset：复位后正文流可再次命中')
      ok(d.onThinking('') === null && d.onText('') === null, '边界：空 delta 不命中')
    }

    {
      const samplePath = process.env.LOOP_SAMPLE
      let raw = null
      try {
        if (samplePath) raw = await readFile(samplePath, 'utf8')
      } catch {
        console.log('# 本地样本不可读，跳过重放（设置 LOOP_SAMPLE 可指定路径）')
      }
      if (raw !== null) {
        const lf = raw.replace(/\r\n/g, '\n')
        const d = det()
        const r = feedChunks((c) => d.onThinking(c), lf, [7])
        ok(r.hit && r.hit.rule === 'reasoning-cycle', '样本：换行归一后命中 reasoning-cycle', JSON.stringify(r.hit))
        const sampleAt = r.hit && r.hit.emittedChars
        if (r.hit) console.log(`  本地样本命中：rule=${r.hit.rule} emittedChars=${sampleAt} repeatedChars=${r.hit.repeatedChars}（样本 ${lf.length} 字符）`)
        ok(sampleAt >= 2000 && sampleAt <= 2500, '样本：约 2k 字符命中；当前规则不要求等于方案模拟 2112', String(sampleAt))

        const d2 = det()
        const r2 = feedChunks((c) => d2.onThinking(c), lf, [1 << 30])
        ok(!!r2.hit && r2.hit.emittedChars === sampleAt, '样本：整份一次喂入命中位置不变', `${r2.hit && r2.hit.emittedChars} vs ${sampleAt}`)

        const d3 = det()
        const r3 = feedChunks((c) => d3.onThinking(c), raw, [7])
        ok(r3.hit && r3.hit.rule === 'reasoning-cycle', '样本：原始 CRLF 同样命中', JSON.stringify(r3.hit))
        if (r3.hit) console.log(`  原始 CRLF 命中：emittedChars=${r3.hit.emittedChars} repeatedChars=${r3.hit.repeatedChars}`)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export default runStreamLoopDetectorTests

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  const ok = (cond, name, extra) => {
    if (cond) {
      passed++
    } else {
      failed++
      console.error(`✗ ${name}${extra !== undefined ? ` — ${extra}` : ''}`)
    }
  }
  await runStreamLoopDetectorTests(ok)
  console.log(failed ? `✗ 流式重复检测：${failed} 失败，${passed} 通过` : `✓ 流式重复检测：${passed} 项通过`)
  process.exit(failed ? 1 : 0)
}
