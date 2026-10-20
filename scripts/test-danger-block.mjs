#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

let pass = 0
let fail = 0
function ok(cond, label, detail) {
  if (cond) {
    pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    fail += 1
    process.stdout.write(`  ✗ ${label}  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}\n`)
  }
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-danger-block-'))
  try {
    const entry = join(dir, 'entry.ts')
    const shared = posix(join(ROOT, 'src/shared'))
    await writeFile(entry, `export * from '${shared}/danger-block.ts'`)
    const outfile = join(dir, 'bundle.mjs')
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const m = await import(pathToFileURL(outfile).href)

    process.stdout.write('\n▌前缀与三种原因：拒绝 / 无答复算已拒绝，宿主故障不算\n')
    const denied = `${m.DANGER_BLOCK_PREFIX}递归删除大范围目录：/。${m.DANGER_BLOCK_DENIED_MARK}。请换一种更安全的做法`
    const feedback = `${m.DANGER_BLOCK_PREFIX}递归删除大范围目录：/。${m.DANGER_BLOCK_DENIED_MARK}，并给出理由：改用回收站。请按这个理由调整做法后再试。`
    const noAnswer = `${m.DANGER_BLOCK_PREFIX}关机或重启。${m.DANGER_BLOCK_NO_ANSWER_MARK}。请换一种更安全的做法`
    const host = `${m.DANGER_BLOCK_PREFIX}关机或重启。${m.DANGER_BLOCK_HOST_FAILURE_MARK}（fetch failed）。请换一种更安全的做法`
    ok(m.dangerBlockKind(denied) === 'denied', '用户拒绝 → denied', m.dangerBlockKind(denied))
    ok(m.dangerBlockKind(feedback) === 'denied', '拒绝并反馈 → denied', m.dangerBlockKind(feedback))
    ok(m.dangerBlockKind(noAnswer) === 'no-answer', '没有答复 → no-answer', m.dangerBlockKind(noAnswer))
    ok(m.dangerBlockKind(host) === 'host-failure', '宿主故障单独归类，不当作拒绝', m.dangerBlockKind(host))
    ok(m.dangerBlockKind('普通工具失败') === null, '没有护栏前缀的失败不归类', m.dangerBlockKind('普通工具失败'))
    ok(m.dangerBlockKind(undefined) === null && m.dangerBlockKind('') === null, '空输出不归类', [m.dangerBlockKind(undefined), m.dangerBlockKind('')])
    ok(m.isDangerDenial(denied) && m.isDangerDenial(feedback) && m.isDangerDenial(noAnswer), '拒绝与无答复算已拒绝', [m.isDangerDenial(denied), m.isDangerDenial(noAnswer)])
    ok(!m.isDangerDenial(host), '宿主故障不算已拒绝', m.isDangerDenial(host))

    process.stdout.write('\n▌护栏文案与共享常量锁定：改前缀或原因措辞时两边一起改\n')
    const guard = await readFile(resolve(ROOT, 'resources/pi-extensions/danger-guard.js'), 'utf8')
    ok(guard.includes(m.DANGER_BLOCK_PREFIX), 'danger-guard 的拒绝前缀与共享常量一致')
    ok(guard.includes(m.DANGER_BLOCK_DENIED_MARK), 'danger-guard 的拒绝原因与共享常量一致')
    ok(guard.includes(m.DANGER_BLOCK_NO_ANSWER_MARK), 'danger-guard 的无答复原因与共享常量一致')
    ok(guard.includes(m.DANGER_BLOCK_HOST_FAILURE_MARK), 'danger-guard 的宿主故障原因与共享常量一致')

    process.stdout.write(`\n结果：${pass} 通过，${fail} 失败\n`)
    if (fail > 0) process.exitCode = 1
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

run().catch((err) => {
  process.stderr.write(`\n[未捕获] ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
