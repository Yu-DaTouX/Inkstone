export async function runManualTitleTests(ok, mod, dataDir) {
  const { setManualTitle, manualTitles } = mod
  const { mkdir, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')

  console.log('\n--- R04 手动标题：写盘结果必须如实返回 ---')

  {
    const res = await setManualTitle('sess-ok', '重构标题生成')
    ok(res.ok === true, '正常写入返回 ok', JSON.stringify(res))
    const all = await manualTitles()
    ok(all['sess-ok'] === '重构标题生成', '写入的名字能读回', JSON.stringify(all))
  }

  {
    const res = await setManualTitle('sess-ok', '   ')
    ok(res.ok === true, '清除也返回 ok', JSON.stringify(res))
    const all = await manualTitles()
    ok(!('sess-ok' in all), '清除后读不到该键', JSON.stringify(all))
  }

  {
    const file = join(dataDir, 'manual-titles.json')
    await rm(file, { recursive: true, force: true })
    await mkdir(file, { recursive: true })
    const failed = await setManualTitle('sess-bad', '写不进去')
    ok(failed.ok === false, '写盘失败时返回 ok:false', JSON.stringify(failed))
    ok(typeof failed.error === 'string' && failed.error.length > 0, '失败时带上原因', String(failed.error))
    let rejectedRead = false
    try { await manualTitles() } catch { rejectedRead = true }
    ok(rejectedRead, '读取故障明确报错，不把读失败伪装为空标题表')
    await rm(file, { recursive: true, force: true })
    const after = await manualTitles()
    ok(!('sess-bad' in after), '恢复读取后没有失败写入的名字', JSON.stringify(after))
  }

  {
    const res = await setManualTitle('sess-ok', '恢复写入')
    ok(res.ok === true, '目录恢复后写入重新成功', JSON.stringify(res))
    const all = await manualTitles()
    ok(all['sess-ok'] === '恢复写入', '恢复后的名字读得到', JSON.stringify(all))
  }
  {
    const ids = Array.from({ length: 12 }, (_, index) => `sess-race-${index}`)
    const results = await Promise.all(ids.map((id, index) => setManualTitle(id, `race title ${index}`)))
    ok(results.every((result) => result.ok), '并发保存手动标题全部返回成功', JSON.stringify(results))
    const all = await manualTitles()
    ok(ids.every((id, index) => all[id] === `race title ${index}`), '并发保存的手动标题全部留在文件里', JSON.stringify(all))
    await Promise.all(ids.map((id) => setManualTitle(id, '')))
    const cleared = await manualTitles()
    ok(ids.every((id) => !(id in cleared)), '并发清除也全部生效', JSON.stringify(cleared))
  }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { build } = await import('esbuild')
  const root = await mkdtemp(join(tmpdir(), 'inkstone-manual-title-'))
  process.env.YAN_DATA_DIR = join(root, 'yan')
  try {
    const outfile = join(root, 'title.mjs')
    await build({ entryPoints: ['src/main/title.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
    const mod = await import(pathToFileURL(outfile).href)
    let passed = 0
    let failed = 0
    await runManualTitleTests((condition, label, detail) => {
      if (condition) passed++
      else {
        failed++
        console.error(`FAIL: ${label}`, detail ?? '')
      }
    }, mod, process.env.YAN_DATA_DIR)
    console.log(`manual title: ${passed} passed, ${failed} failed`)
    if (failed) process.exitCode = 1
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
