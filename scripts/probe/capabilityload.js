/*
 * 连接就绪后，模型 / 思考档位列表必须能补上。
 * 这是用户报的「看不到模型选择」的端到端验收。
 *
 * 为什么这条断言能证明修复有效：
 *   启动时 `initLoad()` 里那次 `reloadModels()` 是**不等 pi 就绪**就发的
 *   （pi 要加载扩展，几秒才起来），所以那次必然拿到空数组并被 catch 吞掉。
 *   修复前**没有任何代码会重拉** —— 这个探针会一直等到超时、看到 0 条。
 *   修复后 `startConnWatch` 在 conn 转 ready 时会补拉一次。
 *
 * 依赖：隔离环境需要有 pi 凭证（test-live 会把真实 auth.json 只读复制到
 * sandbox）。没有凭证时 pi 只会起一个 unknown 模型，本场景会明确失败而不是静默跳过。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const log = (s) => out.push(String(s))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  log('=== 能力列表：连接就绪后必须补上 ===')

  /* ---- 1. 等 pi 真的起来 ---- */
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (store.getState().conn === 'ready') {
      ready = true
      break
    }
    await sleep(500)
  }
  const st0 = store.getState()
  log(`  conn=${st0.conn} detail=${JSON.stringify(st0.connDetail)}`)
  ok(ready, 'pi 已就绪（conn=ready）')
  if (!ready) {
    log('  ⚠️ pi 没起来 —— 这个场景需要真实凭证，否则无法验证')
    return out.join('\n')
  }

  /* ---- 2. 模型列表非空：本次修复的核心断言 ---- */
  let n = store.getState().models.length
  for (let i = 0; i < 40 && n === 0; i++) {
    await sleep(500)
    n = store.getState().models.length
  }
  ok(n > 0, `模型列表非空（${n} 条）—— 修复前这里会一直是 0`)

  /* ---- 3. 思考档位同理（同一个重拉点） ---- */
  let levels = store.getState().thinkingLevels
  for (let i = 0; i < 20 && levels.length === 0; i++) {
    await sleep(500)
    levels = store.getState().thinkingLevels
  }
  log(`  思考档位 = ${JSON.stringify(levels)}`)
  ok(levels.length > 0, '思考档位也补上了（不再是「上游未提供思考档位信息」）')

  /* ---- 4. 菜单里真的有可选项，而不是空态 ---- */
  const trigger = q('[data-testid="model-picker"]')
  ok(!!trigger, '模型选择器在 DOM 里')
  if (trigger) {
    ok(trigger.dataset.state === 'ready', '选择器处于 ready（不是 unknown）')
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(600)
    const items = document.querySelectorAll('.mt-item')
    const empty = q('.mt-empty')
    log(`  菜单可选模型 = ${items.length} 个，空态 = ${empty ? JSON.stringify(empty.textContent) : '无'}`)
    ok(items.length > 0, '菜单里有可选模型')
    ok(!empty, '不再显示「没有匹配的模型」空态')
    ok((q('.mt-count')?.textContent ?? '0') !== '0', '搜索框右侧的模型计数不再是 0')
  }

  /* ---- 5. 斜杠命令也依赖同一个重拉点（只记录，本地命令本来就非空） ---- */
  log(`  命令列表 = ${store.getState().commands.length} 条`)

  return out.join('\n')
})()
