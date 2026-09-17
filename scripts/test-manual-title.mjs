/**
 * 手动会话名落盘的结果反馈（R04）。
 *
 * 为什么单测它：以前 `setManualTitle` 把异常吞掉、IPC 无条件返回 `ok: true`，
 * 界面乐观写入后看着成功，重启才发现名字没保存 —— 用户主动保存的动作
 * 不能走「静默降级」。这里直接构造**真实**的文件系统失败
 * （把目标文件路径变成目录 → 写入报 EISDIR），不 mock、不碰用户数据
 * （YAN_DATA_DIR 指向 test-unit 的临时目录）。
 */
export async function runManualTitleTests(ok, mod, dataDir) {
  const { setManualTitle, manualTitles } = mod
  const { mkdir, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')

  console.log('\n--- R04 手动标题：写盘结果必须如实返回 ---')

  /* ---- 1. 正常写入 ---- */
  {
    const res = await setManualTitle('sess-ok', '重构标题生成')
    ok(res.ok === true, '正常写入返回 ok', JSON.stringify(res))
    const all = await manualTitles()
    ok(all['sess-ok'] === '重构标题生成', '写入的名字能读回', JSON.stringify(all))
  }

  /* ---- 2. 空串 = 清除（恢复自动标题） ---- */
  {
    const res = await setManualTitle('sess-ok', '   ')
    ok(res.ok === true, '清除也返回 ok', JSON.stringify(res))
    const all = await manualTitles()
    ok(!('sess-ok' in all), '清除后读不到该键', JSON.stringify(all))
  }

  /* ---- 3. 写盘失败：不能再假装成功 ---- */
  {
    const file = join(dataDir, 'manual-titles.json')
    await rm(file, { recursive: true, force: true })
    await mkdir(file, { recursive: true }) // 目标路径变成目录 → 写入必失败
    const failed = await setManualTitle('sess-bad', '写不进去')
    ok(failed.ok === false, '写盘失败时返回 ok:false', JSON.stringify(failed))
    ok(typeof failed.error === 'string' && failed.error.length > 0, '失败时带上原因', String(failed.error))
    const after = await manualTitles()
    ok(!('sess-bad' in after), '失败的写入不会留下半个名字', JSON.stringify(after))
    await rm(file, { recursive: true, force: true })
  }

  /* ---- 4. 恢复正常后仍能写入（失败不是永久性的） ---- */
  {
    const res = await setManualTitle('sess-ok', '恢复写入')
    ok(res.ok === true, '目录恢复后写入重新成功', JSON.stringify(res))
    const all = await manualTitles()
    ok(all['sess-ok'] === '恢复写入', '恢复后的名字读得到', JSON.stringify(all))
  }
}
