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
}
