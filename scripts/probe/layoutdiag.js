;(async () => {
  const out = []
  const q = (s) => document.querySelector(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  const CONTAINERS = [
    '.app',
    '.workspace',
    '.center',
    '.rail',
    '.rightpanel',
    '.composer-wrap',
    '.composer'
  ]

  const check = (label) => {
    out.push(`=== ${label} ===`)
    for (const sel of CONTAINERS) {
      const el = q(sel)
      if (!el) continue
      const cs = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      if (!cs.display.includes('grid')) {
        out.push(`  ${sel}  ${Math.round(rect.width)}x${Math.round(rect.height)}  display=${cs.display}（跳过）`)
        continue
      }
      const rows = cs.gridTemplateRows.trim().split(/\s+/).filter(Boolean)
      const cols = cs.gridTemplateColumns.trim().split(/\s+/).filter(Boolean)
      const kids = [...el.children].filter((c) => getComputedStyle(c).position !== 'absolute')
      out.push(`  ${sel}  ${Math.round(rect.width)}x${Math.round(rect.height)}  display=grid`)
      out.push(`    rows(${rows.length}): ${rows.join(' ')}`)
      out.push(`    cols(${cols.length}): ${cols.join(' ')}`)
      out.push(
        `    流内子元素(${kids.length}): ` +
          kids
            .map((k) => `${String(k.className).split(' ')[0]}[r${getComputedStyle(k).gridRow} c${getComputedStyle(k).gridColumn}]`)
            .join(' ')
      )
      if (cols.length === 1 && rows.length < kids.length) {
        out.push(`    ⚠️ 单列容器但行数(${rows.length}) < 流内子元素(${kids.length}) → 有隐式行（顺序一变就错位）`)
      }
      if (/minmax\(0(px)?,\s*1fr\)/.test(cs.gridTemplateRows) && kids.length > 0) {
        const idx = rows.findIndex((r) => /minmax\(0(px)?,\s*1fr\)|1fr/.test(r))
        const owner = kids[idx] ? String(kids[idx].className).split(' ')[0] : '(空行)'
        out.push(`    1fr 行 = 第 ${idx + 1} 行 → 当前归属: ${owner}`)
      }
    }
  }

  try {
    check('初始状态（连接异常时）')

    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    const fake = []
    for (let i = 0; i < 240; i++) {
      fake.push(
        i % 3 === 0
          ? { id: 'g' + i, role: 'user', text: '第 ' + i + ' 条' }
          : {
              id: 'g' + i,
              role: 'assistant',
              text: '回复 ' + i + '\n\n正文',
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 }
            }
      )
    }
    store.getState().applyPush({ ch: 'sync', payload: fake })
    for (let i = 0; i < 40; i++) {
      if (document.querySelectorAll('.stream-row').length > 0) break
      await sleep(250)
    }
    check('右栏展开 + 240 条长会话')

    out.push('')
    out.push(`  .stream-row=${document.querySelectorAll('.stream-row').length}（虚拟化是否真的在工作）`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
