import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-confirm-action-'))
  try {
    const mod = await compile(
      'src/renderer/src/features/settings/capabilities/confirm-action.ts',
      join(dir, 'confirm-action.mjs')
    )
    const { runConfirmAction, confirmActionError } = mod

    assert.deepEqual(await runConfirmAction(() => undefined), { ok: true }, '同步动作直接成功')
    assert.deepEqual(await runConfirmAction(async () => {}), { ok: true }, '异步动作成功后成功')

    let ran = 0
    const accepted = await runConfirmAction(async () => {
      ran += 1
    })
    assert.equal(accepted.ok, true)
    assert.equal(ran, 1, '动作只执行一次')

    assert.deepEqual(await runConfirmAction(async () => {
      throw new Error('安装失败')
    }), { ok: false, error: '安装失败' }, '抛错保留消息')

    assert.deepEqual(await runConfirmAction(() => {
      throw '纯字符串错误'
    }), { ok: false, error: '纯字符串错误' }, '非 Error 也能取到消息')

    assert.deepEqual(await runConfirmAction(() => {
      throw new Error('   ')
    }), { ok: false }, '空消息不当作错误文案')

    assert.deepEqual(await runConfirmAction(() => {
      throw { code: 'E_FAKE' }
    }), { ok: false }, '无消息对象只报失败')

    assert.equal(confirmActionError(new Error(' x ')), 'x', '消息去空白')
    assert.equal(confirmActionError(undefined), undefined)
    assert.equal(confirmActionError(null), undefined)
    assert.equal(confirmActionError(42), undefined)

    console.log('\nconfirm 动作：全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
