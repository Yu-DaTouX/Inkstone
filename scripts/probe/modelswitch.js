/**
 * 真实模型切换矩阵（N02）。
 *
 * 与 `thinkinglevels` / `capabilityload` 的分工：那两个验“能力列表能不能拿到”，
 * 这个验**切过去之后状态归谁** —— 真实 pi、真实模型列表，但不发消息（不花钱）：
 *   · 切到另一个模型后，思考档位跟着它走，不是上一个模型的残留；
 *   · 快速连切（后发的先回）不能让旧响应覆盖新模型；
 *   · 上下文用量按模型归属：旧模型的 token 快照不能冒充新模型的容量。
 *
 * 判据都写成“性质”而不是固定值：模型列表是用户自己的，具体哪几个模型
 * 支持思考由供应商决定，环境一变固定值就会假失败。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }
  const key = (m) => (m ? `${m.provider}/${m.id}` : '')

  try {
    for (let i = 0; i < 60; i++) {
      if (store.getState().conn === 'ready' && store.getState().models.length > 1) break
      await sleep(500)
    }
    const models = store.getState().models
    out.push(`  可用模型 ${models.length} 个`)
    ok(models.length > 1, '真实模型列表里有多个模型（能测切换）')
    if (models.length < 2) return out.join('\n')

    const first = store.getState().session?.model
    const others = models.filter((m) => key(m) !== key(first))
    /* 优先挑“支持推理”的，这样档位对比更有意义 */
    const pickA = others.find((m) => m.reasoning) ?? others[0]
    const pickB = others.find((m) => key(m) !== key(pickA)) ?? others[0]

    /* ---- 1. 切到 A：状态跟着 A 走 ---- */
    out.push('')
    out.push('=== 1. 切到另一个模型 ===')
    out.push(`  切到 ${key(pickA)}`)
    await store.getState().setModel(pickA.provider, pickA.id)
    const switched = await until(() => key(store.getState().session?.model) === key(pickA), 15000)
    ok(switched, '当前模型已切换')
    await sleep(1500)
    const levelsA = store.getState().thinkingLevels
    const statusA = store.getState().session?.thinkingLevelsStatus
    out.push(`  A 的档位 = ${JSON.stringify(levelsA)}（status=${statusA}）`)
    ok(Array.isArray(levelsA), '切换后档位数组仍存在（没有变成未定义）')

    /* ---- 2. 快速连切：旧响应不能覆盖新模型 ---- */
    out.push('')
    out.push('=== 2. 快速连切（迟到响应不得覆盖）===')
    out.push(`  先发 ${key(pickB)} 再发 ${key(pickA)}，不等待`)
    /* 故意不 await 第一次：第二次请求先落地 */
    const p1 = store.getState().setModel(pickB.provider, pickB.id)
    await sleep(60)
    const p2 = store.getState().setModel(pickA.provider, pickA.id)
    await Promise.allSettled([p1, p2])
    await sleep(2500)
    const now = store.getState().session?.model
    out.push(`  最终模型 = ${key(now)}`)
    ok(key(now) === key(pickA), '最终停在**后发**的那个模型上（迟到的旧响应被丢弃）')
    const levelsNow = store.getState().thinkingLevels
    out.push(`  最终档位 = ${JSON.stringify(levelsNow)}`)
    ok(
      JSON.stringify(levelsNow) === JSON.stringify(levelsA),
      '档位与最终模型一致（没有混进上一个模型的档位）'
    )

    /* ---- 3. 切到“没有档位”的模型：档位必须被清空，不是残留 ---- */
    out.push('')
    out.push('=== 3. 切到无思考档位的模型 ===')
    const plain = models.find((m) => !m.reasoning && key(m) !== key(pickA))
    if (!plain) {
      out.push('  ⤺ 这批模型里没有“不支持推理”的，跳过')
    } else {
      out.push(`  切到 ${key(plain)}`)
      await store.getState().setModel(plain.provider, plain.id)
      await until(() => key(store.getState().session?.model) === key(plain), 15000)
      await sleep(2000)
      const lv = store.getState().thinkingLevels
      const st = store.getState().session?.thinkingLevelsStatus
      out.push(`  档位 = ${JSON.stringify(lv)}（status=${st}）`)
      ok(lv.length <= 1 || st === 'unsupported', '不支持推理的模型不再挂着上一个模型的档位')
    }

    /* ---- 4. 上下文用量按模型归属 ---- */
    out.push('')
    out.push('=== 4. 旧模型的 token 统计不冒充新模型 ===')
    const stats = store.getState().stats
    const cu = stats?.contextUsage
    const curKey = store.getState().session?.model
      ? `${store.getState().session.model.provider}/${store.getState().session.model.id}`
      : undefined
    out.push(`  contextUsage.modelKey = ${JSON.stringify(cu?.modelKey ?? null)}，当前模型 = ${curKey}`)
    if (!cu) {
      out.push('  ⤺ 当前会话还没有用量快照（没有真实回复），跳过')
    } else if (!cu.modelKey) {
      out.push('  ⤺ pi 这次没给 modelKey（旧版本行为）→ 界限由 RightPanel 按 contextWindow 兜底')
    } else {
      ok(cu.modelKey === curKey, '用量快照标记的模型与当前模型一致（旧的不会冒充）')
    }
    const win = store.getState().session?.model?.contextWindow
    out.push(`  右栏用的窗口 = ${win ?? '（未知）'}`)
    ok(
      win === undefined || win > 0,
      '上下文窗口要么未知、要么是正数（不会显示成旧模型的容量冒充）'
    )

    /* ---- 5. 图像输入模型：能力标签跟着模型走 ---- */
    out.push('')
    out.push('=== 5. 切换图像输入模型 ===')
    const vis = models.find((m) => Array.isArray(m.input) && m.input.includes('image') && key(m) !== key(pickA))
    if (!vis) {
      out.push('  ⤺ 这批模型里没有标了图像输入的，跳过')
    } else {
      out.push(`  切到 ${key(vis)}（input=${JSON.stringify(vis.input)}）`)
      await store.getState().setModel(vis.provider, vis.id)
      await until(() => key(store.getState().session?.model) === key(vis), 15000)
      await sleep(1500)
      const cur = store.getState().session?.model
      out.push(`  当前模型 = ${key(cur)} input=${JSON.stringify(cur?.input ?? null)}`)
      ok(!!cur?.input?.includes('image'), '当前模型的图像输入能力与模型列表一致')
      ok(cur?.contextWindow === vis.contextWindow, '上下文容量也跟着模型走（不是上一个模型的）')
    }

    /* 收尾：切回原来的模型，别把用户的默认设置留在这个场景挑的模型上 */
    if (first) {
      await store.getState().setModel(first.provider, first.id)
      await sleep(800)
    }
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
