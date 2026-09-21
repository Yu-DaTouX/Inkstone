/*
 * 回合页脚的阅读秩序与计时呈现（实施-11 H-1）。
 *
 * 这里不烧 token：直接往真实 renderer store 注入**多轮已结束的回合**，
 * 渲染、聚合（groupIntoTurns）和页脚全部走生产代码。
 *
 * 验收重点（用户报过的问题 + 设计输入 §4.1 / §4.2）：
 *   · 助手正文顶部不再有「砚 / N 步 / 标准」那一行；用户回合的「你」保留
 *   · 整轮用时只在回合**底部**出现一次，且在正文之后（不是顶部、不是每条消息各一份）
 *   · 用时口径是整轮墙钟（含工具往返），悬停能看到说明，不是最后一次生成的时间
 *   · 单工具回合不显示「N 步」（那只是个噪音计数）
 *   · 没有元数据的普通回答不出现空页脚
 *   · 底部没有点赞 / 点踩 / 评分入口
 *   · 完成时刻是 <time datetime>，悬停给出完整年月日时分秒 + 时区
 *
 * ⚠️ 整轮耗时**怎么算**（回合起点 vs 首 token）不在这里断言 —— 那属于主进程
 *    `shared/turn-timing.ts`，由 `scripts/test-turn-timing.mjs` 的纯逻辑测试钉住。
 *    探针只负责「算出来的值有没有按契约呈现」。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  log('=== 回合页脚：顶部无品牌 / 底部唯一整轮用时 / 无点赞点踩 ===')

  let conn = store.getState().conn
  for (let i = 0; i < 40 && conn !== 'ready'; i++) {
    await sleep(250)
    conn = store.getState().conn
  }
  await sleep(1200)

  const sync = (msgs) => store.getState().applyPush({ ch: 'sync', payload: msgs })
  const tool = (id, name, args) => ({ id, name, args, status: 'ok' })

  /*
   * ---- 0. 恢复重建的历史回合 ----
   * 界面历史就是会话文件（AGENTS.md），而整轮用时是从会话 JSONL 里的 elapsedMs
   * 读回来的。所以**注入之前**先看一次 fixture 会话的历史回合：它证明“重载 /
   * 切换会话后整轮时间仍在”，而不是只在刚跑完时才显示。
   */
  {
    /* 轮询等历史渲染完：会话加载是异步的，刚 ready 时可能还没画出来。 */
    let history = []
    for (let i = 0; i < 20; i++) {
      history = [...document.querySelectorAll('article.msg.assistant [data-testid="turn-footer"]')]
      if (history.length) break
      await sleep(400)
    }
    if (history.length) {
      const text = (history[0]?.textContent ?? '').replace(/\s+/g, ' ').trim()
      ok(/用时/.test(text), `从会话文件恢复的历史回合也含整轮用时：「${text}」`)
    } else {
      out.push('  （跳过：本次 fixture 会话没有带计时的历史回合；重载证据由 turnfooterlive 的切会话断言给出）')
    }
  }

  /*
   * 三个回合，覆盖分支：
   *   tf-u1/a*  —— 两次工具往返，最后一条给出整轮 42.5s（多工具 → 显示步数）
   *   tf-u2/b1  —— 一个工具，18s（单工具 → 不显示步数）
   *   tf-u3/c1  —— 纯文本，没有 elapsedMs（只有完成时刻）
   *   tf-u4/d1  —— 什么元数据都没有（不该出现页脚）
   */
  const T = Date.UTC(2026, 8, 21, 12, 42, 8) // 2026-09-21 12:42:08Z
  const msgs = [
    { id: 'tf-u1', role: 'user', text: '把标题改成独立进程', timestamp: T },
    {
      id: 'tf-a1',
      role: 'assistant',
      text: '我先看看实现',
      toolCalls: [tool('tf-t1', 'read', { path: 'src/main/app.ts' })],
      elapsedMs: 8000,
      timestamp: T + 8000
    },
    {
      id: 'tf-a2',
      role: 'assistant',
      text: '找到了，改成独立进程',
      toolCalls: [tool('tf-t2', 'edit', { path: 'src/main/app.ts' })],
      elapsedMs: 31000,
      timestamp: T + 31000
    },
    { id: 'tf-a3', role: 'assistant', text: '改好了，两处改动：\n1. 启动\n2. 退出', elapsedMs: 42000, timestamp: T + 42000 },

    { id: 'tf-u2', role: 'user', text: '跑一下测试', timestamp: T + 60000 },
    {
      id: 'tf-b1',
      role: 'assistant',
      text: '测试通过。',
      toolCalls: [tool('tf-t3', 'bash', { command: 'npm test' })],
      elapsedMs: 18000,
      timestamp: T + 78000
    },

    { id: 'tf-u3', role: 'user', text: '这是什么', timestamp: T + 90000 },
    { id: 'tf-c1', role: 'assistant', text: '这是砚。', timestamp: T + 91000 },

    { id: 'tf-u4', role: 'user', text: '不需要页脚的一条' },
    { id: 'tf-d1', role: 'assistant', text: '好的。' }
  ]

  let footer = null
  for (let i = 0; i < 12; i++) {
    sync(msgs)
    await sleep(400)
    footer = q('[data-turn-id="tf-a1"] [data-testid="turn-footer"]')
    if (footer) break
  }

  const turn = (id) => q(`[data-turn-id="${id}"]`)

  /* ---- 1. 顶部：助手没有品牌 / 档位 / 步数标签 ---- */
  ok(!!turn('tf-a1'), '助手回合渲染出来了')
  ok(!turn('tf-a1')?.querySelector('.msg-label'), '助手正文顶部没有「砚 / N 步 / 标准」那一行')
  {
    const head = (turn('tf-a1')?.querySelector('.msg-body')?.textContent ?? '').slice(0, 40)
    ok(!/^砚|标准档|标准/.test(head.trim()), `正文开头直接是内容：「${head.replace(/\s+/g, ' ').trim()}」`)
  }
  {
    /* 对照：用户回合的「你」仍然保留（不是把标签一律删掉） */
    const label = turn('tf-u1')?.querySelector('.msg-label')?.textContent ?? ''
    ok(label.trim().length > 0 && !label.includes('步'), `用户回合仍保留身份标签：「${label.trim()}」`)
  }

  /* ---- 2. 底部：整轮用时只出现一次，且在正文之后 ---- */
  ok(!!footer, '多工具回合出现回合页脚')
  if (!footer) return out.join('\n')

  const footers = turn('tf-a1')?.querySelectorAll('[data-testid="turn-footer"]') ?? []
  ok(footers.length === 1, '一个回合只有一份页脚（不是每条消息各一份）', `实际 ${footers.length}`)

  {
    const response = turn('tf-a1')?.querySelector('[data-testid="turn-response"]')
    const fTop = footer.getBoundingClientRect().top
    const rBottom = response?.getBoundingClientRect().bottom ?? -1
    log(`  几何：正文底 ${Math.round(rBottom)} → 页脚顶 ${Math.round(fTop)}`)
    ok(!!response && fTop >= rBottom - 2, '页脚在正文**下方**（不是顶部汇总行）')
  }
  {
    const body = turn('tf-a1')?.querySelector('.msg-body')
    ok(body?.lastElementChild === footer, '页脚是回合正文的最后一个元素（贴着消息下沿）')
  }

  /* ---- 3. 步数 / 用时 / 完成时刻 ---- */
  {
    const text = footer.textContent ?? ''
    log(`  页脚文本：「${text.replace(/\s+/g, ' ').trim()}」`)
    ok(/2\s*步/.test(text), '多工具回合显示步数（2 步）', text)
    ok(text.includes('用时') && text.includes('42s'), '显示整轮用时 42s（注入 42000ms）', text)
    ok(!text.includes('42000'), '用时是人类可读格式，不是原始毫秒')
  }
  {
    /* 口径可解释：悬停要能说明这是整轮墙钟时间（含工具往返），不是生成速度 */
    const spans = [...footer.querySelectorAll('.turn-footer-item')]
    const elapsedSpan = spans.find((s) => (s.textContent ?? '').includes('用时'))
    ok(!!elapsedSpan?.getAttribute('title'), `用时条有悬停说明：「${elapsedSpan?.getAttribute('title') ?? ''}」`)
    ok(
      /工具|往返/.test(elapsedSpan?.getAttribute('title') ?? ''),
      '说明里写明含工具往返（不是被误读成生成时间）',
      elapsedSpan?.getAttribute('title') ?? ''
    )
  }
  {
    const time = footer.querySelector('time')
    ok(!!time, '完成时刻渲染为 <time>')
    const iso = time?.getAttribute('datetime') ?? ''
    ok(/^\d{4}-\d{2}-\d{2}T/.test(iso), `<time datetime> 是 ISO 时间：「${iso}」`)
    const title = time?.getAttribute('title') ?? ''
    ok(/\d{4}/.test(title) && title.length > (time?.textContent ?? '').length, `悬停给出完整时间：「${title}」`)
    const clock = (time?.textContent ?? '').trim()
    ok(/\d{1,2}[:.]\d{2}/.test(clock), `默认只显示短时间：「${clock}」`)
  }

  /* ---- 4. 单工具回合不显示步数 ---- */
  {
    const t2 = q('[data-turn-id="tf-b1"] [data-testid="turn-footer"]')
    ok(!!t2, '单工具回合也有页脚（用时仍在）')
    const text = t2?.textContent ?? ''
    ok(text.includes('用时') && text.includes('18s'), '单工具回合显示 18s', text)
    ok(!/\d+\s*步/.test(text), '单工具回合不显示步数（计数没有信息量）', text)
  }

  /* ---- 5. 没有 elapsedMs 的回合只显示完成时刻 ---- */
  {
    const t3 = q('[data-turn-id="tf-c1"] [data-testid="turn-footer"]')
    ok(!!t3, '纯文本回合仍有页脚（完成时刻）')
    const text = t3?.textContent ?? ''
    ok(!text.includes('用时'), '没有整轮用时不显示「用时」（不假装）', text)
    ok(!!t3?.querySelector('time'), '完成时刻仍然显示')
  }

  /* ---- 6. 完全无元数据：不出现空页脚 ---- */
  ok(!q('[data-turn-id="tf-d1"] [data-testid="turn-footer"]'), '没有用时/时刻/多工具的回合不渲染空页脚')

  /* ---- 7. 没有点赞 / 点踩 / 评分 ---- */
  {
    const buttons = footer.querySelectorAll('button')
    ok(buttons.length === 0, '页脚里没有按钮（复制 / 更多另在正文操作区，不在统计行）', `实际 ${buttons.length}`)
    const bad = document.querySelectorAll(
      '[class*="thumb" i][class*="up" i], [class*="thumb" i][class*="down" i], [data-testid*="rating"], [aria-label*="点赞"], [aria-label*="点踩"]'
    )
    ok(bad.length === 0, '整个界面没有点赞 / 点踩 / 评分入口', `匹配 ${bad.length} 个`)
  }

  return out.join('\n')
})()
