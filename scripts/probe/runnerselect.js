;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  try {
    for (let i = 0; i < 80; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(250)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(600)

    const cwd = store.getState().settings.cwd
    const sessions = store.getState().sessions
    out.push(`  会话数 = ${sessions.length}  conn = ${store.getState().conn}`)

    const settingsBeforeCwd = await window.yan.getSettings()
    const invalidCwd = `${String(cwd).replace(/[\\/]+$/, '')}/__yan_missing_${Date.now()}`
    const badSet = await window.yan.setCwd(invalidCwd)
    ok(!badSet.ok && /不存在|不可访问/.test(badSet.error ?? ''), 'setCwd 拒绝不存在的工作目录')
    const settingsAfterCwd = await window.yan.getSettings()
    ok(settingsAfterCwd.cwd === settingsBeforeCwd.cwd, '非法 setCwd 不改变当前工作目录')
    const badNew = await window.yan.newSession({ cwd: invalidCwd })
    ok(!badNew.ok && /不存在|不可访问/.test(badNew.error ?? ''), 'newSession 拒绝不存在的工作目录')
    const badSelect = await window.yan.selectSession({ cwd: invalidCwd })
    ok(!badSelect.ok && /不存在|不可访问/.test(badSelect.error ?? ''), 'selectSession 拒绝不存在的工作目录')

    const first = await window.yan.selectSession({ cwd })
    if (!first.ok) {
      out.push(`  ⤺ 跳过：pi 未就绪（conn=${store.getState().conn}），无法验证主进程注册表路径`)
      out.push('    原因: ' + JSON.stringify(first.error))
      return out.join('\n')
    }
    ok(
      !!first.id && first.runId === first.id && typeof first.sessionId === 'string' && first.generation >= 1 &&
        (first.via === 'new' || first.via === 'reuse'),
      `首次选择得到带封套身份的实例 ${first.id}（via=${first.via}）`
    )

    let list = await window.yan.runnerStatuses()
    ok(list.length >= 1, `状态快照有 ${list.length} 个实例`)
    ok(list.some((r) => r.id === first.id && r.isActive), '返回的实例就是快照里的 active 那个')
    ok(list.every((r) => r.runId === r.id && typeof r.generation === 'number'), '状态快照带 runId 和 generation')
    ok(list.every((r) => typeof r.running === 'boolean'), '每个实例都带 running 布尔值')

    const target = sessions[0]
    if (target) {
      const hit1 = await window.yan.selectSession({ sessionFile: target.path, cwd: target.cwd || cwd })
      if (!hit1.ok) {
        out.push('  ⤺ 跳过：切真实会话失败，无法验证命中/复用')
        out.push('    原因: ' + JSON.stringify(hit1.error))
        return out.join('\n')
      }
      const list2 = await window.yan.runnerStatuses()
      ok(list2.length === list.length, `切到已有会话后实例数不变（${list.length} → ${list2.length}）`)

      const hit2 = await window.yan.selectSession({ sessionFile: target.path, cwd: target.cwd || cwd })
      ok(hit2.ok && hit2.via === 'hit', '再次选同一会话是「命中」（只改视图）', `via=${hit2.via}`)
      ok(hit2.id === hit1.id, '命中的是同一个实例')

      const list3 = await window.yan.runnerStatuses()
      ok(list3.length === list2.length, '命中路径没有新建实例')
      ok(list3.every((r) => r.conn !== undefined), '快照里带连接状态（左栏失败标记要用）')
    } else {
      out.push('  （没有会话文件可切，跳过命中验证）')
    }

    const before = await window.yan.runnerStatuses()
    const victim = before.find((r) => !r.isActive) ?? before[0]
    if (victim) {
      const stopped = await window.yan.stopRunner(victim.id)
      ok(stopped === true, `stopRunner(${victim.id}) 返回 true`)
      const after = await window.yan.runnerStatuses()
      ok(after.length === before.length - 1, `只少了一个实例（${before.length} → ${after.length}）`)
      ok(!after.some((r) => r.id === victim.id), '被停的实例从注册表里消失')
    }

    const canonical = (s) => String(s ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
    const parentCwd = String(cwd).replace(/[\\/][^\\/]+[\\/]?$/, '')
    if (parentCwd && canonical(parentCwd) !== canonical(cwd)) {
      const back = await window.yan.selectSession({ cwd })
      ok(back.ok === true, '回到当前项目，准备验证跨项目复用', back.error ?? '')
      const moved = await window.yan.selectSession({ cwd: parentCwd })
      if (!moved.ok) {
        out.push(`  ⤺ 跳过：无法切到父目录验证跨项目 cwd（${JSON.stringify(moved.error)}）`)
      } else {
        let reported = null
        for (let i = 0; i < 40; i++) {
          const list = await window.yan.runnerStatuses()
          const row = list.find((r) => r.id === moved.id)
          if (row?.cwd && canonical(row.cwd) === canonical(parentCwd)) {
            reported = row.cwd
            break
          }
          await sleep(200)
        }
        ok(
          reported !== null,
          `D5：跨项目复用后 pi 进程的 cwd 跟上新项目（via=${moved.via}）`,
          `cwd=${reported ?? '(未更新)'}`
        )

        await window.yan.selectSession({ cwd })
      }
    } else {
      out.push('  ⤺ 跳过：当前 cwd 没有可用的父目录，无法验证跨项目换进程')
    }
  } catch (error) {
    out.push('  ✗ 探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
