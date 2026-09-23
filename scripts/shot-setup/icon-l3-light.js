/**
 * L3 / H-8a·b 视觉验收前置（浅色）：把 artifact 卡片与图片进度条摆到会话里。
 *
 * 这两个表面正是之前引用**未定义主题变量**（--text / --panel / --line / --muted）
 * 的地方 —— 它们在浅色下一度回退成固定浅字深底。矩阵里只有深色的
 * `artifact` / `imageprogress` 状态，浅色要用真实主进程截图补。
 *
 * 探针脚本约定：自求值 async IIFE，不能用反引号 / ${}。
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  if (!store) return 'no-store'

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 30; i++) {
    const card = q('.ob-card')
    if (!card) break
    const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成/.test(b.textContent))
    if (btn) btn.click()
    await sleep(250)
  }

  store.getState().setRailPinned(true)
  store.getState().closeSettings?.()
  for (let i = 0; i < 60; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  await sleep(500)

  /* 仓库根：页面在 <root>/out/renderer/index.html */
  const root = decodeURIComponent(location.pathname).replace(/\/out\/renderer\/index\.html$/, '').replace(/^\//, '')
  const pngPath = root + '/build/icon.png'
  const now = Date.now()

  store.getState().applyPush({
    ch: 'sync',
    payload: [
      { id: 'icon-l3-u1', role: 'user', text: '把生成好的图和进度都摆出来，检查浅色下的可读性。' },
      {
        id: 'icon-l3-a1',
        role: 'assistant',
        text: '产物卡片与进度条都在下面。',
        artifacts: [
          {
            id: 'icon-l3-artifact',
            sourceId: 'icon-l3-artifact',
            filename: 'yan-icon.png',
            path: pngPath,
            mediaType: 'image/png',
            kind: 'image',
            bytes: 40960,
            createdAt: now,
            previewable: true,
            provider: 'codex',
            model: 'gpt-image-2',
            description: '浅色下的 AI 产物卡片（检查标题、元信息、按钮的对比度）'
          }
        ],
        imageProgress: [
          {
            id: 'icon-l3-progress',
            stage: 'generating',
            startedAt: now - 24000,
            updatedAt: now,
            provider: 'codex',
            model: 'gpt-image-2',
            detail: '正在生成图片'
          }
        ]
      }
    ]
  })
  await sleep(1400)

  /* 让卡片进入视口，并悬停到下载按钮上（hover 态也在截图里） */
  const card = q('[data-testid="turn-artifacts"]')
  if (card) card.scrollIntoView({ block: 'center' })
  await sleep(400)
  const hover = q('.artifact-download') || q('.artifact-actions button')
  if (hover) hover.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await sleep(300)

  document.documentElement.dataset.theme = 'light'
  await sleep(600)
  return card ? 'ok' : 'no-artifact-card'
})()
